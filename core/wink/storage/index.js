// @ts-check
// wink storage: storage devices for Wink (team/0.3/DESIGN-wink.md sections 3, 4 and 6; DESIGN-space-storage.md).
//
// A storage device is a drive somewhere (a network drive found from a device on the same network, a disk plugged in, a cloud volume, or an
// S3-compatible bucket). Paired, it is a device of kind storage under its owner (a person, or a space that person administers) and it exposes
// one `storage` offer: how much room, how much is used, which classes of data may live there (cold and backup by default), when it ends and a
// note on where it sits. Everything stored there is ciphertext by contract: the space encrypts before anything leaves.
//
// What this module is, and is not:
//   - It finds drives (discover), pairs them (pick, pair), checks they are still there (status, a slow timer) and takes them back (remove).
//   - Access details for a bucket go into the VAULT and nowhere else: the row holds a vault reference, never a value, and no event, log, card
//     or tool result carries one. The only way back to a value is getCredentials(ref, { by }), which the pool engine calls and which needs
//     the owner (or an admin of the owning space).
//   - It does not place data. Where chunks live, copy counts, draining and healing are the vault team's pool engine. remove({ drain: true })
//     only records the intent and keeps the grant until the engine calls completeDrain(id).
//
// The seam for the pool engine (also in docs/work/tailnet.md, "Wink storage"):
//   const s = createStorageDevices({ ctx, grants, vault, scanners, s3, admin });
//   s.poolOffers()                       -> every live offer, with credentialRef and everything else the engine needs (internal; never a tool)
//   await s.getCredentials(ref, { by })  -> { kind, location, accessKey, secretKey } for s3 and volume; { kind, location } for a drive; refuses unless `by` is the owner
//   s.setUsed(id, bytes)                 -> the engine reports what it has written
//   s.drainRequests()                    -> the devices a person asked to drain; await s.completeDrain(id) when they are empty
// Events: storage.paired, storage.removed ({ final: false } when a drain starts, { final: true } when the device is gone), storage.unreachable.

import crypto from "node:crypto";
import net from "node:net";
import fs from "node:fs";
import { timeId, base32 } from "../grants.js";
import { storageCard, removeWords, size } from "./cards.js";
import { createDiscovery, realScanners } from "./discover.js";
import { createS3, checkEndpoint } from "./s3.js";
import { GRANT_MIGRATIONS } from "./grants.js";

export const MIGRATIONS = [
  `CREATE TABLE wink_storage_devices (id TEXT PRIMARY KEY, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
     loc TEXT NOT NULL, vault_ref TEXT, capacity INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, classes TEXT NOT NULL, schedule TEXT, expires INTEGER,
     residency TEXT NOT NULL DEFAULT '', state TEXT NOT NULL, reason TEXT, last_probe INTEGER, last_ok INTEGER, drain INTEGER NOT NULL DEFAULT 0,
     grant_id TEXT, seen_from TEXT, created INTEGER NOT NULL, removed INTEGER)`,
  `CREATE INDEX wink_storage_devices_owner ON wink_storage_devices (owner_kind, owner_id, removed)`,
  ...GRANT_MIGRATIONS,
];

const CLASSES = ["cold", "backup", "working"];
const KINDS_CREDENTIALS = ["s3", "volume"];
const SLOWEST_PROBE_MS = 5 * 60_000;
const MIN_PROBE_GAP_MS = 60_000;
const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const sha = (/** @type {string} */ s) => crypto.createHash("sha256").update(s).digest();

/** The default reachability checks: a TCP connection for a network drive, the folder for a disk. */
export const realReach = {
  /** @param {string} host @param {number} port */
  tcp: (host, port) => new Promise(res => {
    const s = net.connect({ host, port, timeout: 3000 });
    s.once("connect", () => { s.destroy(); res(true); });
    s.once("timeout", () => { s.destroy(); res(false); });
    s.once("error", () => res(false));
  }),
  /** @param {string} p */
  path: p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
};

