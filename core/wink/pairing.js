// @ts-check
// pairing: devices belong to the IDENTITY, never to spaces (team/0.3/DESIGN-wink.md sections 3, 4 and 7).
//
//   Registry     wink_devices: one row per device, keyed by the identity that holds it, with a kind (phone, computer, server, storage)
//                and per-device offers. A server or storage device may be owned by a space its identity administers. A device reaches
//                every space its identity holds a grant for by itself; there is no per-space device enrolment and a device is never
//                a member of a space.
//   Targets      wink.pair.targets: "Pair to:" choices, the identity plus the spaces the person administers (read through the
//                directory port below: the kernel's memberships and roles, or a fake until the real directory is merged).
//   Pairing      two ways only: scan a code, or two-sided typed codes (each side shows a code, the other types it). A phone pairs to
//                the identity only. wink.pair.server (the app types the server's code and shows the code to type back),
//                wink.server.code / wink.server.confirm / wink.server.adopt (the server's side), wink.phone.open / wink.phone.scan.
//   Compute      wink.offer.set and computeAllowed: a computer's compute reaches a space only when the space allows it AND the member
//                accepts (DESIGN-wink section 7).
// The module wiring (index.js) owns the Wink code state machine and hands this file the pieces it needs.

import crypto from "node:crypto";
import { ROLE_IDS } from "../../kernel/contracts/index.js";
import { typeWinkCode, finishJoin } from "../../relay/client/join.js";
import { parseCode, b64url, unb64url } from "../../relay/client/code.js";
import { qrArt } from "../../relay/client/qr.js";
import { connect as relayConnect } from "../../relay/client/client.js";
import { nodeCrypto, fileKeyStore } from "../../relay/client/nodecrypto.js";
import { base32 } from "./grants.js";
import { words } from "./cards.js";

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const sha = (/** @type {string} */ s) => crypto.createHash("sha256").update(s).digest();
const str = { type: "string" };
const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });

export const KINDS = Object.freeze(["phone", "computer", "server", "storage"]);
/** What each kind of device may offer (DESIGN-wink section 3). */
export const KIND_OFFERS = Object.freeze({ phone: ["access"], computer: ["access", "compute"], server: ["access", "compute", "storage"], storage: ["storage"] });
/** The kind each typed-code flow adds (W1 a phone, W2 a computer, W3 a server). */
export const FLOW_KIND = Object.freeze({ W1: "phone", W2: "computer", W3: "server" });
/** Roles that may add a server or storage device to a space. */
export const ADMIN_ROLES = Object.freeze(["owner", "admin"]);
if (!ADMIN_ROLES.every(r => ROLE_IDS.includes(r))) throw new Error("wink: ADMIN_ROLES must be roles of the contract");

export const MIGRATIONS = [
  `CREATE TABLE wink_devices (id TEXT PRIMARY KEY, identity TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, fingerprint TEXT NOT NULL DEFAULT '',
     owner_kind TEXT NOT NULL DEFAULT 'identity', owner_id TEXT NOT NULL, offers TEXT NOT NULL DEFAULT '{}', created INTEGER NOT NULL, removed_at INTEGER)`,
  `CREATE INDEX wink_devices_identity ON wink_devices (identity, removed_at)`,
  `CREATE TABLE wink_compute (space TEXT NOT NULL, device TEXT NOT NULL, space_allows INTEGER NOT NULL DEFAULT 0, member_accepts INTEGER NOT NULL DEFAULT 0,
     updated INTEGER NOT NULL, PRIMARY KEY (space, device))`,
];

