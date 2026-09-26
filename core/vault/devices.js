// @ts-check
// devices: one person's vault on more than one device (ADR 0006, decision 5, multi-device).
//
// A new device shows a join code: its keys, the role it asks for, a nonce, signed by its own
// key, and its fingerprint so the person can compare the two screens. An existing device
// approves it with presence and answers with the account keyset sealed to the new device's box
// key. What is in the keyset depends on the role:
//   - full (a person's other Mac): the agent vault key, the account record (the personal VK,
//     still wrapped under the password and Secret Key) and the Secret Key. The password never
//     travels: the person types it on the new device to unlock.
//   - storage (a box): the agent vault key only. It holds personal items as ciphertext it cannot
//     open, and is a key holder for agent vaults, so agents run there while the Mac sleeps.
//
// The approving device is the group's home. Items move between devices over POST /v1/sync on
// the relay listener, in envelopes signed by a device key the home lists. The home keeps a log
// of item records (the row and its sealed file, signed by the device that wrote it); a device
// pushes what changed locally since it last synced and pulls what changed elsewhere. The newer
// item version wins; a push the home has already moved past is kept as a conflict revision and
// vault.sync-conflicted says so. After taking a push the home pokes the other devices, which
// then pull; a device also pulls on start, after each local write, and every ten minutes at most.
//
// Shared vaults are not part of this: a person's devices join those one by one.

import crypto from "node:crypto";
import { canonical, sign, verify, sealFor, openFrom } from "./crypto.js";
import { writeSealed, readSealed, removeSealed } from "./store.js";
import { fingerprint } from "./share.js";
import * as relay from "./relay.js";

export const DEVICE_MIGRATIONS = [
  `CREATE TABLE vault_group (
     id TEXT PRIMARY KEY, home TEXT NOT NULL, home_sign TEXT NOT NULL, role TEXT NOT NULL,
     since INTEGER NOT NULL DEFAULT 0, joined INTEGER NOT NULL
   );
   CREATE TABLE vault_group_devices (
     sign TEXT PRIMARY KEY, box TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, relay TEXT, added INTEGER NOT NULL
   );
   CREATE TABLE vault_group_log (rev INTEGER PRIMARY KEY, id TEXT NOT NULL, ver INTEGER NOT NULL, body TEXT NOT NULL);
   CREATE INDEX vault_group_log_id ON vault_group_log (id, rev);
   CREATE TABLE vault_group_seen (id TEXT PRIMARY KEY, ver INTEGER NOT NULL, vault TEXT NOT NULL);
   CREATE TABLE vault_group_joining (nonce TEXT PRIMARY KEY, role TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE TABLE vault_group_conflicts (id INTEGER PRIMARY KEY, item TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL);`,
];

const JOIN_PREFIX = "vyre-join:v1:", APPROVAL_PREFIX = "vyre-device:v1:";
const JOIN_TAG = "vyre-join-v1", APPROVAL_TAG = "vyre-device-v1", RECORD_TAG = "vyre-device-record-v1", ROSTER_TAG = "vyre-roster-v1";
const ROLES = ["full", "storage"];
/** Only these classes travel between a person's devices; shared vaults sync on their own. */
const SYNCED = ["agents", "personal"];
const ROW = ["kind", "description", "fields", "url", "hosts", "origin", "rotate", "apps", "reprompt", "relay", "created", "updated"];
const TEN_MINUTES = 10 * 60_000;
const JOIN_TTL = 15 * 60_000;

const now = () => Date.now();
const without = (o, k) => { const c = { ...o }; delete c[k]; return c; };
const b64u = s => Buffer.from(s).toString("base64url");
const signed = (tag, body, priv) => ({ ...body, sig: sign(priv, { tag, ...body }) });
const signedOk = (tag, o, pub) => o && typeof o.sig === "string" && verify(pub, { tag, ...without(o, "sig") }, o.sig);
const err = (message, code) => Object.assign(new Error(message), code ? { code } : {});

function unwrap(str, prefix, what) {
  const s = String(str || "").trim();
  if (!s.startsWith(prefix)) throw new Error(`not a ${what}: it should start with "${prefix}"`);
  try { return JSON.parse(Buffer.from(s.slice(prefix.length), "base64url").toString("utf8")); } catch { throw new Error(`this ${what} is damaged`); }
}

