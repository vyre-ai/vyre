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
 *   ack: (offer: string, typed: string) => Promise<{ ok: boolean }>, owner: (meta: any, what: string) => void, relayUrl: () => Promise<string> }} o
 */
export function createPairing(o) {
  const { ctx, now, directory } = o;
  const db = ctx.store.db;
  const ports = { typist: typeWinkCode, finish: finishJoin, ...(o.ports || {}) };
  /** Pairings this device is typing for (secret seeds stay in memory). @type {Map<string, any>} */
  const pending = new Map();

  const rowOf = (/** @type {any} */ r) => r ? { id: r.id, identity: r.identity, kind: r.kind, name: r.name, fingerprint: r.fingerprint, owner: { kind: r.owner_kind, id: r.owner_id }, offers: JSON.parse(r.offers || "{}"), created: r.created, removed: r.removed_at != null } : null;
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
        const f = await ports.finish({ relay, seed: t.seed, name: i.name || String(ctx.config.name || "a device"), waitMs: 5 * 60_000, pollMs: 200 });
        if (!f.ok) { p.state = f.reason === "expired" ? "expired" : "failed"; ctx.events.emit("wink.pair-failed", { pairing: id, reason: f.reason }); return; }
        const identity = await o.identity();
        if (i.kind === "server" || i.kind === "storage") {
          const pd = f.paired || {};
          const sid = `srv_${base32(sha(`server\n${pd.route || pd.device || id}`), 20)}`;
          devices.add({ id: sid, identity, kind: i.kind, name: String(pd.name || "a server"), target: i.target });
          p.device = sid;
          p.adopted = ports.adopt ? await ports.adopt(pd, i.target).catch(() => false) : false;
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
      description: "On a server that was just paired: record who it belongs to, an identity or a space { kind, id }. Called by the paired app. Answers { owner }.",
      input: obj({ owner: obj({ kind: { type: "string", enum: ["identity", "space"] }, id: str }, ["kind", "id"]) }, ["owner"]),
      run: async (input, meta = {}) => {
        owner(meta, "adopting a server");
        const ident = await o.identity();
        const t = { kind: String(input.owner.kind), id: String(input.owner.id) };
        devices.add({ id: "self", identity: ident, kind: "server", name: String(ctx.config.name || "this server"), target: t });
        ctx.events.emit("wink.server-adopted", { owner: t });
        return { owner: t };
      },
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

  return { devices, targets, checkTarget, computeAllowed, compute, tools, startTyping, pending };
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

/** The fallback directory: this box answers for its own space, where the owner is the owner. @param {{ identity: () => Promise<string>, space: () => Promise<string>, name: () => string }} o @returns {Directory} */
export function ownDirectory(o) {
  return {
    async memberships(identity) { return identity === await o.identity() ? [{ space: await o.space(), name: o.name(), role: "owner" }] : []; },
    async label() { return null; },
  };
}
