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
import { parseCode } from "../../relay/client/code.js";
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
 * @typedef {{ kind: "identity" | "space", id: string, label: string, role?: string }} Target
 * @typedef {{ typist?: typeof typeWinkCode, finish?: typeof finishJoin, adopt?: (paired: any, target: { kind: string, id: string }) => Promise<boolean> }} Ports
 */

/**
 * @param {{ ctx: any, now: () => number, identity: () => Promise<string>, space: () => Promise<string>, directory: Directory, ports?: Ports,
 *   openCode: (flow: "W1" | "W2" | "W3") => Promise<{ offer: string, code: string, expires: number }>,
 *   ack: (offer: string, typed: string) => Promise<{ ok: boolean }>, owner: (meta: any, what: string) => void, relayUrl: () => Promise<string>, keyFile?: string, spaceNow?: () => string }} o
 */
export function createPairing(o) {
  const { ctx, now, directory } = o;
  const db = ctx.store.db;
  const ports = { typist: typeWinkCode, finish: finishJoin, ...(o.ports || {}) };
  const meta = {
    get: (/** @type {string} */ k) => { const r = /** @type {any} */ (db.prepare("SELECT v FROM wink_meta WHERE k = ?").get(k)); return r ? JSON.parse(r.v) : null; },
    set: (/** @type {string} */ k, /** @type {any} */ v) => { db.prepare("INSERT INTO wink_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(k, JSON.stringify(v)); },
  };
  /** Node's crypto and a key file under the box's home: the typing side has no IndexedDB. @type {any} */
  const pairOptions = o.keyFile ? { crypto: nodeCrypto(), keyStore: fileKeyStore(o.keyFile) } : {};
  /** Pairings this device is typing for (secret seeds stay in memory). @type {Map<string, any>} */
  const pending = new Map();

  const rowOf = (/** @type {any} */ r) => r ? { id: r.id, identity: r.identity, kind: r.kind, name: r.name, fingerprint: r.fingerprint, owner: { kind: r.owner_kind, id: r.owner_id }, offers: JSON.parse(r.offers || "{}"), created: r.created, removed: r.removed_at != null, nodeKey: r.node_key || null, stableId: r.stable_id || null } : null;
  const devices = {
    /** @param {string} identity */
    list: identity => /** @type {any[]} */ (db.prepare("SELECT * FROM wink_devices WHERE identity = ? AND removed_at IS NULL ORDER BY created, id").all(identity)).map(rowOf),
    /** @param {string} id */
    get: id => rowOf(db.prepare("SELECT * FROM wink_devices WHERE id = ?").get(String(id))),
    /** @param {{ id: string, identity: string, kind: string, name?: string, fingerprint?: string, target: { kind: string, id: string } }} d */
    add(d) {
      if (!KINDS.includes(d.kind)) throw fail("bad_input", "a device is a phone, a computer, a server or a storage device");
      const offers = Object.fromEntries(/** @type {string[]} */ (KIND_OFFERS[/** @type {"phone"} */ (d.kind)]).filter(x => x === "access" || d.kind === "storage" || d.kind === "server").map(x => [x, x === "access" || d.kind === "storage"]));
      db.prepare("INSERT OR REPLACE INTO wink_devices (id, identity, kind, name, fingerprint, owner_kind, owner_id, offers, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(String(d.id), d.identity, d.kind, String(d.name || "a device").slice(0, 64), String(d.fingerprint || "").slice(0, 32), d.target.kind, d.target.id, JSON.stringify(offers), now());
      return devices.get(d.id);
    },
    /** @param {string} id */
    remove(id) {
      db.prepare("UPDATE wink_devices SET removed_at = ? WHERE id = ? AND removed_at IS NULL").run(now(), String(id));
      db.prepare("DELETE FROM wink_compute WHERE device = ?").run(String(id));
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
  const compute = {
    /** @param {string} space @param {string} device */
    get: (space, device) => /** @type {any} */ (db.prepare("SELECT * FROM wink_compute WHERE space = ? AND device = ?").get(space, device)) || { space_allows: 0, member_accepts: 0 },
    /** @param {string} space @param {string} device @param {"space" | "member"} side @param {boolean} on */
    set(space, device, side, on) {
      const col = side === "space" ? "space_allows" : "member_accepts";
      db.prepare(`INSERT INTO wink_compute (space, device, ${col}, updated) VALUES (?, ?, ?, ?) ON CONFLICT (space, device) DO UPDATE SET ${col} = excluded.${col}, updated = excluded.updated`).run(space, device, on ? 1 : 0, now());
    },
  };
  /**
   * May this device's compute run this space's work? Only a computer, only while its identity holds a membership in the space, and only
   * when BOTH sides agreed: the space allows it and the member accepts (a personal space needs the member's side alone), and the device
   * itself offers compute. Anything else is no, with the plain reason.
   * @param {{ device: string, space: string }} q @returns {Promise<{ ok: boolean, reason?: string }>}
   */
  const computeAllowed = async q => {
    const d = devices.get(q.device);
    if (!d || d.removed) return { ok: false, reason: "no such device" };
    if (d.kind !== "computer") return { ok: false, reason: "only a computer lends its compute to a space's work" };
    if (!d.offers.compute) return { ok: false, reason: "this computer is not offering compute" };
    const personal = q.space === d.identity;
    if (!personal && !(await directory.memberships(d.identity)).some(m => m.space === q.space)) return { ok: false, reason: "its owner is not a member of that space" };
    const row = compute.get(q.space, q.device);
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
      if (r.status >= 300 || !j || j.error) throw fail("unavailable", String((j && j.error && j.error.message) || `the server answered ${r.status}`));
      return j.data;
    } finally { try { c.close(); } catch { /* closed */ } }
  });
  /** @param {any} paired @param {{ kind: string, id: string }} target @param {{ identity: string, peerSecret: string, device: string }} x */
  const adopt = async (paired, target, x) => {
    if (ports.adopt) return ports.adopt(paired, target, x);
    await callServer(paired, "wink.server.adopt", { owner: target, identity: x.identity, peerSecret: x.peerSecret });
    return true;
  };

  // ---- peer admission (the module's side of core/wink/node host.serveHome and the relay bridge's peers) ----
  // A peer is a paired server of this space or identity. `shared(deviceId, nodeKey)` answers the secret the host proves a peer with, but only for
  // a node key bound to that device row. A row with no node key binds the first key that then PROVES itself: shared() only notes the claim, and
  // the first call that arrives served as that device (see `serve`) turns a single noted claim into the binding. Two claims, or none, bind nothing.
  /** @type {Map<string, Set<string>>} */
  const claims = new Map();
  const peers = {
    /** The secret for one device: derived from this box's peer root, never stored per device. @param {string} deviceId @returns {string} base64url */
    secretFor(deviceId) {
      let root = meta.get("peer_root");
      if (!root) { root = crypto.randomBytes(32).toString("base64url"); meta.set("peer_root", root); }
      return crypto.createHmac("sha256", Buffer.from(root, "base64url")).update(`wink-peer\n${deviceId}`).digest("base64url");
    },
    /** May this device open a peer stream: a live paired server that belongs to this identity or this space. @param {string} deviceId */
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
      const set = claims.get(d.id) || new Set();
      set.add(`${nodeKey}\n${stableId || ""}`);
      claims.set(d.id, set);
      return Buffer.from(peers.secretFor(d.id), "base64url");
    },
    /** Wrap the registry's serve: a call that arrives as device:<id> has proved the secret, so a lone noted claim becomes the binding. @param {(caller: string, tool: string, input: any) => Promise<any>} inner */
    serve(inner) {
      return async (/** @type {string} */ caller, /** @type {string} */ tool, /** @type {any} */ input) => {
        const id = caller.startsWith("device:") ? caller.slice(7) : "";
        const set = id ? claims.get(id) : null;
        if (id && set) {
          claims.delete(id);
          const d = devices.get(id);
          if (set.size === 1 && d && !d.nodeKey) {
            const [nodeKey, stableId] = [...set][0].split("\n");
            db.prepare("UPDATE wink_devices SET node_key = ?, stable_id = ? WHERE id = ? AND node_key IS NULL").run(nodeKey, stableId || null, id);
            ctx.events.emit("wink.peer-bound", { device: id });
          } else if (set.size > 1) ctx.log(`wink: ${set.size} different node keys claimed device ${id}; none was bound`);
        }
        return inner(caller, tool, input);
      };
    },
  };

  // ---- the typing side: the app types a code and shows the code to type back ----
  /** @param {{ code: string, kind: string, target: { kind: string, id: string }, name?: string, relay?: string }} i */
  const startTyping = async i => {
    if (!parseCode(String(i.code))) throw fail("bad_input", words("wrongCode"));
    const relay = i.relay || await o.relayUrl();
    const t = await ports.typist({ relay, input: String(i.code) });
    if (!t.ok) throw fail(t.reason === "format" ? "bad_input" : t.reason === "offline" ? "unavailable" : "refused", words(t.reason === "offline" ? "offline" : t.reason === "busy" ? "busy" : "wrongCode"));
    const id = `pr_${base32(crypto.randomBytes(10), 16)}`;
    const p = { id, state: "waiting", kind: i.kind, target: i.target, expires: now() + 5 * 60_000, relay, device: null };
    pending.set(id, p);
    ctx.events.emit("wink.pair-waiting", { pairing: id, kind: i.kind, target: i.target });
    // The person types the ack on the showing device; the ticket then appears and this finishes with no more taps.
    void (async () => {
      try {
        const f = await ports.finish({ relay, seed: t.seed, name: i.name || String(ctx.config.name || "a device"), waitMs: 5 * 60_000, pollMs: POLL_MS, pairOptions });
        if (!f.ok) { p.state = f.reason === "expired" ? "expired" : "failed"; ctx.events.emit("wink.pair-failed", { pairing: id, reason: f.reason }); return; }
        const identity = await o.identity();
        if (i.kind === "server" || i.kind === "storage") {
          const pd = f.paired || {};
          const sid = `srv_${base32(sha(`server\n${pd.route || pd.device || id}`), 20)}`;
          devices.add({ id: sid, identity, kind: i.kind, name: String(pd.name || "a server"), target: i.target });
          p.device = sid;
          const peerSecret = peers.secretFor(sid);
          p.adopted = await adopt(pd, i.target, { identity, peerSecret, device: sid }).catch(() => false);
        }
        p.state = "done";
        ctx.events.emit("wink.pair-done", { pairing: id, kind: i.kind, target: i.target, ...(p.device ? { device: p.device } : {}) });
      } catch (e) { p.state = "failed"; ctx.log(`wink: pairing failed: ${/** @type {Error} */ (e).message}`); }
    })();
    return { pairing: id, ack: t.ack, expires: p.expires };
  };

  /** Registers this box's own tools. */
  function tools() {
    const { owner } = o;
    ctx.tool("wink.pair.targets", {
      description: "The \"Pair to:\" choices for a server or storage device: you, and each space you administer. Answers { targets: [{ kind: identity | space, id, label, role? }] }. A phone and a computer pair to you only.",
      input: obj(),
      run: async (_, meta = {}) => { owner(meta, "the pair targets"); return { targets: await targets(await o.identity()) }; },
    });
    ctx.tool("wink.pair.server", {
      description: "Pair a new server (or storage device) from this app: type the code the server printed and choose where it goes. Answers { pairing, ack, expires }: show `ack` and have the person type it on the server. The pairing then finishes by itself (wink.pair.status).",
      input: obj({ code: str, target: obj({ kind: { type: "string", enum: ["identity", "space"] }, id: str }, ["kind", "id"]), kind: { type: "string", enum: ["server", "storage"] }, name: str }, ["code", "target"]),
      presence: { summary: async () => "Add a server to Vyre" },
      run: async (input, meta = {}) => {
        owner(meta, "pairing a server");
        const kind = String(input.kind || "server");
        if (kind !== "server" && kind !== "storage") throw fail("bad_input", words("chooseTarget"));
        const target = await checkTarget(await o.identity(), kind, input.target);
        return { ...(await startTyping({ code: input.code, kind, target, name: input.name })), target };
      },
    });
    ctx.tool("wink.pair.status", {
      description: "Where a pairing is: { state: waiting | done | failed | expired, device? }.",
      input: obj({ pairing: str }, ["pairing"]),
      run: async (input, meta = {}) => {
        owner(meta, "pairing");
        const p = pending.get(String(input.pairing));
        if (!p) throw fail("not_found", "no such pairing");
        if (p.state === "waiting" && now() >= p.expires) p.state = "expired";
        return { state: p.state, kind: p.kind, ...(p.device ? { device: p.device } : {}) };
      },
    });

    // The server's side: it prints a code, the app types it, the person types back the app's code here.
    ctx.tool("wink.server.code", {
      description: "On the new server: show a code for the Vyre app to type (the install script prints it). Answers { offer, code, expires }. The app chooses where the server goes; type back the code the app shows with wink.server.confirm.",
      input: obj(),
      run: async (_, meta = {}) => { owner(meta, "adding this server"); return o.openCode("W3"); },
    });
    ctx.tool("wink.server.confirm", {
      description: "On the new server: type back the code the app is showing. One try per code. Answers { ok }. The right code adds this server for whoever typed its code; the app then says where it goes (wink.server.adopt).",
      input: obj({ offer: str, typed: str }, ["offer", "typed"]),
      run: async (input, meta = {}) => { owner(meta, "adding this server"); return o.ack(String(input.offer), String(input.typed)); },
    });
    ctx.tool("wink.server.adopt", {
      description: "On a server that was just paired: record who it belongs to, an identity or a space { kind, id }, and the identity that paired it. Called by the pairing app over the paired channel; the first caller wins, and only that caller (or the owner's own screen) may change it later. Answers { owner }.",
      input: obj({ owner: obj({ kind: { type: "string", enum: ["identity", "space"] }, id: str }, ["kind", "id"]), identity: str, peerSecret: str }, ["owner"]),
      run: async (input, meta0 = {}) => {
        owner(meta0, "adopting a server");
        const caller = String((meta0 && meta0.caller) || "");
        const prior = meta.get("adopter");
        if (prior && caller.startsWith("device:") && prior !== caller) throw fail("denied", "this server already has an owner");
        const t = { kind: String(input.owner.kind), id: String(input.owner.id) };
        const ident = String(input.identity || (t.kind === "identity" ? t.id : "") || await o.identity());
        meta.set("owner", { ...t, identity: ident });
        if (caller.startsWith("device:")) meta.set("adopter", caller);
        if (input.peerSecret && /^[A-Za-z0-9_-]{20,80}$/.test(String(input.peerSecret))) meta.set("peer_secret", String(input.peerSecret));
        devices.add({ id: "self", identity: ident, kind: "server", name: String(ctx.config.name || "this server"), target: t });
        ctx.events.emit("wink.server-adopted", { owner: t });
        return { owner: t };
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
        return { ...(await startTyping({ code: q.code, kind: "phone", target, relay: q.relay })), target };
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
        compute.set(space, d.id, side, on);
        ctx.events.emit("wink.offer-changed", { device: d.id, offer, on, space, side });
        return { allowed: await computeAllowed({ device: d.id, space }) };
      },
    });
  }

  return { devices, targets, checkTarget, computeAllowed, compute, tools, startTyping, pending, peers, meta };
}

/** The QR a computer shows for a phone: the code and where to meet. @param {string} code @param {string} relay */
export const qrPayload = (code, relay) => `vyre://wink/1?c=${encodeURIComponent(code)}&r=${encodeURIComponent(relay)}`;
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