/** Read a join code: signed by the key it carries. */
export function decodeJoin(code) {
  const j = unwrap(code, JOIN_PREFIX, "join code");
  for (const k of ["name", "sign", "box", "nonce", "role"]) if (typeof j[k] !== "string") throw new Error(`this join code is missing "${k}"`);
  if (!ROLES.includes(j.role)) throw new Error("a join code asks for a full or a storage device");
  if (!signedOk(JOIN_TAG, j, j.sign)) throw new Error("this join code's signature does not match its key");
  if (typeof j.at !== "number" || now() - j.at > JOIN_TTL) throw new Error("this join code is older than 15 minutes · make a new one");
  return { ...j, fingerprint: fingerprint(j) };
}

export class Devices {
  /** @param {import("./vault.js").Vault} vault */
  constructor(vault) {
    this.vault = vault;
    this.db = vault.db;
    /** How a device reaches another. Tests swap it for a direct call. */
    this.post = (url, env) => relay.callRelay(url, env, { route: "/v1/sync" });
    /** @type {Promise<any> | null} */ this.running = null;
    this.again = false;
    /** @type {NodeJS.Timeout | null} */ this.timer = null;
  }

  group() { return /** @type {any} */ (this.db.prepare("SELECT * FROM vault_group LIMIT 1").get()); }

  async me() {
    const id = await this.vault.identity();
    return { id, sign: id.sign.public, box: id.box.public };
  }

  // ---- joining ---------------------------------------------------------------------------------

  /**
   * On the new device. Without `approval`: make a join code (and say which fingerprint the other
   * screen should show). With it: open the keyset and become part of the group.
   * @param {{ role?: string, approval?: string }} input
   */
  async join({ role = "full", approval } = {}, caller = "cli") {
    if (approval) return this.finish(approval, caller);
    if (!ROLES.includes(role)) throw new Error("role is full or storage");
    if (this.group()) throw new Error("this device already belongs to a group");
    const me = await this.me();
    const nonce = crypto.randomBytes(16).toString("base64url");
    this.db.prepare("INSERT INTO vault_group_joining (nonce, role, at) VALUES (?,?,?)").run(nonce, role, now());
    const body = { v: 1, name: this.vault.name, sign: me.sign, box: me.box, relay: this.vault.relayUrl || "", role, nonce, at: now() };
    return { code: JOIN_PREFIX + b64u(canonical(signed(JOIN_TAG, body, me.id.sign.private))), fingerprint: fingerprint(me), role,
      next: "on a device that already has your vault: vyre vault device approve <code>, then here: vyre vault device join --approval <answer>" };
  }

  /**
   * On a device that has the vault: let a new one in. The keyset is sealed to the joining
   * device's box key; this device becomes the group's home if there is no group yet.
   * @param {{ code: string }} input
   */
  async approve({ code }, caller = "cli") {
    const j = decodeJoin(code);
    if (!this.vault.relayUrl) throw new Error("this device has no relay address, so the new device could not sync with it · set vault.relay in config.json");
    const me = await this.me();
    if (j.sign === me.sign) throw new Error("that is this device's own join code");
    let g = this.group();
    if (g && g.role !== "home") throw new Error("approve new devices on the group's home device");
    if (!g) {
      const gid = crypto.randomBytes(9).toString("base64url");
      this.db.prepare("INSERT INTO vault_group (id, home, home_sign, role, since, joined) VALUES (?,?,?,?,0,?)").run(gid, this.vault.relayUrl, me.sign, "home", now());
      this.db.prepare("INSERT INTO vault_group_devices (sign, box, name, role, relay, added) VALUES (?,?,?,?,?,?)").run(me.sign, me.box, this.vault.name, "home", this.vault.relayUrl, now());
      g = this.group();
    }
    if (j.role === "full" && !this.vault.hasAccount()) throw new Error("a full device needs an account to share · vyre vault account create first, or join it as storage");
    const raw = await this.vault.agentKeyBytes();
    /** @type {any} */
    const keyset = { v: 1, group: g.id, agentKey: raw.toString("base64") };
    raw.fill(0);
    if (j.role === "full") {
      keyset.secretKey = await this.vault.secretKey();
      keyset.account = this.vault.accountRecord();
    }
    const sealed = sealFor(j.box, keyset, `vyre:device:v1:${g.id}:${j.nonce}`, "device");
    keyset.agentKey = ""; keyset.secretKey = "";
    this.db.prepare("INSERT OR REPLACE INTO vault_group_devices (sign, box, name, role, relay, added) VALUES (?,?,?,?,?,?)").run(j.sign, j.box, j.name, j.role, j.relay || null, now());
    await this.pushLocal(me);
    const body = { v: 1, group: g.id, home: this.vault.relayUrl, homeCard: (await this.vault.share.myCard()).card, nonce: j.nonce, sealed };
    this.vault.audit("device-approve", null, caller, true, `${j.name} (${j.fingerprint}) as ${j.role}`);
    this.vault.emit("vault.device-joined", { name: j.name, role: j.role, fingerprint: j.fingerprint });
    return { approval: APPROVAL_PREFIX + b64u(canonical(signed(APPROVAL_TAG, body, me.id.sign.private))), device: j.name, role: j.role, fingerprint: j.fingerprint };
  }