/** Appended after every other wink migration (versions are positions): the node binding for peer admission, and a small key-value table. */
export const PEER_MIGRATIONS = [
  `ALTER TABLE wink_devices ADD COLUMN node_key TEXT`,
  `ALTER TABLE wink_devices ADD COLUMN stable_id TEXT`,
  `CREATE TABLE wink_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  // The owner's signing key for a device (SPKI, base64url), for signed instructions to a headless box (wink.relay.apply).
  `ALTER TABLE wink_devices ADD COLUMN sign_key TEXT`,
];
/** What a device offers to the pairing keys: polling slower than the relay's rate limit, and Node's own crypto and key file (0600). */
export const POLL_MS = 1500;

/**
 * The directory port: who holds which role in which space. The real one is the kernel's membership table; until it is merged a box
 * answers for its own space only, and tests pass a fake.
 * @typedef {{ space: string, name?: string, role: string }} Membership
 * @typedef {{ memberships(identity: string): Promise<Membership[]>, label?(identity: string): Promise<string | null> }} Directory
 */

/**
 * What the app hands a new server: where its home is, the home's box id, the node's join key, the relay and the space. The platform supplies it (it knows the home's
 * own address and headscale); secrets inside it travel only in the paired channel's adopt call.
 * @typedef {(q: { target: { kind: string, id: string }, device: string }) => Promise<{ home?: string, box?: string, controlUrl?: string, authKey?: string, relay?: string, space?: string } | null>} Handover
 */

/**
 * @typedef {{ kind: "identity" | "space", id: string, label: string, role?: string }} Target
 * @typedef {{ typist?: typeof typeWinkCode, finish?: typeof finishJoin, mint?: (seed: Buffer) => Promise<any>, adopt?: (paired: any, target: { kind: string, id: string }) => Promise<boolean> }} Ports
 */

/**
 * @param {{ ctx: any, now: () => number, identity: () => Promise<string>, space: () => Promise<string>, directory: Directory, ports?: Ports,
 *   openCode: (flow: "W1" | "W2" | "W3") => Promise<{ offer: string, code: string, expires: number }>,
 *   ack: (offer: string, typed: string) => Promise<{ ok: boolean }>, owner: (meta: any, what: string) => void, relayUrl: () => Promise<string>, keyFile?: string, spaceNow?: () => string,
 *   handover?: Handover, releaseMs?: number, dropMs?: number, releaseRetryMs?: number,
 *   offers?: { get(space: string, device: string): { space_allows: number | boolean, member_accepts: number | boolean } | Promise<any>, set(space: string, device: string, side: "space" | "member", on: boolean): void | Promise<void> } }} o
 */
export function createPairing(o) {
  const { ctx, now, directory } = o;
  const db = ctx.store.db;
  const ports = { typist: typeWinkCode, finish: finishJoin, ...(o.ports || {}) };
  const meta = {
    get: (/** @type {string} */ k) => { const r = /** @type {any} */ (db.prepare("SELECT v FROM wink_meta WHERE k = ?").get(k)); return r ? JSON.parse(r.v) : null; },
    set: (/** @type {string} */ k, /** @type {any} */ v) => { db.prepare("INSERT INTO wink_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(k, JSON.stringify(v)); },
    del: (/** @type {string} */ k) => { db.prepare("DELETE FROM wink_meta WHERE k = ?").run(k); },
  };
  /** Node's crypto and a key file under the box's home: the typing side has no IndexedDB. @type {any} */
  const pairOptions = o.keyFile ? { crypto: nodeCrypto(), keyStore: fileKeyStore(o.keyFile) } : {};
  /** Pairings this device is typing for (secret seeds stay in memory). @type {Map<string, any>} */
  const pending = new Map();

  const rowOf = (/** @type {any} */ r) => r ? { id: r.id, identity: r.identity, kind: r.kind, name: r.name, fingerprint: r.fingerprint, owner: { kind: r.owner_kind, id: r.owner_id }, offers: JSON.parse(r.offers || "{}"), created: r.created, removed: r.removed_at != null, nodeKey: r.node_key || null, stableId: r.stable_id || null, signKey: r.sign_key || null } : null;
  const devices = {
    /** @param {string} identity */
    list: identity => /** @type {any[]} */ (db.prepare("SELECT * FROM wink_devices WHERE identity = ? AND removed_at IS NULL ORDER BY created, id").all(identity)).map(rowOf),
    /** @param {string} id */
    get: id => rowOf(db.prepare("SELECT * FROM wink_devices WHERE id = ?").get(String(id))),
    /**
     * A second pairing under a known id may refresh the name and fingerprint and bring a removed row back, never change who holds it or what it
     * is: a different identity or kind is refused, and so is a different owner unless the row was removed first.
     * @param {{ id: string, identity: string, kind: string, name?: string, fingerprint?: string, target: { kind: string, id: string } }} d
     */
    add(d) {
      if (!KINDS.includes(d.kind)) throw fail("bad_input", "a device is a phone, a computer, a server or a storage device");
      const offers = Object.fromEntries(/** @type {string[]} */ (KIND_OFFERS[/** @type {"phone"} */ (d.kind)]).filter(x => x === "access" || d.kind === "storage" || d.kind === "server").map(x => [x, x === "access" || d.kind === "storage"]));
      const name = String(d.name || "a device").slice(0, 64), fingerprint = String(d.fingerprint || "").slice(0, 32);
      const at = devices.get(d.id);
      if (!at) {
        db.prepare("INSERT INTO wink_devices (id, identity, kind, name, fingerprint, owner_kind, owner_id, offers, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(String(d.id), d.identity, d.kind, name, fingerprint, d.target.kind, d.target.id, JSON.stringify(offers), now());
        return devices.get(d.id);
      }
      if (at.identity !== d.identity || at.kind !== d.kind) throw fail("conflict", "that device is already paired to someone else, or as something else");
      if (!at.removed && (at.owner.kind !== d.target.kind || at.owner.id !== d.target.id)) throw fail("conflict", "that device already belongs somewhere else; remove it first");
      db.prepare("UPDATE wink_devices SET name = ?, fingerprint = ?, owner_kind = ?, owner_id = ?, removed_at = NULL, offers = ?, node_key = ?, stable_id = ? WHERE id = ?")
        .run(name, fingerprint, d.target.kind, d.target.id, JSON.stringify(at.removed ? offers : at.offers), at.removed ? null : at.nodeKey, at.removed ? null : at.stableId, String(d.id));
      return devices.get(d.id);
    },
    /** The owner's signing key for one of their devices (SPKI, base64url), used by wink.relay.apply. @param {string} id @param {string} key */
    setSignKey(id, key) { db.prepare("UPDATE wink_devices SET sign_key = ? WHERE id = ? AND removed_at IS NULL").run(key, String(id)); },
    /** The row for this box itself, written by adopt only (its own path: adopting replaces the row, add never does). @param {{ identity: string, name: string, target: { kind: string, id: string } }} d */
    setSelf(d) {
      db.prepare("INSERT OR REPLACE INTO wink_devices (id, identity, kind, name, fingerprint, owner_kind, owner_id, offers, created) VALUES ('self', ?, 'server', ?, '', ?, ?, ?, ?)")
        .run(d.identity, String(d.name || "this server").slice(0, 64), d.target.kind, d.target.id, JSON.stringify({ access: true, compute: false, storage: false }), now());
      return devices.get("self");
    },
    /** @param {string} id */
    remove(id) {
      db.prepare("UPDATE wink_devices SET removed_at = ? WHERE id = ? AND removed_at IS NULL").run(now(), String(id));
      if (!o.offers) db.prepare("DELETE FROM wink_compute WHERE device = ?").run(String(id));
    },
  };

  // ---- targets: where a server or a storage device may be paired ----
  /** The "Pair to:" choices: the person's identity, then the spaces they administer. @param {string} identity @returns {Promise<Target[]>} */
  const targets = async identity => {
    const label = (directory.label && (await directory.label(identity))) || String(ctx.config.name || "You");
    /** @type {Target[]} */
    const out = [{ kind: "identity", id: identity, label }];
    for (const m of await directory.memberships(identity)) if (ADMIN_ROLES.includes(m.role)) out.push({ kind: "space", id: m.space, label: m.name || m.space, role: m.role });
    return out;
  };
  /** Checks a target for a kind of device and returns it; throws a plain reason. @param {string} identity @param {string} kind @param {any} t */
  const checkTarget = async (identity, kind, t) => {
    const want = t && typeof t === "object" ? { kind: String(t.kind), id: String(t.id) } : null;
    if (!want) throw fail("bad_input", words("chooseTarget"));
    if (kind === "phone" || kind === "computer") {
      if (want.kind !== "identity" || want.id !== identity) throw fail("identity_only", words(kind === "phone" ? "phoneIdentityOnly" : "computerIdentityOnly"));
      return want;
    }
    const all = await targets(identity);
    const hit = all.find(x => x.kind === want.kind && x.id === want.id);
    if (!hit) {
      const isSpace = want.kind === "space";
      throw fail(isSpace ? "not_admin" : "bad_input", words(isSpace ? "notAdmin" : "chooseTarget", { space: want.id }));
    }
    return want;
  };

  // ---- compute offers (DESIGN-wink section 7) ----
  // ONE store of the two sides at a time. With an `offers` port (the kernel's offers store, grants.offers, which the runner's lease path
  // reads) every read and write goes there and wink_compute is never touched, so a withdrawal cannot be missed. Without one (a box with no
  // kernel yet) wink_compute is the only store.
  const local = {
    /** @param {string} space @param {string} device */
    get: (space, device) => /** @type {any} */ (db.prepare("SELECT * FROM wink_compute WHERE space = ? AND device = ?").get(space, device)) || { space_allows: 0, member_accepts: 0 },
    /** @param {string} space @param {string} device @param {"space" | "member"} side @param {boolean} on */
    set(space, device, side, on) {
      const col = side === "space" ? "space_allows" : "member_accepts";
      db.prepare(`INSERT INTO wink_compute (space, device, ${col}, updated) VALUES (?, ?, ?, ?) ON CONFLICT (space, device) DO UPDATE SET ${col} = excluded.${col}, updated = excluded.updated`).run(space, device, on ? 1 : 0, now());
    },
  };
  const compute = o.offers || local;
  /**
   * May this device's compute run this space's work? Only a computer, only while its identity holds a membership in the space, and only
   * when BOTH sides agreed in the kernel (`offers.active`: the space allows it and the member accepts, bound to the computer's key). Your
   * own personal space needs the computer's own compute switch alone (no kernel space is involved). Anything else is no, with the plain reason.
   * @param {{ device: string, space: string }} q @returns {Promise<{ ok: boolean, reason?: string }>}
   */
  const computeAllowed = async q => {
    const d = devices.get(q.device);
    if (!d || d.removed) return { ok: false, reason: "no such device" };
    if (d.kind !== "computer") return { ok: false, reason: "only a computer lends its compute to a space's work" };
    if (!d.offers.compute) return { ok: false, reason: "this computer is not offering compute" };
    const personal = q.space === d.identity;
    if (!personal && !(await directory.memberships(d.identity)).some(m => m.space === q.space)) return { ok: false, reason: "its owner is not a member of that space" };
    const row = (await compute.get(q.space, q.device, { member: d.identity, device_key: d.nodeKey || undefined })) || { space_allows: 0, member_accepts: 0 };
    if (!personal && !row.space_allows) return { ok: false, reason: "the space has not allowed work on members' computers" };
    if (!row.member_accepts) return { ok: false, reason: "its owner has not accepted work for this space" };
    return { ok: true };
  };

  // ---- telling the new server who owns it: over the paired channel, with the secret its peers will prove with ----
  /** @param {any} paired @param {string} tool @param {any} input */
  const callServer = ports.callServer || (async (/** @type {any} */ paired, /** @type {string} */ tool, /** @type {any} */ input) => {
    const c = relayConnect({ relay: paired.relay, route: paired.route, box: paired.box, name: String(ctx.config.name || "a device"), ...pairOptions });
    try {
      const r = await c.fetch(`/v1/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      const j = await r.json().catch(() => null);
      if (r.status >= 300 || !j || j.error) throw Object.assign(fail("unavailable", String((j && j.error && j.error.message) || `the server answered ${r.status}`)), { remote: String((j && j.error && j.error.code) || "") });
      return j.data;
    } finally { try { c.close(); } catch { /* closed */ } }
  });
  /**
   * What the new server needs to reach its home with no one to carry it (home address, box id, the node's join key, the relay and its own device id),
   * handed over only inside the paired channel's encrypted call to wink.server.adopt, stored on the server, never in a card, an event or a log.
   * @param {any} paired @param {{ kind: string, id: string }} target @param {{ identity: string, peerSecret: string, device: string, ownerName?: string, handover?: any }} x */
  const adopt = async (paired, target, x) => {
    if (ports.adopt) return ports.adopt(paired, target, x);
    const hand = x.handover && typeof x.handover === "object" ? { ...x.handover, device: x.device } : { device: x.device };
    await callServer(paired, "wink.server.adopt", { owner: { ...target, ...(x.ownerName ? { name: String(x.ownerName).slice(0, 64) } : {}) }, identity: x.identity, peerSecret: x.peerSecret, handover: hand });
    return true;
  };

  // ---- peer admission (the module's side of core/wink/node host.serveHome and the relay bridge's peers) ----
  // A peer is a paired server of this space or identity. `shared(deviceId, nodeKey)` answers the secret the host proves a peer with, but only for
  // a node key bound to that device row. A row with no node key binds the first key that PROVES itself: shared() only notes the claim (for a
  // minute), and the host, after it has checked the peer's proof of the device secret, reports the node key that proved it as the last argument
  // of `serve`. Only a noted claim for that proven key binds. An unproven claim binds nothing, so naming a device's row with a made-up key
  // cannot lock the real server out.
  const CLAIM_TTL_MS = 60_000, MAX_CLAIMS = 8;
  /** @type {Map<string, Map<string, { stableId: string, at: number }>>} */
  const claims = new Map();
  const liveClaims = (/** @type {string} */ id) => {
    const m = claims.get(id);
    if (!m) return null;
    for (const [k, c] of m) if (now() - c.at >= CLAIM_TTL_MS) m.delete(k);
    if (!m.size) { claims.delete(id); return null; }
    return m;
  };
  const peers = {
    /** The secret for one device: derived from this box's peer root, never stored per device. @param {string} deviceId @returns {string} base64url */
    secretFor(deviceId) {
      let root = meta.get("peer_root");
      if (!root) { root = crypto.randomBytes(32).toString("base64url"); meta.set("peer_root", root); }
      return crypto.createHmac("sha256", Buffer.from(root, "base64url")).update(`wink-peer\n${deviceId}`).digest("base64url");
    },
    /** May this device open a peer stream: a live paired server that belongs to this identity or this space. Sync, answered from the registry. @param {string} deviceId */
    allow(deviceId) {
      const d = devices.get(String(deviceId));
      if (!d || d.removed || d.kind !== "server") return false;
      if (d.owner.kind === "space") return d.owner.id === (o.spaceNow ? o.spaceNow() : "");
      return true;
    },
    /** @param {string} deviceId @param {string} nodeKey @param {string} [stableId] @returns {Buffer | null} */
    shared(deviceId, nodeKey, stableId) {
      const d = devices.get(String(deviceId));
      if (!peers.allow(deviceId) || !d) return null;
      if (d.nodeKey) return d.nodeKey === nodeKey ? Buffer.from(peers.secretFor(d.id), "base64url") : null;
      const m = liveClaims(d.id) || new Map();
      if (!m.has(nodeKey) && m.size >= MAX_CLAIMS) m.delete(m.keys().next().value);
      m.set(nodeKey, { stableId: stableId || "", at: now() });
      claims.set(d.id, m);
      return Buffer.from(peers.secretFor(d.id), "base64url");
    },
    /**
     * Wrap the registry's serve. A call that arrives as device:<id> has proved the device secret; when the host also says which node key made that
     * proof (`proven.nodeKey`), a noted claim for exactly that key becomes the binding. A call with no proven key binds nothing.
     * @param {(caller: string, tool: string, input: any) => Promise<any>} inner
     */
    serve(inner) {
      return async (/** @type {string} */ caller, /** @type {string} */ tool, /** @type {any} */ input, /** @type {{ nodeKey?: string } | undefined} */ proven) => {
        const id = caller.startsWith("device:") ? caller.slice(7) : "";
        const key = proven && typeof proven.nodeKey === "string" ? proven.nodeKey : "";
        const m = id && key ? liveClaims(id) : null;
        const claim = m && m.get(key);
        if (claim) {
          claims.delete(id);
          const d = devices.get(id);
          if (d && !d.nodeKey) {
            db.prepare("UPDATE wink_devices SET node_key = ?, stable_id = ? WHERE id = ? AND node_key IS NULL").run(key, claim.stableId || null, id);
            ctx.events.emit("wink.peer-bound", { device: id });
          }
        }
        return inner(caller, tool, input);
      };
    },
    /** The paired server's side: the secret its home gave at adopt time, for joinPeer's `shared(box)`. @returns {Buffer} */
    ownSecret() {
      const k = meta.get("peer_secret");
      if (!k) throw fail("unavailable", "this server has not been adopted by a home yet");
      return Buffer.from(String(k), "base64url");
    },
  };

  /**
   * The words for a refusal from the server's own adopt, or for any other way the hand-over failed. A refusal because the server still has an
   * owner (presence_required, denied, conflict, or the platform's person_session_required) is a plain card naming that owner; anything else
   * is the reason in full, never cut short.
   * @param {string} name @param {any} e */
  const adoptReason = (name, e) => {
    const m = String((e && e.message) || e || "no answer");
    const remote = String((e && e.remote) || "");
    if (/^(presence_required|denied|conflict|person_session_required)$/.test(remote) || /already belongs to|belongs to .+\. Remove|person's own action/.test(m)) {
      const who = /belongs to (.+?)\. (?:Remove|Change)/.exec(m);
      return words("stillOwned", { owner: who ? who[1] : "" });
    }
    return words("adoptFailed", { name, why: m.replace(/[.\s]+$/, "").slice(0, 400) });
  };

  // ---- letting a server go: the app tells it, with the owner's presence already given for the remove ----
  const RELEASE_MS = o.releaseMs ?? 20_000;
  /** Calls the server's own release over a paired channel, bounded in time. @param {any} chan @returns {Promise<"released" | "refused" | "unreachable">} */
  const callRelease = async chan => {
    let timer;
    try {
      await Promise.race([callServer(chan, "wink.server.release", {}), new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error("no answer"), { remote: "" })), RELEASE_MS); })]);
      return "released";
    } catch (e) {
      // the server says this app is not the one that owns it: trying again later changes nothing, and the person is told to reset it on the server
      return /^(denied|presence_required|person_session_required)$/.test(String(/** @type {any} */ (e).remote || "")) ? "refused" : "unreachable";
    } finally { if (timer) clearTimeout(timer); }
  };
  /** Where the app reached a server when it paired it: the three things a later call needs. @param {any} pd */
  const channelOf = pd => (pd && pd.route ? { relay: String(pd.relay || ""), route: String(pd.route), box: String(pd.box || "") } : null);
  /**
   * Tell a removed server to free itself. The caller has already had the owner's presence for the removal. Answers "released", "pending" (it could not
   * be reached: the release is kept and applied when it next answers, see retryReleases, or at its next pairing), "refused" (it answered that this app is
   * not what owns it) or "unknown" (this app never kept a channel to it: an older pairing).
   * @param {string} sid @returns {Promise<"released" | "pending" | "refused" | "unknown">}
   */
  const releaseServer = async sid => {
    const chan = meta.get(`channel:${sid}`);
    if (!chan) return "unknown";
    const r = await callRelease(chan);
    if (r === "released") { meta.del(`channel:${sid}`); meta.del(`release:${sid}`); ctx.events.emit("wink.server-release", { device: sid, state: "released" }); return "released"; }
    meta.del(`channel:${sid}`);
    if (r === "refused") { meta.del(`release:${sid}`); return "refused"; }
    meta.set(`release:${sid}`, { ...chan, since: now() });
    ctx.events.emit("wink.server-release", { device: sid, state: "pending" });
    return "pending";
  };
  /** Applies every release that could not be delivered, one try each. Runs on a timer and whenever a server is paired again. */
  const retryReleases = async () => {
    const rows = /** @type {any[]} */ (db.prepare("SELECT k, v FROM wink_meta WHERE k LIKE 'release:%'").all());
    for (const row of rows) {
      let chan; try { chan = JSON.parse(row.v); } catch { meta.del(row.k); continue; }
      const r = await callRelease(chan);
      if (r === "unreachable") continue;
      meta.del(row.k);
      if (r === "released") ctx.events.emit("wink.server-release", { device: row.k.slice(8), state: "released" });
    }
  };
  const retryEvery = o.releaseRetryMs ?? 60_000;
  /** @type {any} */
  let retryTimer = null;
  /** The timer that applies pending releases; the module's stop() ends it. */
  const startRetries = () => { if (retryTimer || !retryEvery) return; retryTimer = setInterval(() => { void retryReleases().catch(() => {}); }, retryEvery); if (retryTimer.unref) retryTimer.unref(); };
  const stop = () => { if (retryTimer) clearInterval(retryTimer); retryTimer = null; };

  /** Keeps what the relay answered with, so a refusal can be told from a missing connection. */
  const watchFetch = () => {
    const f0 = globalThis.fetch;
    const seen = { old: false };
    return { seen, fetch: /** @type {typeof fetch} */ (async (...a) => { const r = await f0(...a); if (r.status === 426) seen.old = true; return r; }) };
  };

  // ---- the typing side: the app types a code and shows the code to type back ----
  /**
   * `seed` instead of `code`: the pairing came from a server's QR, which carries the ticket's own 16-byte secret, so there is no PAKE and no
   * code to type back (`ack` is null); the ticket is already at the relay, and the rest is the same.
   * @param {{ code?: string, seed?: Uint8Array, kind: string, target: { kind: string, id: string }, label?: string, name?: string, relay?: string }} i */
  const startTyping = async i => {
    if (!i.seed && !parseCode(String(i.code))) throw fail("bad_input", words("wrongCode"));
    const relay = i.relay || await o.relayUrl();
    const w = watchFetch();
    const t = i.seed ? { ok: /** @type {const} */ (true), ack: null, seed: i.seed, route: "" } : await ports.typist({ relay, input: String(i.code), fetch: w.fetch });
    if (!t.ok) {
      if (w.seen.old) throw fail("relay_old", words("relayOld"));
      throw fail(t.reason === "format" ? "bad_input" : t.reason === "offline" ? "unavailable" : "refused", words(t.reason === "offline" ? "offline" : t.reason === "busy" ? "busy" : "wrongCode"));
    }
    const id = `pr_${base32(crypto.randomBytes(10), 16)}`;
    const p = { id, state: "waiting", kind: i.kind, target: i.target, expires: now() + 5 * 60_000, relay, device: null, reason: "" };
    pending.set(id, p);
    ctx.events.emit("wink.pair-waiting", { pairing: id, kind: i.kind, target: i.target });
    const failWith = (/** @type {string} */ state, /** @type {string} */ reason) => { p.state = state; p.reason = reason; ctx.events.emit("wink.pair-failed", { pairing: id, reason }); };
    // The person types the ack on the showing device; the ticket then appears and this finishes with no more taps.
    void (async () => {
      let fresh = "";
      try {
        const w2 = watchFetch();
        const f = await ports.finish({ relay, seed: t.seed, name: i.name || String(ctx.config.name || "a device"), waitMs: 5 * 60_000, pollMs: POLL_MS, pairOptions, fetch: w2.fetch });
        if (!f.ok) {
          failWith(f.reason === "expired" ? "expired" : "failed", w2.seen.old ? words("relayOld") : f.reason === "expired" ? words("codeExpired") : f.reason === "offline" ? words("offline") : words("wrongCode"));
          return;
        }
        const identity = await o.identity();
        if (i.kind === "server" || i.kind === "storage") {
          const pd = f.paired || {};
          const sid = `srv_${base32(sha(`server\n${pd.route || pd.device || id}`), 20)}`;
          const name = String(pd.name || "a server");
          const before = devices.get(sid);
          try { devices.add({ id: sid, identity, kind: i.kind, name, target: i.target }); }
          catch (e) {
            if (/already has an owner|already belongs somewhere else|paired to someone else/.test(String(/** @type {Error} */ (e).message))) { failWith("failed", words("alreadyPaired", { name })); return; }
            throw e;
          }
          if (!before || before.removed) fresh = sid;
          p.device = sid;
          const peerSecret = peers.secretFor(sid);
          const handover = o.handover ? await Promise.resolve(o.handover({ target: i.target, device: sid })).catch(() => null) : null;
          let ok = false, why = null;
          // A release that could not be delivered when the person removed this server goes now, over the channel this pairing just made.
          if (meta.get(`release:${sid}`)) { if ((await callRelease(channelOf(pd) || meta.get(`release:${sid}`))) !== "unreachable") meta.del(`release:${sid}`); }
          try { ok = await adopt(pd, i.target, { identity, peerSecret, device: sid, ownerName: i.label, handover }); }
          catch (e) { why = e; }
          p.adopted = ok === true;
          if (p.adopted) { const ch = channelOf(pd); if (ch) meta.set(`channel:${sid}`, ch); }
          if (!p.adopted) {
            // the server was not told: nothing is half-added, and the person is told what to do
            if (fresh) { devices.remove(fresh); p.device = null; }
            failWith("failed", adoptReason(name, why || new Error("no answer")));
            return;
          }
        }
        p.state = "done";
        ctx.events.emit("wink.pair-done", { pairing: id, kind: i.kind, target: i.target, ...(p.device ? { device: p.device } : {}) });
      } catch (e) { if (fresh) devices.remove(fresh); failWith("failed", String(/** @type {Error} */ (e).message || "pairing failed")); ctx.log(`wink: pairing failed: ${/** @type {Error} */ (e).message}`); }
    })();
    return { pairing: id, ack: t.ack, expires: p.expires };
  };

  /** Puts a ticket from a seed at the relay (relay.ticket.mint, modules only). @param {Buffer} seed */
  const mint = ports.mint || (async (/** @type {Buffer} */ seed) => ctx.call("relay.ticket.mint", { seed: seed.toString("base64url") }));

  /** Registers this box's own tools. */
  function tools() {
    const { owner } = o;
    ctx.tool("wink.pair.targets", {
      description: "The \"Pair to:\" choices for a server or storage device: you, and each space you administer. Answers { targets: [{ kind: identity | space, id, label, role? }] }. A phone and a computer pair to you only.",
      input: obj(),
      run: async (_, meta = {}) => { owner(meta, "the pair targets"); return { targets: await targets(await o.identity()) }; },
    });
    ctx.tool("wink.pair.server", {
      description: "Pair a new server (or storage device) from this app: type the code the server printed, or give `payload`, the text of the QR it printed (a scan), and choose where it goes. Answers { pairing, ack, expires }: for a typed code show `ack` and have the person type it on the server; a scan has no ack (null) and nothing to type. The pairing then finishes by itself (wink.pair.status).",
      input: obj({ code: str, payload: str, target: obj({ kind: { type: "string", enum: ["identity", "space"] }, id: str }, ["kind", "id"]), kind: { type: "string", enum: ["server", "storage"] }, name: str }, ["target"]),
      presence: { summary: async () => "Add a server to Vyre" },
      run: async (input, meta = {}) => {
        owner(meta, "pairing a server");
        const kind = String(input.kind || "server");
        if (kind !== "server" && kind !== "storage") throw fail("bad_input", words("chooseTarget"));
        const identity = await o.identity();
        const target = await checkTarget(identity, kind, input.target);
        const label = (await targets(identity)).find(x => x.kind === target.kind && x.id === target.id)?.label;
        const scan = input.payload ? parseServerQr(String(input.payload)) : null;
        if (input.payload && !scan) throw fail("bad_input", words("notACode"));
        if (!scan && !input.code) throw fail("bad_input", words("wrongCode"));
        const who = scan ? { seed: scan.seed, relay: scan.relay || undefined } : { code: String(input.code) };
        return { ...(await startTyping({ ...who, kind, target, label, name: input.name })), target: { ...target, ...(label ? { label } : {}) } };
      },
    });
    ctx.tool("wink.pair.status", {
      description: "Where a pairing is: { state: waiting | done | failed | expired, device?, reason? }. A failed pairing says why in plain words (for example that the server already belongs to someone and must be removed first).",
      input: obj({ pairing: str }, ["pairing"]),
      run: async (input, meta = {}) => {
        owner(meta, "pairing");
        const p = pending.get(String(input.pairing));
        if (!p) throw fail("not_found", "no such pairing");
        if (p.state === "waiting" && now() >= p.expires) p.state = "expired";
        return { state: p.state, kind: p.kind, ...(p.device ? { device: p.device } : {}), ...(p.reason ? { reason: p.reason } : {}) };
      },
    });

    // The server's side: it prints a code, the app types it, the person types back the app's code here.
    ctx.tool("wink.server.code", {
      description: "On the new server: show a code for the Vyre app to type (the install script prints it). Answers { offer, code, expires }. The app chooses where the server goes; type back the code the app shows with wink.server.confirm. With `qr` true it also mints a 5-minute ticket from a fresh 128-bit secret and answers `qr` (the payload a phone scans, which needs no code and no typing back) and `art` (that QR drawn as text for a terminal), or qr null when the relay could not take the ticket.",
      input: obj({ qr: { type: "boolean" } }),
      run: async (input, meta = {}) => {
        owner(meta, "adding this server");
        const made = await o.openCode("W3");
        if (!input || input.qr !== true) return made;
        const seed = crypto.randomBytes(16);
        try {
          const t = /** @type {any} */ (await mint(seed));
          if (!t || t.error) return { ...made, qr: null };
          const qr = serverQrPayload(seed, await o.relayUrl());
          return { ...made, qr, art: qrArt(qr) };
        } catch { return { ...made, qr: null }; }
      },
    });
    ctx.tool("wink.server.confirm", {
      description: "On the new server: type back the code the app is showing. One try per code. Answers { ok, message }. A right code means the codes matched, nothing more: the app finishes the pairing (wink.server.adopt) and wink.pair.status on the app is the one place that says it is done or that it failed and why.",
      input: obj({ offer: str, typed: str }, ["offer", "typed"]),
      run: async (input, meta = {}) => { owner(meta, "adding this server"); const r = await o.ack(String(input.offer), String(input.typed)); return r && r.ok ? { ...r, message: words("codeMatched") } : r; },
    });
    // W-4: adoption happens once, at the first pairing. The adopter is recorded for every caller kind (a cli adoption too). After an owner exists nothing
    // changes without (a) fresh presence of the current owner on this box (wink.server.retarget, the owner's own screen), or (b) the target space's admin
    // claim. The claim is, for now, the kernel directory port's admin check (the named identity holds an admin role in the target space); the signed form
    // (an admin device's signature over the server id and the space, verified by the space's home) is not built, see docs/work/tailnet.md.
    /** The hand-over the app sent: short strings under known names, nothing else. @param {any} x */
    const cleanHandover = x => {
      if (!x || typeof x !== "object") return null;
      /** @type {Record<string, string>} */
      const out = {};
      for (const k of ["home", "box", "controlUrl", "authKey", "relay", "space", "device"]) if (typeof x[k] === "string" && x[k] && x[k].length <= 512 && !/[\u0000-\u001f]/.test(x[k])) out[k] = x[k];
      return Object.keys(out).length ? out : null;
    };
    /** Who an owner row names, in words. @param {any} cur */
    const ownerWords = async cur => {
      if (cur.kind === "space") {
        if (cur.name) return cur.name;
        try { const m = (await directory.memberships(cur.identity)).find(x => x.space === cur.id); if (m && m.name) return m.name; } catch { /* the directory may not know it */ }
        return "another space";
      }
      return "Personal";
    };
    const applyAdopt = async (/** @type {any} */ input, /** @type {string} */ caller) => {
      const t = { kind: String(input.owner.kind), id: String(input.owner.id) };
      const ident = String(input.identity || (t.kind === "identity" ? t.id : "") || await o.identity());
      const ownerName = input.owner.name ? String(input.owner.name).slice(0, 64) : "";
      const first = !meta.get("owner") || !meta.get("adopter");
      meta.set("owner", { ...t, identity: ident, ...(ownerName ? { name: ownerName } : {}) });
      if (first) meta.set("adopter", caller);
      if (input.peerSecret && /^[A-Za-z0-9_-]{20,80}$/.test(String(input.peerSecret))) meta.set("peer_secret", String(input.peerSecret));
      const h = cleanHandover(input.handover);
      if (h) meta.set("handover", h);
      devices.setSelf({ identity: ident, name: String(ctx.config.name || "this server"), target: t });
      ctx.events.emit("wink.server-adopted", { owner: t });
      return { owner: t };
    };
    const adoptInput = obj({ owner: obj({ kind: { type: "string", enum: ["identity", "space"] }, id: str, name: str }, ["kind", "id"]), identity: str, peerSecret: str, handover: obj({ home: str, box: str, controlUrl: str, authKey: str, relay: str, space: str, device: str }) }, ["owner"]);
    ctx.tool("wink.server.adopt", {
      description: "On a server that was just paired: record who it belongs to, an identity or a space { kind, id }, and the identity that paired it. Called by the pairing app over the paired channel, once: the first caller adopts it and is recorded. After that it cannot be repeated over the paired channel; the person changes the owner on this box with wink.server.retarget (their own presence), and only the one that adopted it, or a screen on this box, may. Answers { owner }.",
      input: adoptInput,
      // No presence gate in front: the platform would turn a stranger away before this ran, and its relay device row would stay on the box.
      // The same rule is kept here: once there is an owner, a change needs the owner's fresh presence (meta0.presence) from the one that adopted it.
      run: async (input, meta0 = {}) => {
        owner(meta0, "adopting a server");
        const caller = String((meta0 && meta0.caller) || "anonymous");
        const prior = meta.get("owner"), adopter = meta.get("adopter");
        if (prior) {
          // Once there is an owner, a change needs the owner's fresh presence, and comes from the one that adopted it or from a screen on this box.
          // A refused device that is not the adopter leaves nothing behind: its relay device goes (after the refusal has been answered).
          const stranger = caller.startsWith("device:") && adopter !== caller;
          if (stranger) dropLater(caller);
          if (!meta0.presence) throw fail("presence_required", words("serverOwned", { owner: await ownerWords(prior) }));
          if (stranger) throw fail("denied", words("serverOwned", { owner: await ownerWords(prior) }));
        }
        return applyAdopt(input, caller);
      },
    });
    /** Takes a paired app's relay device off this box, so it no longer reaches it as an owner device. Waits a moment so the answer to the call that asked still travels. @param {any} caller */
    function dropLater(caller) {
      const c = String(caller || "");
      if (!c.startsWith("device:") || typeof ctx.call !== "function") return;
      const id = c.slice(7);
      const go = () => { Promise.resolve(ctx.call("relay.devices.drop", { id })).catch(() => null); };
      const wait = o.dropMs ?? 750;
      if (!wait) { go(); return; }
      const t = setTimeout(go, wait);
      if (t.unref) t.unref();
    }
    /** Clears who owns this server: owner, adopter, the hand-over and the peer secret, and its own row. Its own keys stay. The one that adopted it loses its device here too. */
    const clearOwner = () => {
      const adopter = meta.get("adopter");
      for (const k of ["owner", "adopter", "handover", "peer_secret"]) meta.del(k);
      dropLater(adopter);
      db.prepare("UPDATE wink_devices SET removed_at = ? WHERE id = 'self' AND removed_at IS NULL").run(now());
      ctx.events.emit("wink.server-released", {});
    };
    ctx.tool("wink.server.release", {
      description: "On a server: let go of its owner. The app that adopted it calls this over the paired channel when the person removes the server there (the app has the owner's presence for the removal). Only the app that adopted this server may; anyone else is refused, and a person at this server uses wink.server.reset. Clears the owner, the adopter and the hand-over and keeps the server's own keys, so it can be paired again. Answers { released }.",
      input: obj(),
      run: async (_, meta0 = {}) => {
        owner(meta0, "letting a server go");
        const caller = String((meta0 && meta0.caller) || "anonymous");
        if (!meta.get("owner")) return { released: true, already: true };
        if (!caller.startsWith("device:") || meta.get("adopter") !== caller) throw fail("denied", words("releaseDenied", { owner: await ownerWords(meta.get("owner")) }));
        clearOwner();
        return { released: true };
      },
    });
    /** The short fingerprint of this server, which the person types to free it: eight characters from its own name and route, shown by wink.server.fingerprint. */
    const serverFingerprint = async () => {
      let route = "";
      try { const r = /** @type {any} */ (typeof ctx.call === "function" ? await ctx.call("relay.status", {}) : null); route = String((r && r.data && r.data.route) || ""); } catch { /* the relay may be off */ }
      const h = crypto.createHash("sha256").update(`wink-server\n${String(ctx.config.name || "")}\n${route}`).digest("hex").slice(0, 8).toUpperCase();
      return `${h.slice(0, 4)}-${h.slice(4)}`;
    };
    ctx.tool("wink.server.fingerprint", {
      description: "On the server itself: its short fingerprint (like AB12-CD34), the code a person types to free it with wink.server.reset when the server has no passkey. Not a secret. Answers { fingerprint, owned }.",
      input: obj(),
      run: async (_, meta0 = {}) => {
        owner(meta0, "the server's fingerprint");
        const c = String((meta0 && meta0.caller) || "");
        if (/^(device:|tailnet|relay)/.test(c)) throw fail("denied", words("resetOnServer"));
        return { fingerprint: await serverFingerprint(), owned: Boolean(meta.get("owner")) };
      },
    });
    ctx.tool("wink.server.reset", {
      description: "On the server itself: forget who owns it so it can be paired again, when the app that owned it cannot tell it to let go (the app was lost, or the server was unreachable when it was removed). Two ways, both only at the server: the person's presence, or, on a box with no passkey, the local command line (`vyre wink reset`) with the server's fingerprint typed in `fingerprint` (see wink.server.fingerprint). Never callable over a paired channel, the tailnet or the relay, and never by an agent. Keeps the server's own keys; the app that owned it loses its device here. Answers { reset }.",
      input: obj({ fingerprint: str }),
      // Presence is asked unless the caller brought the fingerprint; run() decides whether that is allowed for this caller.
      presence: { summary: async () => "Free this server so it can be added again", when: (/** @type {any} */ i) => !(i && i.fingerprint) },
      run: async (input, meta0 = {}) => {
        owner(meta0, "resetting a server");
        const caller = String((meta0 && meta0.caller) || "anonymous");
        if (/^(device:|tailnet|relay|module:relay)/.test(caller)) throw fail("denied", words("resetOnServer"));
        if (!meta0.presence) {
          if (!input || !input.fingerprint) throw fail("presence_required", words("resetNeedsYou"));
          if (caller !== "cli") throw fail("denied", words("resetOnServer"));
          const want = await serverFingerprint();
          if (String(input.fingerprint).trim().toUpperCase().replace(/[^A-Z0-9]/g, "") !== want.replace("-", "")) throw fail("fingerprint_mismatch", words("resetFingerprint"));
        }
        const had = Boolean(meta.get("owner"));
        clearOwner();
        return { reset: true, had };
      },
    });
    ctx.tool("wink.server.handover", {
      internal: true,
      description: "What this server was handed when it was adopted, to reach its home: { home, box, controlUrl, authKey, relay, space, device } (any may be missing), and the peer secret. Secrets: modules only, never shown to a person. Answers { handover } or { handover: null }.",
      input: obj(),
      run: async (_, meta0 = {}) => {
        if (meta0.caller && !/^module:/.test(String(meta0.caller))) throw fail("denied", "the hand-over is for modules on this server");
        const h = meta.get("handover");
        return { handover: h ? { ...h, ...(meta.get("peer_secret") ? { peerSecret: meta.get("peer_secret") } : {}) } : null };
      },
    });
    ctx.tool("wink.server.retarget", {
      description: "On this server, from the owner's own screen with presence: change who it belongs to (an identity or a space). The same as wink.server.adopt once there is an owner. Answers { owner }.",
      input: adoptInput,
      presence: { summary: async i => `Change who this server belongs to${i && i.owner ? ` (${String(i.owner.kind)})` : ""}` },
      run: async (input, meta0 = {}) => {
        owner(meta0, "changing a server's owner");
        const caller = String(meta0.caller || "anonymous");
        if (!meta0.presence) throw fail("presence_required", "changing a server's owner needs the owner's presence on this box");
        if (caller.startsWith("device:") && meta.get("adopter") !== caller) throw fail("denied", "only the one that adopted this server may change its owner");
        return applyAdopt(input, caller);
      },
    });
    // For the relay bridge and the node host (reach modules): may this device open a peer stream, and the secret for a bound node key.
    ctx.tool("wink.peer.allow", {
      description: "Whether a device may open a peer stream to this space: only a live paired server of this space or its owner. Answers { allow }.",
      input: obj({ device: str }, ["device"]),
      run: async input => ({ allow: peers.allow(String(input.device)) }),
    });
    ctx.tool("wink.peer.shared", {
      description: "The secret a peer proves with for a device and node key, or null when the node key is not the one bound to that device. A first claim is noted and bound once a call arrives as that device. Answers { secret }.",
      input: obj({ device: str, nodeKey: str, stableId: str }, ["device", "nodeKey"]),
      run: async input => { const k = peers.shared(String(input.device), String(input.nodeKey), input.stableId ? String(input.stableId) : undefined); return { secret: k ? k.toString("base64url") : null }; },
    });

    // A phone: a signed-in computer shows a code and a QR, the phone scans, the phone shows a code, the person types it on the computer.
    ctx.tool("wink.phone.open", {
      description: "Add a phone. From a computer already signed in to you: show a code and a QR payload for the phone to scan. Answers { offer, code, qr, expires }. The phone then shows a code to type here (wink.code.ack). A phone pairs to you only, never to a space.",
      input: obj({ space: str }),
      presence: { summary: async () => "Show a code to add a phone" },
      run: async (input, meta = {}) => {
        owner(meta, "adding a phone");
        if (input.space) throw fail("identity_only", words("phoneIdentityOnly"));
        const c = await o.openCode("W1");
        return { ...c, qr: qrPayload(c.code, await o.relayUrl()) };
      },
    });
    ctx.tool("wink.phone.scan", {
      description: "On the phone: read the QR the computer shows. Answers { pairing, ack, expires }: show `ack` and have the person type it on the computer. A phone only pairs to the person's own identity.",
      input: obj({ payload: str, target: obj({ kind: str, id: str }) }, ["payload"]),
      run: async (input, meta = {}) => {
        owner(meta, "adding this phone");
        const q = parseQr(String(input.payload));
        if (!q) throw fail("bad_input", words("notACode"));
        const identity = await o.identity();
        const target = await checkTarget(identity, "phone", input.target || { kind: "identity", id: identity });
        const label = (await targets(identity)).find(x => x.kind === target.kind && x.id === target.id)?.label;
        // With no target the phone joins the identity of whoever shows the code: say whose name that is, never the phone's own local identity.
        const shown = input.target ? { ...target, ...(label ? { label } : {}) } : { kind: "identity", label: label || "you" };
        return { ...(await startTyping({ code: q.code, kind: "phone", target, label, relay: q.relay })), target: shown };
      },
    });

    ctx.tool("wink.offer.set", {
      description: "Set what a device offers. Without a space: the device's own offers (a phone: access; a computer: access, compute; a server: access, compute, storage; a storage device: storage). With a space and offer compute: the space's side (an admin of it, side space) or the member's side (the device's owner, side member). Compute reaches a space only when both sides are on. Answers { device, offers } or { allowed }.",
      input: obj({ device: str, offer: { type: "string", enum: ["access", "compute", "storage"] }, on: { type: "boolean" }, space: str, side: { type: "string", enum: ["space", "member"] } }, ["device", "offer", "on"]),
      presence: { summary: async i => `${i && i.on === false ? "Stop offering" : "Offer"} ${String((i && i.offer) || "")} on a device` },
      run: async (input, meta = {}) => {
        owner(meta, "setting an offer");
        const identity = await o.identity();
        const d = devices.get(String(input.device));
        if (!d || d.removed) throw fail("not_found", "no such device");
        const offer = String(input.offer), on = input.on === true;
        if (!(/** @type {string[]} */ (KIND_OFFERS[/** @type {"phone"} */ (d.kind)])).includes(offer)) throw fail("bad_input", words("kindCannotOffer", { kind: d.kind, offer }));
        if (!input.space) {
          if (d.identity !== identity) throw fail("denied", words("notYourDevice"));
          db.prepare("UPDATE wink_devices SET offers = ? WHERE id = ?").run(JSON.stringify({ ...d.offers, [offer]: on }), d.id);
          ctx.events.emit("wink.offer-changed", { device: d.id, offer, on });
          return { device: d.id, offers: devices.get(d.id).offers };
        }
        if (offer !== "compute" || d.kind !== "computer") throw fail("bad_input", words("onlyComputeToSpace"));
        const space = String(input.space);
        const side = input.side === "space" ? "space" : "member";
        if (side === "space") {
          const role = (await directory.memberships(identity)).find(m => m.space === space);
          if (!role || !ADMIN_ROLES.includes(role.role)) throw fail("not_admin", words("notAdmin", { space }));
        } else if (d.identity !== identity) throw fail("denied", words("notYourDevice"));
        await compute.set(space, d.id, side, on, { member: d.identity, device_key: d.nodeKey || undefined, meta });
        ctx.events.emit("wink.offer-changed", { device: d.id, offer, on, space, side });
        return { allowed: await computeAllowed({ device: d.id, space }) };
      },
    });
  }

  return { devices, targets, checkTarget, computeAllowed, compute, tools: () => { tools(); startRetries(); }, startTyping, pending, peers, meta, releaseServer, retryReleases, stop };
}