/**
 * @typedef {{ kind: "person" | "space", id: string }} Owner
 * @typedef {{ self(): Promise<any>, isAdmin(person: string, space: string): Promise<boolean>, nameOf(owner: Owner): Promise<string> | string }} AdminPort
 * @typedef {{ put(o: { name: string, fields: Record<string, string>, description: string }): Promise<void>, fetch(name: string, field?: string): Promise<string>, remove(name: string): Promise<void> }} VaultPort
 */

/**
 * @param {{ ctx: any, grants: { create(i: any, issuer: any): Promise<any>, revoke(id: string, why: string): Promise<any>, get?(id: string): Promise<any> }, vault: VaultPort,
 *   scanners?: any[], s3?: { probe(c: any): Promise<any> }, admin: AdminPort, space: () => string | Promise<string>, reach?: typeof realReach,
 *   now?: () => number, from?: () => string, fromDevice?: () => string | undefined, probeEveryMs?: number,
 *   remoteCandidates?: () => Promise<{ found: any[], notes?: string[] }>, viaReach?: (device: string) => Promise<boolean> | boolean }} o
 */
export function createStorageDevices({ ctx, grants, vault, scanners, s3 = createS3(), admin, space, reach = realReach, now = Date.now, from = () => String((ctx.config && ctx.config.name) || "this device"), fromDevice = () => undefined, remoteCandidates, viaReach, probeEveryMs = SLOWEST_PROBE_MS }) {
  const db = ctx.store.db;
  const discovery = createDiscovery({ scanners: scanners || realScanners(), from, fromDevice, ...(remoteCandidates ? { extra: remoteCandidates } : {}), now });
  const log = (/** @type {string} */ m) => { try { ctx.log(m); } catch { /* no log */ } };
  const ownerKey = (/** @type {Owner} */ o) => `${o.kind}:${o.id}`;

  // ---- owners: a person's own identity, or a space that person administers ----
  /** @param {any} input */
  async function resolveOwner(input) {
    const self = await admin.self();
    if (input === undefined || input === null || input === "" || input === "me" || input === "self" || (typeof input === "object" && input.kind === "person" && (!input.id || input.id === self.id)))
      return { owner: /** @type {Owner} */ ({ kind: "person", id: self.id }), self };
    if (typeof input === "object" && input.kind === "person") throw fail("denied", "Storage can be added to yourself or to a space you run, not to another person.");
    const id = typeof input === "string" ? input.replace(/^space:/, "") : String(input.id || input.space || "");
    if (!/^spc_[a-z2-7]{12}$/.test(id)) throw fail("bad_input", "Name the space like space:spc_abcdefghijkl, or leave the owner out to add storage to yourself.");
    if (!(await admin.isAdmin(self.id, id))) throw fail("denied", "You are not an admin of that space, so you cannot add storage to it.");
    return { owner: /** @type {Owner} */ ({ kind: "space", id }), self };
  }

  /** @param {any} input */
  function terms(input) {
    const classes = input.classes === undefined ? ["cold", "backup"] : input.classes;
    if (!Array.isArray(classes) || !classes.length || classes.some((/** @type {any} */ c) => !CLASSES.includes(c))) throw fail("bad_input", "Classes can be cold, backup and working. Cold and backup are the default.");
    const expires = input.expires === undefined || input.expires === null ? null : Number(input.expires);
    if (expires !== null && (!Number.isFinite(expires) || expires <= now())) throw fail("bad_input", "The end date has to be in the future.");
    const schedule = input.schedule === undefined ? null : String(input.schedule).slice(0, 80);
    const residency = String(input.residency || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120);
    return { classes: [...new Set(classes)], expires, schedule, residency };
  }
  const capacityOf = (/** @type {any} */ declared, /** @type {number | undefined} */ known) => {
    const c = declared === undefined || declared === null ? known : Number(declared);
    if (!Number.isFinite(c) || !c || c <= 0) throw fail("bad_input", "Say how much room Vyre may use here, for example 1.5 TB (1500000000000 bytes).");
    if (known && c > known) throw fail("bad_input", `That drive has about ${size(known)}, so Vyre cannot be offered ${size(c)}.`);
    return Math.floor(c);
  };

  // ---- rows and what leaves this module ----
  const readRow = (/** @type {string} */ id) => /** @type {any} */ (db.prepare("SELECT * FROM wink_storage_devices WHERE id = ?").get(String(id))) || null;
  const liveRows = () => /** @type {any[]} */ (db.prepare("SELECT * FROM wink_storage_devices WHERE removed IS NULL ORDER BY created, id").all());
  /** The id of the device that serves a bridged drive, kept in the location beside the label `seen_from`. @param {any} r */
  const viaOf = r => { try { const v = JSON.parse(r.loc).via; return typeof v === "string" ? v : undefined; } catch { return undefined; } };
  /** The offer, without anything a tool result must not carry. @param {any} r */
  const offerOf = r => ({
    id: r.id, name: r.name, kind: r.kind, owner: { kind: r.owner_kind, id: r.owner_id },
    storage: { capacity: r.capacity, used: r.used, class: JSON.parse(r.classes), ...(r.schedule ? { schedule: r.schedule } : {}), ...(r.expires ? { expires: r.expires } : {}), residency: r.residency || "not stated" },
    ciphertextOnly: true,
    state: r.drain ? "draining" : r.expires && r.expires <= now() ? "expired" : r.state,
    ...(r.reason ? { reason: r.reason } : {}), ...(r.seen_from ? { seenFrom: r.seen_from } : {}), ...(viaOf(r) ? { seenFromDevice: viaOf(r) } : {}),
    lastChecked: r.last_probe || null, lastReachable: r.last_ok || null, drain: Boolean(r.drain),
  });
  const eventBody = (/** @type {any} */ r) => ({ id: r.id, kind: r.kind, name: r.name, owner: { kind: r.owner_kind, id: r.owner_id } });

  /** Save a device with its grant; undo everything if any step fails. @param {any} d */
  async function save(d) {
    const { owner, self } = d;
    const id = timeId("sto_", now());
    const sp = owner.kind === "space" ? owner.id : String(await space());
    const devId = `dev_${base32(sha(`storage\n${id}`), 26)}`;
    /** @type {string | null} */ let ref = null;
    if (d.secrets) {
      ref = `vault://wink-storage-${id}`;
      await vault.put({ name: `wink-storage-${id}`, fields: d.secrets, description: `Access details for the storage ${String(d.name).slice(0, 40)} (made by Vyre)` });
    }
    let grant;
    try {
      grant = await grants.create({
        subject: { kind: "actor", actor: { kind: "device", id: devId, space: sp } }, actions: ["storage.hold"], resource: { prefix: `vyre://${sp}/storage/${id}/` },
        conditions: d.expires ? { when: { expires: d.expires } } : {}, source: "wink:W3", reason: `${String(d.name).slice(0, 48)}, storage`,
      }, { ...self, space: sp });
      db.prepare(`INSERT INTO wink_storage_devices (id, owner_kind, owner_id, kind, name, loc, vault_ref, capacity, used, classes, schedule, expires, residency, state, last_probe, last_ok, grant_id, seen_from, created)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'online', ?, ?, ?, ?, ?)`)
        .run(id, owner.kind, owner.id, d.kind, String(d.name).slice(0, 80), JSON.stringify(d.loc), ref, d.capacity, JSON.stringify(d.classes), d.schedule, d.expires, d.residency, now(), now(), grant.id, d.seenFrom || null, now());
    } catch (err) {
      if (grant) await grants.revoke(grant.id, "storage was not saved").catch(() => {});
      if (ref) await vault.remove(`wink-storage-${id}`).catch(() => {});
      throw err;
    }
    const row = readRow(id);
    ctx.events.emit("storage.paired", eventBody(row));
    return row;
  }
  const ownerLabel = async (/** @type {Owner} */ o) => String(await admin.nameOf(o));

  const api = {
    /** Look for drives from this device. Scans run on demand, at most once a minute; a second ask inside the minute gets the last answer. */
    async discover() {
      const r = await discovery.discover();
      return { ...r, candidates: r.candidates.map((/** @type {any} */ c) => ({ ...c, label: `${c.name}${c.size ? ` (${size(c.size)})` : ""}, seen from ${c.seenFrom}` })) };
    },

    /** The card for a candidate from the last scan, or for access details (without the secret). @param {any} input */
    async card(input) {
      const { owner } = await resolveOwner(input.owner);
      const t = terms({ ...input, expires: input.expires });
      if (input.candidate) {
        const c = discovery.candidate(String(input.candidate));
        if (!c) throw fail("not_found", "That drive was not in the last search. Search again.");
        return storageCard({ how: "discovery", name: c.name, owner: await ownerLabel(owner), capacity: capacityOf(input.capacity, c.size), seenFrom: c.seenFrom, classes: t.classes, residency: t.residency });
      }
      return storageCard({ how: "credentials", name: String(input.name || input.bucket || "this storage"), owner: await ownerLabel(owner), capacity: capacityOf(input.capacity), classes: t.classes, residency: t.residency });
    },

    /** Pair a drive found by discover. A network drive that needs a login passes username and password, which go to the vault. @param {any} input */
    async pick(input) {
      const c = discovery.candidate(String(input.candidate || ""));
      if (!c) throw fail("not_found", "That drive was not in the last search. Search again, then pick it.");
      const { owner, self } = await resolveOwner(input.owner);
      const t = terms(input);
      const capacity = capacityOf(input.capacity, c.size);
      const up = await api.reachable({ kind: c.kind, loc: { host: c.host, share: c.share, path: c.path, ...(c.seenFromDevice ? { via: c.seenFromDevice } : {}) } });
      if (!up.ok) throw fail("unreachable", up.reason);
      /** @type {Record<string, string> | undefined} */
      const secrets = input.username || input.password ? { username: String(input.username || ""), password: String(input.password || "") } : undefined;
      const row = await save({ owner, self, kind: c.kind, name: input.name ? String(input.name) : c.name, loc: { host: c.host, share: c.share, path: c.path, ...(c.seenFromDevice ? { via: c.seenFromDevice } : {}) }, capacity, ...t, secrets, seenFrom: c.seenFrom });
      return { device: offerOf(row), card: storageCard({ how: "discovery", name: row.name, owner: await ownerLabel(owner), capacity, seenFrom: c.seenFrom, classes: t.classes, residency: t.residency }) };
    },

    /**
     * Pair a cloud volume or an S3-compatible bucket by its access details. The details are tried first; a login that does not work is never saved.
     * @param {any} input
     */
    async pair(input) {
      if (!KINDS_CREDENTIALS.includes(input.kind)) throw fail("bad_input", "Kind is s3 (a bucket) or volume (a cloud volume with an S3 door).");
      for (const k of ["endpoint", "bucket", "accessKey", "secretKey"]) if (!input[k] || typeof input[k] !== "string") throw fail("bad_input", `${k === "endpoint" ? "The address" : k === "bucket" ? "The bucket name" : k === "accessKey" ? "The access ID" : "The secret"} is missing.`);
      const { owner, self } = await resolveOwner(input.owner);
      const t = terms(input);
      const capacity = capacityOf(input.capacity);
      const cfg = { endpoint: input.endpoint, bucket: input.bucket, region: String(input.region || "us-east-1"), accessKey: input.accessKey, secretKey: input.secretKey };
      const p = await s3.probe(cfg);
      if (!p.ok) throw fail("probe_failed", p.reason);
      const name = String(input.name || `${input.bucket} on ${new URL(input.endpoint).hostname}`);
      const row = await save({ owner, self, kind: input.kind, name, loc: { endpoint: new URL(input.endpoint).origin + new URL(input.endpoint).pathname.replace(/\/+$/, ""), bucket: input.bucket, region: cfg.region },
        capacity, ...t, secrets: { accessKey: input.accessKey, secretKey: input.secretKey } });
      return { device: offerOf(row), card: storageCard({ how: "credentials", name, owner: await ownerLabel(owner), capacity, classes: t.classes, residency: t.residency }) };
    },

    /** Is this thing there right now? @param {{ kind: string, loc: any, vaultRef?: string | null }} d @returns {Promise<{ ok: boolean, reason?: string }>} */
    async reachable(d) {
      // A drive only another device can reach is as reachable as that device's connection to this home: this home cannot dial it, so nothing here tries to.
      if (d.loc && typeof d.loc.via === "string" && viaReach) return (await viaReach(d.loc.via)) ? { ok: true } : { ok: false, reason: "The device that has this drive is not connected right now." };
      if (d.kind === "s3" || d.kind === "volume") {
        let accessKey, secretKey;
        try { const name = String(d.vaultRef || "").replace(/^vault:\/\//, ""); accessKey = await vault.fetch(name, "accessKey"); secretKey = await vault.fetch(name, "secretKey"); }
        catch { return { ok: false, reason: "The saved access details could not be read from the vault." }; }
        const r = await s3.probe({ endpoint: d.loc.endpoint, bucket: d.loc.bucket, region: d.loc.region, accessKey, secretKey });
        return r.ok ? { ok: true } : { ok: false, reason: r.reason };
      }
      if (d.kind === "usb-disk") return reach.path(d.loc.path) ? { ok: true } : { ok: false, reason: "The disk is not plugged in or not mounted on that device." };
      if (d.kind === "smb" || d.kind === "nfs" || d.kind === "afp") {
        const port = d.kind === "smb" ? 445 : d.kind === "nfs" ? 2049 : 548;
        return (await reach.tcp(String(d.loc.host), port)) ? { ok: true } : { ok: false, reason: `${d.loc.host} did not answer. It may be off, asleep or on another network.` };
      }
      return { ok: true };
    },

    /** The offers, for a person (no references). @param {{ owner?: any }} [f] */
    offers(f = {}) {
      return liveRows().filter(r => !f.owner || ownerKey({ kind: r.owner_kind, id: r.owner_id }) === ownerKey(f.owner)).map(offerOf);
    },
    /** For the pool engine: the same, with the reference to the access details. Never exposed as a tool. */
    poolOffers() { return liveRows().map(r => ({ ...offerOf(r), credentialRef: r.vault_ref, location: JSON.parse(r.loc) })); },

    /**
     * Access details by reference, for the pool engine. `by` is the actor the engine acts for: the owner, or an admin of the owning space.
     * @param {string} ref @param {{ by: { kind: string, id: string } }} o
     */
    async getCredentials(ref, o) {
      const r = /** @type {any} */ (db.prepare("SELECT * FROM wink_storage_devices WHERE vault_ref = ? AND removed IS NULL").get(String(ref)));
      if (!r) throw fail("not_found", "No storage uses that reference.");
      const self = await admin.self();
      const by = o && o.by;
      const ok = by && by.kind === "person" && (r.owner_kind === "person" ? by.id === r.owner_id && by.id === self.id : await admin.isAdmin(by.id, r.owner_id));
      if (!ok) throw fail("denied", "Only the owner of this storage, or an admin of the space it belongs to, can use its access details.");
      if (grants.get && r.grant_id) { const g = await grants.get(r.grant_id); if (!g || g.status !== "active") throw fail("denied", "The grant for this storage was taken back."); }
      const name = String(ref).replace(/^vault:\/\//, "");
      const loc = JSON.parse(r.loc);
      if (r.kind === "s3" || r.kind === "volume") return { kind: r.kind, location: loc, accessKey: await vault.fetch(name, "accessKey"), secretKey: await vault.fetch(name, "secretKey") };
      return { kind: r.kind, location: loc };
    },

    /** The pool engine reports what it wrote. @param {string} id @param {number} bytes */
    setUsed(id, bytes) {
      const r = readRow(id);
      if (!r || r.removed) throw fail("not_found", "No such storage.");
      db.prepare("UPDATE wink_storage_devices SET used = ? WHERE id = ?").run(Math.max(0, Math.floor(Number(bytes) || 0)), id);
    },

    /**
     * Take a device back. With drain, only the intent is recorded: the device stays listed as draining and keeps its grant until the pool engine
     * has copied everything off and calls completeDrain. Without drain, the grant and the saved access details go at once.
     * @param {{ id: string, drain?: boolean }} i
     */
    async remove(i) {
      const r = readRow(i.id);
      if (!r || r.removed) throw fail("not_found", "No such storage.");
      if (i.drain) {
        if (!r.drain) { db.prepare("UPDATE wink_storage_devices SET drain = 1 WHERE id = ?").run(r.id); ctx.events.emit("storage.removed", { ...eventBody(r), drain: true, final: false }); }
        return { removed: false, draining: true, ...removeWords({ name: r.name, drain: true }), device: offerOf(readRow(r.id)) };
      }
      await finish(r, false);
      return { removed: true, draining: false, ...removeWords({ name: r.name, drain: false }) };
    },
    /** The pool engine says a draining device is empty. @param {string} id */
    async completeDrain(id) {
      const r = readRow(id);
      if (!r || r.removed) throw fail("not_found", "No such storage.");
      if (!r.drain) throw fail("bad_input", "That storage is not being drained.");
      await finish(r, true);
    },
    drainRequests() { return liveRows().filter(r => r.drain).map(offerOf); },

    /** State of one device or all, with a fresh look if the last one is more than a minute old (never faster). @param {{ id?: string, refresh?: boolean }} [i] */
    async status(i = {}) {
      const rows = i.id ? [readRow(i.id)].filter(r => r && !r.removed) : liveRows();
      if (i.id && !rows.length) throw fail("not_found", "No such storage.");
      if (i.refresh !== false) for (const r of rows) await check(r, false);
      return { devices: rows.map(r => offerOf(readRow(r.id))) };
    },

    /** One pass of the slow check. Announces a device only when it goes from reachable to not. */
    async probeAll() { for (const r of liveRows()) await check(r, true); },
  };

  /** @param {any} r @param {boolean} force */
  async function check(r, force) {
    if (!force && r.last_probe && now() - r.last_probe < MIN_PROBE_GAP_MS) return;
    const res = await api.reachable({ kind: r.kind, loc: JSON.parse(r.loc), vaultRef: r.vault_ref }).catch(err => ({ ok: false, reason: String(/** @type {Error} */ (err).message).slice(0, 160) }));
    const t = now();
    if (res.ok) db.prepare("UPDATE wink_storage_devices SET state = 'online', reason = NULL, last_probe = ?, last_ok = ? WHERE id = ?").run(t, t, r.id);
    else {
      db.prepare("UPDATE wink_storage_devices SET state = 'unreachable', reason = ?, last_probe = ? WHERE id = ?").run(res.reason || "Not reachable.", t, r.id);
      if (r.state !== "unreachable") ctx.events.emit("storage.unreachable", { ...eventBody(r), reason: res.reason || "Not reachable." });
    }
  }

  /** @param {any} r @param {boolean} fromDrain */
  async function finish(r, fromDrain) {
    if (r.grant_id) await grants.revoke(r.grant_id, fromDrain ? "storage drained and removed" : "storage removed by the owner").catch(err => log(`wink storage: grant revoke failed: ${/** @type {Error} */ (err).message}`));
    if (r.vault_ref) await vault.remove(String(r.vault_ref).replace(/^vault:\/\//, "")).catch(err => log(`wink storage: vault item removal failed: ${/** @type {Error} */ (err).message}`));
    db.prepare("UPDATE wink_storage_devices SET removed = ?, state = 'removed' WHERE id = ?").run(now(), r.id);
    ctx.events.emit("storage.removed", { ...eventBody(r), drain: Boolean(fromDrain), final: true });
  }

  /** Start the slow check (every 5 minutes at the slowest, never under 60 seconds). */
  function startTimer() {
    const t = setInterval(() => { api.probeAll().catch(err => log(`wink storage: check failed: ${/** @type {Error} */ (err).message}`)); }, Math.max(probeEveryMs, MIN_PROBE_GAP_MS));
    t.unref();
    return () => clearInterval(t);
  }
  return { ...api, startTimer, discovery };
}

/** The owner's own surfaces only: never an agent, a guest, a hook or an anonymous caller. @param {any} meta @param {string} what */
export function ownerOnly(meta, what) {
  const c = String((meta && meta.caller) || "");
  if (!c || (meta && meta.agent) || /^(anonymous|hook)$/.test(c) || c.startsWith("agent:") || c.startsWith("space:") || c.startsWith("org:"))
    throw fail("denied", `${what} is the owner's`);
}

const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });
const str = { type: "string" };
const num = { type: "number" };
const OWNER = { description: "Who the storage belongs to: leave out for yourself, or space:<id> for a space you administer.", type: ["string", "object"] };
const TERMS = { capacity: { ...num, description: "Bytes Vyre may use here (needed unless the drive reports its size)." }, classes: { type: "array", items: { type: "string", enum: CLASSES } }, schedule: str, expires: { ...num, description: "When the offer ends, in milliseconds since 1970." }, residency: { ...str, description: "Where it sits, in a few words (for example: US only, office)." } };

/**
 * Register the tools. `prefix` is "wink.storage" for the names in the Wink design; a module whose own name is the prefix passes its name.
 * @param {any} ctx @param {ReturnType<typeof createStorageDevices>} s @param {string} [prefix]
 */
export function registerStorageTools(ctx, s, prefix = "wink.storage") {
  /** @param {string} name @param {any} def */
  const tool = (name, def) => ctx.tool(`${prefix}.${name}`, { ...def, run: async (/** @type {any} */ input, /** @type {any} */ meta = {}) => { ownerOnly(meta, `storage ${name}`); return def.run(input || {}, meta); } });
  tool("discover", {
    description: "Look for drives this device can see: file servers that announce themselves, shared folders, exported folders and disks plugged in. Runs when asked, at most once a minute (a second ask gets the last answer). Answers { candidates: [{ id, name, kind, size?, seenFrom, label }], notes, cached }. Notes say plainly why something could not be looked for.",
    input: obj(), run: () => s.discover(),
  });
  tool("pick", {
    description: "Add a drive found by discover as storage for you or a space you administer. Answers { device, card }. A drive that needs a login takes username and password, which go to the vault only.",
    input: obj({ candidate: str, owner: OWNER, name: str, username: str, password: str, ...TERMS }, ["candidate"]),
    presence: { summary: async (/** @type {any} */ i) => { try { return (await s.card(i)).allows; } catch { return "Add a drive as storage"; } } },
    run: (/** @type {any} */ i) => s.pick(i),
  });
  tool("pair", {
    description: "Add a cloud volume or an S3-compatible bucket as storage. The access details are tried first, then saved in the vault and nowhere else; the answer never repeats them. Answers { device, card }, or says plainly why the login did not work.",
    input: obj({ kind: { type: "string", enum: KINDS_CREDENTIALS }, endpoint: str, bucket: str, region: str, accessKey: str, secretKey: str, owner: OWNER, name: str, ...TERMS }, ["kind", "endpoint", "bucket", "accessKey", "secretKey"]),
    presence: { summary: async (/** @type {any} */ i) => { try { return (await s.card(i)).allows; } catch { return "Add a bucket as storage"; } } },
    run: (/** @type {any} */ i) => s.pair(i),
  });
  tool("card", {
    description: "The words a person reads before adding storage: pass a candidate from discover, or the bucket details without the secret. Answers { card }.",
    input: obj({ candidate: str, name: str, bucket: str, owner: OWNER, ...TERMS }),
    run: async (/** @type {any} */ i) => ({ card: await s.card(i) }),
  });
  tool("offers", {
    description: "The storage offers: each paired drive with its room, what is used, the classes of data allowed, when it ends and where it sits. Everything stored is encrypted. Answers { offers }.",
    input: obj({ owner: OWNER }), run: async (/** @type {any} */ i) => ({ offers: s.offers(i.owner ? { owner: i.owner } : {}) }),
  });
  tool("status", {
    description: "Is each storage device there? Looks again if the last look is over a minute old. Answers { devices }.",
    input: obj({ id: str, refresh: { type: "boolean" } }), run: (/** @type {any} */ i) => s.status(i),
  });
  tool("remove", {
    description: "Take a storage device back. With drain, Vyre records that everything must be copied off first and keeps the device listed until it is empty; without it the device and its saved login go now. Answers { removed, draining, prompt }.",
    input: obj({ id: str, drain: { type: "boolean" } }, ["id"]),
    presence: { summary: async (/** @type {any} */ i) => (i && i.drain ? "Copy everything off a storage device and remove it" : "Remove a storage device now") },
    run: (/** @type {any} */ i) => s.remove(i),
  });
}