  async finish(approval, caller) {
    const a = unwrap(approval, APPROVAL_PREFIX, "device approval");
    const card = relay.decodeCard(a.homeCard);
    if (card.v !== 2 || !signedOk(APPROVAL_TAG, a, card.sign)) throw new Error("this approval's signature does not match the device that sent it");
    const pending = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_group_joining WHERE nonce = ?").get(String(a.nonce)));
    if (!pending || now() - pending.at > JOIN_TTL) throw new Error("this approval answers a join code this device did not make, or one older than 15 minutes");
    if (!relay.secureTarget(a.home)) throw new Error("the home device is not reachable over https (or loopback)");
    const me = await this.me();
    let keyset;
    try { keyset = openFrom(me.id.box.private, a.sealed, `vyre:device:v1:${a.group}:${a.nonce}`, "device"); }
    catch { throw new Error("this approval was not sealed for this device"); }
    await this.vault.replaceAgentKey(Buffer.from(keyset.agentKey, "base64"));
    if (pending.role === "full") await this.vault.adoptAccount({ secretKey: keyset.secretKey, account: keyset.account });
    keyset.agentKey = ""; keyset.secretKey = "";
    this.db.prepare("DELETE FROM vault_group_joining").run();
    this.db.prepare("INSERT INTO vault_group (id, home, home_sign, role, since, joined) VALUES (?,?,?,?,0,?)").run(a.group, a.home, card.sign, pending.role, now());
    this.vault.audit("device-join", null, caller, true, `joined ${card.name}'s group as ${pending.role}`);
    const pulled = await this.sync({}, caller);
    return { joined: true, role: pending.role, home: card.name, ...pulled };
  }

  /** The devices in this group, as the home knows them (a joined device sees its own view). */
  list() {
    const g = this.group();
    return {
      group: g ? { role: g.role, home: g.home } : null,
      devices: /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_group_devices ORDER BY added").all()).map(d => ({ name: d.name, role: d.role, fingerprint: fingerprint(d) })),
    };
  }

  // ---- records ------------------------------------------------------------------------------------

  /** A record for one local row: the row's details, its sealed file, signed by this device. */
  record(r, me) {
    const row = {};
    for (const k of ROW) row[k] = r[k] ?? null;
    return signed(RECORD_TAG, { v: 1, id: r.id, name: r.name, vault: r.vault, ver: Number(r.ver), row, sealed: readSealed(this.vault.dir, r.id), deleted: false, author: me.sign, at: now() }, me.id.sign.private);
  }

  tombstone(id, ver, vaultCls, me) {
    return signed(RECORD_TAG, { v: 1, id, name: "", vault: vaultCls, ver, row: null, sealed: null, deleted: true, author: me.sign, at: now() }, me.id.sign.private);
  }