/** The QR a computer shows for a phone: the code and where to meet. @param {string} code @param {string} relay */
export const qrPayload = (code, relay) => `vyre://wink/1?c=${encodeURIComponent(code)}&r=${encodeURIComponent(relay)}`;
/**
 * The QR a new server shows for a phone or app to scan: the 16-byte secret of a ticket already at the relay (128 bits, so no PAKE is needed
 * and nothing is typed) and where to meet. Version 2 of the payload; the typed code's QR (version 1, above) carries a code instead.
 * @param {Uint8Array} seed @param {string} relay
 */
export const serverQrPayload = (seed, relay) => `vyre://wink/2?t=${b64url(seed)}&r=${encodeURIComponent(relay)}`;
/** Reads a server's QR payload: { seed, relay } or null. @param {string} s @returns {{ seed: Uint8Array, relay: string } | null} */
export function parseServerQr(s) {
  const m = /^vyre:\/\/wink\/2\?(.*)$/.exec(String(s).trim());
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const seed = unb64url(q.get("t") || "");
  return seed && seed.length === 16 ? { seed, relay: q.get("r") || "" } : null;
}

/** Reads a QR payload (or a bare code). @param {string} s @returns {{ code: string, relay: string } | null} */
export function parseQr(s) {
  const m = /^vyre:\/\/wink\/1\?(.*)$/.exec(String(s).trim());
  if (!m) { const p = parseCode(String(s)); return p ? { code: p.code, relay: "" } : null; }
  const q = new URLSearchParams(m[1]);
  const p = parseCode(q.get("c") || "");
  return p ? { code: p.code, relay: q.get("r") || "" } : null;
}

/**
 * The real directory: the kernel's grants store knows who holds which role in the space this box runs (work/kernel, kernel/grants/index.js:
 * `roleOf(actor)` and `isAdmin(actor)` on the store; the module surface may also offer `roles.isAdmin(person, space)`). PORT: until the kernel is
 * merged into this tree the call shape is the one above, and tests pass a fake with the same shape. One role is read here, never written.
 * @param {{ kernel: any, space: () => Promise<string>, name: () => string }} o @returns {Directory}
 */
export function kernelDirectory(o) {
  const k = o.kernel;
  return {
    async memberships(identity) {
      const space = await o.space();
      const actor = { kind: "person", id: identity, space };
      /** @type {string | null} */
      let role = null;
      if (k && k.grants && typeof k.grants.roleOf === "function") role = (await k.grants.roleOf(actor)) || null;
      else if (k && k.grants && typeof k.grants.isAdmin === "function") role = (await k.grants.isAdmin(actor)) ? "admin" : null;
      else if (k && k.roles && typeof k.roles.isAdmin === "function") role = (await k.roles.isAdmin(identity, space)) ? "admin" : null;
      return role ? [{ space, name: o.name(), role }] : [];
    },
    async label() { return null; },
  };
}
/** True when the kernel offers a way to read a role (any of the shapes kernelDirectory reads). @param {any} k */
export const kernelHasRoles = k => Boolean(k && ((k.grants && (typeof k.grants.roleOf === "function" || typeof k.grants.isAdmin === "function")) || (k.roles && typeof k.roles.isAdmin === "function")));

/** The fallback directory (PORT, a fake until the kernel is merged): this box answers for its own space, where the owner is the owner. @param {{ identity: () => Promise<string>, space: () => Promise<string>, name: () => string }} o @returns {Directory} */
export function ownDirectory(o) {
  return {
    async memberships(identity) { return identity === await o.identity() ? [{ space: await o.space(), name: o.name(), role: "owner" }] : []; },
    async label() { return null; },
  };
}