  /** What changed here since the last sync: new or re-sealed rows, and rows that went. */
  changes(me) {
    const out = [];
    const seen = new Map(/** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_group_seen").all()).map(s => [s.id, s]));
    const rows = /** @type {any[]} */ (this.db.prepare(`SELECT * FROM vault_items WHERE vault IN (${SYNCED.map(() => "?").join(",")})`).all(...SYNCED));
    const here = new Set();
    for (const r of rows) {
      if (!this.vault.rowOk("vault_items", r)) continue;
      here.add(r.id);
      const s = seen.get(r.id);
      if (!s || s.ver !== Number(r.ver) || s.vault !== r.vault) out.push(this.record(r, me));
    }
    for (const [id, s] of seen) if (!here.has(id) && s.ver >= 0) out.push(this.tombstone(id, s.ver + 1, s.vault, me));
    return out;
  }

  markSeen(rec) {
    this.db.prepare("INSERT OR REPLACE INTO vault_group_seen (id, ver, vault) VALUES (?,?,?)").run(rec.id, rec.ver, rec.vault);
  }

  /** Take a record into this device's rows and files. */
  apply(rec) {
    const cur = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_items WHERE id = ?").get(rec.id));
    if (rec.deleted) {
      if (cur) { removeSealed(this.vault.dir, rec.id); this.db.prepare("DELETE FROM vault_items WHERE id = ?").run(rec.id); }
      this.markSeen(rec);
      return;
    }
    const clash = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_items WHERE name = ? AND id != ?").get(rec.name, rec.id));
    if (clash) this.keepConflict(clash, "another device saved an item with this name first");
    writeSealed(this.vault.dir, rec.id, rec.sealed);
    const r = rec.row;
    this.vault.tx(() => {
      this.db.prepare(`INSERT INTO vault_items (id, name, kind, description, fields, url, hosts, origin, rotate, created, updated, ver, vault, apps, reprompt, relay)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO UPDATE SET name=excluded.name, kind=excluded.kind, description=excluded.description,
        fields=excluded.fields, url=excluded.url, hosts=excluded.hosts, origin=excluded.origin, rotate=excluded.rotate, updated=excluded.updated,
        ver=excluded.ver, vault=excluded.vault, apps=excluded.apps, reprompt=excluded.reprompt, relay=excluded.relay`)
        .run(rec.id, rec.name, r.kind, r.description || "", r.fields || "[]", r.url, r.hosts || "[]", r.origin, r.rotate, r.created || now(), r.updated || now(),
          rec.ver, rec.vault, r.apps || "[]", r.reprompt ? 1 : 0, r.relay);
      this.vault.sign("vault_items", rec.id);
    });
    this.markSeen(rec);
  }

  /** A local version that lost: kept aside, sealed as it was, and said out loud (names only). */
  keepConflict(r, why) {
    this.db.prepare("INSERT INTO vault_group_conflicts (item, name, body, at) VALUES (?,?,?,?)").run(r.id, r.name, JSON.stringify({ row: r, sealed: readSealed(this.vault.dir, r.id) }), now());
    removeSealed(this.vault.dir, r.id);
    this.db.prepare("DELETE FROM vault_items WHERE id = ?").run(r.id);
    this.db.prepare("DELETE FROM vault_group_seen WHERE id = ?").run(r.id);
    this.vault.audit("sync-conflict", r.name, "vault", false, why);
    this.vault.emit("vault.sync-conflicted", { vault: "devices", name: r.name });
  }

  // ---- the home's side -------------------------------------------------------------------------

  latest(id) {
    const r = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_group_log WHERE id = ? ORDER BY rev DESC LIMIT 1").get(id));
    return r ? { rev: r.rev, ver: r.ver, rec: JSON.parse(r.body) } : null;
  }

  /** Append records the home accepts: signed by a listed device, and newer than what the log has. */
  accept(recs, from) {
    const taken = [], stale = [];
    for (const rec of recs) {
      if (!rec || rec.v !== 1 || rec.author !== from || !signedOk(RECORD_TAG, rec, from) || !SYNCED.includes(rec.vault) || !/^[A-Za-z0-9_-]{1,64}$/.test(String(rec.id))) { stale.push({ id: rec && rec.id, why: "refused" }); continue; }
      const last = this.latest(rec.id);
      if (last && last.ver >= rec.ver) { stale.push({ id: rec.id, why: "stale", ver: last.ver }); continue; }
      const info = this.db.prepare("INSERT INTO vault_group_log (id, ver, body) VALUES (?,?,?)").run(rec.id, rec.ver, JSON.stringify(rec));
      taken.push(Number(info.lastInsertRowid));
    }
    return { taken, stale };
  }

  /** The home's signed list of devices, so a device can check who wrote each record. */
  roster(me, g) {
    const devices = /** @type {any[]} */ (this.db.prepare("SELECT sign, role FROM vault_group_devices ORDER BY sign").all()).map(d => ({ sign: d.sign, role: d.role }));
    return signed(ROSTER_TAG, { group: g.id, devices, at: now() }, me.id.sign.private);
  }

  /** POST /v1/sync for `device:<group>`: the home answers pulls and pushes; any device takes a poke. */
  async onSync(env) {
    const deny = (status, code, message) => ({ status, body: { error: { code, message } } });
    let me;
    try { await this.vault.key(); me = await this.me(); } catch { return deny(503, "locked", "this vault is locked"); }
    const g = this.group();
    if (!g || env.vault !== `device:${g.id}`) { this.vault.share.auditUnknown(env && env.vault, null, "no such device group"); return deny(404, "not_found", "no such device group here"); }
    if (env.op === "poke") {
      if (env.from !== g.home_sign) return deny(403, "denied", "only the home pokes");
      const why = relay.checkSync(env, { audience: this.vault.relayUrl || "", seen: this.vault.share.nonces });
      if (why) return deny(403, "denied", why);
      this.soon();
      return { status: 200, body: { data: { ok: true } } };
    }
    if (g.role !== "home") return deny(404, "not_found", "this device is not the group's home");
    const dev = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_group_devices WHERE sign = ?").get(String(env.from)));
    if (!dev) { this.vault.share.auditUnknown(`device:${g.id}`, null, "not a device of this group"); return deny(403, "denied", "this device is not in the group"); }
    const why = relay.checkSync(env, { audience: this.vault.relayUrl || "", seen: this.vault.share.nonces });
    if (why) { this.vault.audit("device-sync", null, `device:${dev.name}`, false, why); return deny(403, "denied", why); }
    const body = env.body && typeof env.body === "object" ? env.body : {};
    if (env.op === "pull") {
      const since = Number(body.since) || 0;
      const records = /** @type {any[]} */ (this.db.prepare("SELECT rev, body FROM vault_group_log WHERE rev > ? ORDER BY rev").all(since)).map(r => ({ rev: r.rev, record: JSON.parse(r.body) }));
      return { status: 200, body: { data: { roster: this.roster(me, g), records } } };
    }
    if (env.op === "push") {
      const recs = Array.isArray(body.records) ? body.records.slice(0, 1000) : [];
      const out = this.accept(recs, dev.sign);
      if (out.taken.length) {
        // The home is a device too: take them here, then tell the others.
        await this.pullLocal(me);
        this.poke(me, g, dev.sign);
      }
      this.vault.audit("device-sync", null, `device:${dev.name}`, true, `${out.taken.length} taken, ${out.stale.length} not`);
      return { status: 200, body: { data: out } };
    }
    return deny(400, "bad_request", "unknown sync operation");
  }

  /** Tell every other device with a relay address that something changed. Fire and forget. */
  poke(me, g, except = null) {
    for (const d of /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_group_devices WHERE role != 'home' AND relay IS NOT NULL AND relay != ''").all())) {
      if (d.sign === except) continue;
      const env = relay.syncEnvelope({ vault: `device:${g.id}`, op: "poke", body: {}, from: me.sign, privDer: me.id.sign.private, aud: d.relay });
      Promise.resolve(this.post(d.relay, env)).catch(() => {});
    }
  }

  /** The home's own writes go straight into its log. */
  async pushLocal(me) {
    const recs = this.changes(me);
    if (!recs.length) return 0;
    const out = this.accept(recs, me.sign);
    for (const rec of recs) if (!out.stale.some(s => s.id === rec.id)) this.markSeen(rec);
    return out.taken.length;
  }

  /** The home takes log records written by other devices. */
  async pullLocal(me) {
    const g = this.group();
    const since = Number(g.since) || 0;
    let top = since;
    for (const r of /** @type {any[]} */ (this.db.prepare("SELECT rev, body FROM vault_group_log WHERE rev > ? ORDER BY rev").all(since))) {
      top = r.rev;
      const rec = JSON.parse(r.body);
      if (rec.author === me.sign) { this.markSeen(rec); continue; }
      this.takeRemote(rec);
    }
    this.db.prepare("UPDATE vault_group SET since = ? WHERE id = ?").run(top, g.id);
  }

  /** A remote record, unless this device has a newer unsynced version of the same item. */
  takeRemote(rec) {
    const cur = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_items WHERE id = ?").get(rec.id));
    const seen = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_group_seen WHERE id = ?").get(rec.id));
    if (cur && seen && (Number(cur.ver) !== seen.ver || cur.vault !== seen.vault) && !rec.deleted) {
      // Both changed it since the last sync: the version already in the log wins; ours is kept aside.
      this.keepConflict(cur, "another device changed this item at the same time");
    }
    this.apply(rec);
  }

  // ---- a device's side -----------------------------------------------------------------------------

  /** Push local changes and pull the rest. One at a time; a call during a run schedules one more. */
  async sync(_input = {}, caller = "vault") {
    if (this.running) { this.again = true; return this.running; }
    this.running = this.run(caller).finally(() => { this.running = null; });
    const out = await this.running;
    if (this.again) { this.again = false; this.soon(); }
    return out;
  }

  async run(caller) {
    const g = this.group();
    if (!g) return { synced: false };
    await this.vault.key();
    const me = await this.me();
    if (g.role === "home") {
      const n = await this.pushLocal(me);
      if (n) this.poke(me, g);
      return { synced: true, pushed: n };
    }
    const call = (op, body) => this.post(g.home, relay.syncEnvelope({ vault: `device:${g.id}`, op, body, from: me.sign, privDer: me.id.sign.private, aud: g.home }));
    // Pull first, so a push is judged against what the home already has.
    const pulled = await this.pull(g, call);
    const recs = this.changes(me);
    let pushed = 0;
    if (recs.length) {
      const r = await call("push", { records: recs });
      if (r.error) throw err(`the home device said: ${r.error.message}`, r.error.code);
      for (const rec of recs) {
        const s = r.data.stale.find(x => x.id === rec.id);
        if (!s) { this.markSeen(rec); pushed++; }
      }
      if (r.data.stale.length) await this.pull(this.group(), call);
    }
    return { synced: true, pulled, pushed };
  }

  async pull(g, call) {
    const r = await call("pull", { since: g.since });
    if (r.error) throw err(`the home device said: ${r.error.message}`, r.error.code);
    const roster = r.data.roster;
    if (!signedOk(ROSTER_TAG, roster, g.home_sign) || roster.group !== g.id) throw new Error("the home device's list of devices does not verify");
    const allowed = new Set(roster.devices.map(d => d.sign));
    let taken = 0, top = g.since;
    for (const x of r.data.records || []) {
      top = Math.max(top, Number(x.rev) || 0);
      const rec = x.record;
      if (!rec || !allowed.has(rec.author) || !signedOk(RECORD_TAG, rec, rec.author) || !SYNCED.includes(rec.vault)) {
        this.vault.audit("device-sync", null, "vault", false, "ignored a record no listed device signed");
        continue;
      }
      this.takeRemote(rec);
      taken++;
    }
    this.db.prepare("UPDATE vault_group SET since = ? WHERE id = ?").run(top, g.id);
    return taken;
  }

  /** Sync in a moment (after a local write, or a poke). */
  soon() {
    if (!this.group()) return;
    setTimeout(() => { this.sync({}, "vault").catch(e => this.vault.log(`vault device sync: ${/** @type {Error} */ (e).message}`)); }, 200).unref();
  }

  /** Pull on start, after each local item change, and every ten minutes at most. */
  start() {
    this.vault.onEmit = (type) => {
      if (/^vault\.item-(added|changed|deleted)$/.test(type)) { this.soon(); this.vault.shared.soon?.(); }
    };
    this.soon();
    this.vault.shared.soon?.();
    this.timer = setInterval(() => { this.soon(); this.vault.shared.soon?.(); }, TEN_MINUTES);
    this.timer.unref();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.vault.onEmit = null; }
}
