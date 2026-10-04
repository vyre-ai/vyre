// @ts-check
// pairing: devices belong to the IDENTITY, never to spaces (team/0.3/DESIGN-wink.md sections 3, 4 and 7).
//
//   Registry     wink_devices: one row per device, keyed by the identity that holds it, with a kind (phone, computer, server, storage)
//                and per-device offers. A server or storage device may be owned by a space its identity administers. A device reaches
//                every space its identity holds a grant for by itself; there is no per-space device enrolment and a device is never
//                a member of a space.
//   Targets      wink.pair.targets: "Pair to:" choices, the identity plus the spaces the person administers (read through the
//                directory port below: the kernel's memberships and roles, or a fake until the real directory is merged).
//   Pairing      two ways: scan a QR, or paste the long code; both confirmed by the same three words. A phone pairs to
//                the identity only. wink.pair.server (the app scans the server's QR or takes its pasted long code), wink.server.code / wink.server.adopt
//                (the server's side), wink.phone.open / wink.phone.scan (QR or paste, three words on both sides, a yes on the computer); the typed code is a development flag.
//   Compute      wink.offer.set and computeAllowed: a computer's compute reaches a space only when the space allows it AND the member
//                accepts (DESIGN-wink section 7).
// The module wiring (index.js) owns the Wink code state machine and hands this file the pieces it needs.

import crypto from "node:crypto";
import { ROLE_IDS } from "../../kernel/contracts/index.js";
import { typeWinkCode, finishJoin } from "../../relay/client/join.js";
import { parseCode, b64url, unb64url } from "../../relay/client/code.js";
import { qrArt } from "../../relay/client/qr.js";
import { pairWords, nonceCommit, ticketTag, newNonce } from "../../relay/client/pairwords.js";
import { connect as relayConnect } from "../../relay/client/client.js";
import { nodeCrypto, fileKeyStore } from "../../relay/client/nodecrypto.js";
import { WORDS as WORDLIST } from "../../relay/client/words.js";
import { verifyDevice } from "./node/peer-wire.js";
import { base32 } from "./grants.js";
import { words, removed } from "./cards.js";

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const sha = (/** @type {string} */ s) => crypto.createHash("sha256").update(s).digest();
const str = { type: "string" };
const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });

export const KINDS = Object.freeze(["phone", "computer", "server", "storage"]);
/** The callers that are a person at this machine: the question of an unowned server is shown and answered on these only (Q-2). */
export const PERSON_SURFACES = Object.freeze(["cli", "local", "deck", "capsule"]);
/** What the app signs to prove it is the identity an unattended server was installed for (Q-3): this pairing's box and device, nothing a stranger could reuse. @param {string} box @param {string} device */
export const pairToMessage = (box, device) => Buffer.from(`vyre-wink-pair-to-v1\n${box}\n${device}`, "utf8");
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
  // The owner's confirmation of a phone or computer (the paired session, ADR 0032 2d): who confirmed, with which presence key, the device's own request-signing key (a P-256 JWK),
  // whether the platform attested that it lives in hardware (nothing attests yet, so 0), and whether the device keeps it in software (shown on its row).
  `ALTER TABLE wink_devices ADD COLUMN confirmed_by TEXT`,
  `ALTER TABLE wink_devices ADD COLUMN confirm_key TEXT`,
  `ALTER TABLE wink_devices ADD COLUMN device_key TEXT`,
  `ALTER TABLE wink_devices ADD COLUMN hardware INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE wink_devices ADD COLUMN software INTEGER NOT NULL DEFAULT 0`,
  // Where the app SAYS it made the device key: hardware | software | unknown. Self-reported, display only; real attestation is 0.3.1.
  `ALTER TABLE wink_devices ADD COLUMN key_storage TEXT NOT NULL DEFAULT 'unknown'`,
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
 *   handover?: Handover, releaseMs?: number, dropMs?: number, releaseRetryMs?: number, releaseMaxMs?: number,
 *   signIdentity?: (message: Buffer) => Promise<{ eid: string, sig: string } | null> | { eid: string, sig: string } | null,
 *   identityEntry?: (identity: string, eid: string) => Promise<{ eid: string, kind?: string, pub: string, identity?: string } | null | undefined> | { eid: string, kind?: string, pub: string, identity?: string } | null | undefined,
 *   confirmPending?: (device: string, trusted?: boolean) => Promise<any>,
 *   typedCode?: boolean | (() => boolean), confirmAdopt?: boolean, askMs?: number, askHoldMs?: number, askPollMs?: number, pairWordsFor?: (device: string) => Promise<string>,
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
  /** The phone flow's hold, set when the tools are registered: the module's device.paired handler asks it first. `holdRing` holds a ring (relay.pair.ticket) phone for the words, `boxTicketLive` says a QR this box printed is still open. @type {{ hold: (p: any) => Promise<boolean>, holdRing: (p: any) => Promise<boolean>, boxTicketLive: () => boolean }} */
  /** Set when the tools are registered: what reset.js calls to free the server. @type {() => void} */
  let clearOwnerHook = () => { throw fail("not_ready", "the pairing tools are not registered"); };
  const phone = { hold: async () => false, holdRing: async () => false, boxTicketLive: () => false };

  const rowOf = (/** @type {any} */ r) => r ? { id: r.id, identity: r.identity, kind: r.kind, name: r.name, fingerprint: r.fingerprint, owner: { kind: r.owner_kind, id: r.owner_id }, offers: JSON.parse(r.offers || "{}"), created: r.created, removed: r.removed_at != null, nodeKey: r.node_key || null, stableId: r.stable_id || null, signKey: r.sign_key || null, keyStorage: r.key_storage || "unknown", ...(r.key_storage === "software" ? { software: true } : {}) } : null;
  /** Ends a device's paired person session and grant (presence.person.end-paired, module:wink only). Late-bound: set once the context can call. A failure is logged, never a reason to keep the device. @type {(device?: string) => void} */
  let endPaired = () => {};
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
      db.prepare("UPDATE wink_devices SET name = ?, fingerprint = ?, owner_kind = ?, owner_id = ?, removed_at = NULL, offers = ?, node_key = ?, stable_id = ?, sign_key = ? WHERE id = ?")
        .run(name, fingerprint, d.target.kind, d.target.id, JSON.stringify(at.removed ? offers : at.offers), at.removed ? null : at.nodeKey, at.removed ? null : at.stableId, at.removed ? null : at.signKey, String(d.id));
      return devices.get(d.id);
    },
    /**
     * The owner confirmed this device (three words, a presence proof): who, with which presence key, and the device's own request-signing key (a P-256 JWK or null).
     * @param {string} id @param {{ by: string, keyId: string | null, key: any }} c
     */
    setConfirmed(id, c) { db.prepare("UPDATE wink_devices SET confirmed_by = ?, confirm_key = ?, device_key = ?, hardware = 0, software = 0 WHERE id = ? AND removed_at IS NULL").run(c.by, c.keyId, c.key ? JSON.stringify(c.key) : null, String(id)); },
    /** The app's own report of where its key lives. @param {string} id @param {unknown} storage */
    setKeyStorage(id, storage) { db.prepare("UPDATE wink_devices SET key_storage = ? WHERE id = ? AND removed_at IS NULL").run(storage === "hardware" || storage === "software" ? storage : "unknown", String(id)); },
    /** What the presence module reads to decide on a paired session: only what this module itself recorded at the owner's confirm. Null for a device never confirmed, or removed. @param {string} id */
    record(id) {
      const r = /** @type {any} */ (db.prepare("SELECT * FROM wink_devices WHERE id = ? AND removed_at IS NULL").get(String(id)));
      if (!r || !r.confirmed_by) return null;
      return { id: r.id, kind: r.kind, owner: r.identity, confirmed: true, confirmedBy: r.confirmed_by, confirmKeyId: r.confirm_key || null, key: r.device_key ? JSON.parse(r.device_key) : null, hardware: r.hardware === 1 };
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
      endPaired(String(id));
      // S-1: a removed device's signing key goes with it (it could drive wink.relay.apply), and a re-added row never inherits one
      db.prepare("UPDATE wink_devices SET removed_at = ?, sign_key = NULL, confirmed_by = NULL, confirm_key = NULL, device_key = NULL, software = 0, key_storage = 'unknown' WHERE id = ? AND removed_at IS NULL").run(now(), String(id));
      if (!o.offers) db.prepare("DELETE FROM wink_compute WHERE device = ?").run(String(id));
    },
  };

  // ---- the words check (ruling, 4 Oct 2026): a bare yes says yes to anyone, so the person picks the right three words from the right set and two decoys ----
  const normWords = (/** @type {unknown} */ x) => String(x ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  /**
   * The right words hidden among two decoys from the same list, in an order made fresh for this pairing from the system's random source (never from the words, so the right
   * place cannot be guessed). A decoy never shares its first three letters with the right word in the same position (WP-1: 952 words of the list share a prefix with an earlier
   * one, and a glance cannot tell "abandon" from "abandoned"), and no set shares a first word with another.
   * @param {string} right @returns {string[]}
   */
  const makeChoices = right => {
    const rw = right.split(" ");
    const first = (/** @type {string} */ x) => x.split(" ")[0];
    const used = new Set([first(right)]);
    /** @type {string[]} */
    const decoys = [];
    while (decoys.length < 2) {
      const d = [0, 1, 2].map(() => WORDLIST[crypto.randomInt(WORDLIST.length)]);
      if (d.some((w, i) => w.slice(0, 3) === (rw[i] || "").slice(0, 3))) continue;
      if (used.has(d[0])) continue;
      used.add(d[0]); decoys.push(d.join(" "));
    }
    decoys.splice(crypto.randomInt(3), 0, right);
    return decoys;
  };
  /** Sets the right words on a question and shuffles its choices. @param {any} a @param {string} w */
  const setWords = (a, w) => { a.words = w; a.choices = makeChoices(w); };
  /**
   * What the person said about the words: `right` (a pick of the right choice, or all three words typed; nothing shorter, WP-1), `wrong`, or `bare` (a yes with nothing to check).
   * @param {{ words: string, choices?: string[] }} a @param {any} input @returns {"right" | "wrong" | "bare"}
   */
  const judgeWords = (a, input) => {
    const i = input || {};
    if (i.words !== undefined) return normWords(i.words) === normWords(a.words) ? "right" : "wrong";
    if (i.pick !== undefined) { const n = Number(i.pick); return Number.isInteger(n) && n >= 1 && n <= 3 && (a.choices || [])[n - 1] === a.words ? "right" : "wrong"; }
    return "bare";
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
   * @param {any} paired @param {{ kind: string, id: string }} target @param {{ identity: string, peerSecret: string, device: string, ownerName?: string, handover?: any, seed?: Uint8Array, onConfirm?: (words: string, until: number) => void }} x */
  const adopt = async (paired, target, x) => {
    if (ports.adopt) return ports.adopt(paired, target, x);
    const hand = x.handover && typeof x.handover === "object" ? { ...x.handover, device: x.device } : { device: x.device };
    const input = { owner: { ...target, ...(x.ownerName ? { name: String(x.ownerName).slice(0, 64) } : {}) }, identity: x.identity, peerSecret: x.peerSecret, handover: hand };
    // A server installed to pair to one identity asks for proof that this app IS that identity: a signature by a key on its list over this pairing's box and device (Q-3).
    if (typeof o.signIdentity === "function" && paired && paired.box && paired.device) {
      const sig = await Promise.resolve(o.signIdentity(pairToMessage(String(paired.box), String(paired.device)))).catch(() => null);
      if (sig && sig.eid && sig.sig) /** @type {any} */ (input).proof = { eid: String(sig.eid), sig: String(sig.sig) };
    }
    // The three words are made from this pairing's own material (pairwords.js): the ticket secret, both keys and two fresh nonces. Commit then reveal: this app sends
    // sha256(its nonce) first, the server answers with its own nonce, then this app reveals its nonce, so neither side can pick a nonce after seeing the other's.
    const seed = x.seed ? b64url(x.seed) : "";
    const na = newNonce(), commit = await nonceCommit(na), tag = seed ? await ticketTag(seed) : "";
    const pair = (/** @type {any} */ more) => ({ ...input, pairing: { commit, ...(tag ? { tag } : {}), ...more } });
    /** @type {string} */
    let mine = "";
    const cancel = () => { void callServer(paired, "wink.server.adopt", { ...input, pairing: { cancel: true, commit, ...(tag ? { tag } : {}) } }).catch(() => null); };
    try {
      for (let n = 0; n < 1000; n++) {
        const r = await callServer(paired, "wink.server.adopt", pair(mine ? { reveal: na } : {}));
        if (!r || !r.pending) return true;
        if (!mine && r.nb && paired && paired.box && paired.device) {
          mine = await pairWords(String(paired.box), String(paired.device), { ticket: seed, nonceA: na, nonceB: String(r.nb) }).catch(() => "");
          if (mine) continue; // reveal at once
        }
        if (r.words && (!mine || String(r.words) !== mine)) throw fail("mismatch", words("pairMismatch"));
        if (mine && r.words && x.onConfirm) x.onConfirm(mine, Number(r.until) || 0);
        if (Number(r.until) && now() >= Number(r.until)) throw fail("expired", words("pairExpired"));
        await new Promise(res => setTimeout(res, o.askPollMs ?? 500));
      }
    } catch (e) {
      // Nothing the server said no to: tell it to let this device go now, so no relay device is left on the box (the server drops it on any end).
      if (!/** @type {any} */ (e).remote) cancel();
      throw e;
    }
    throw fail("expired", words("pairExpired"));
  };

  /** What this server was handed, with the secrets: for the Wink module's own code (composeWinkHome), never a tool answer to anyone else. @returns {any} */
  const ownHandover = () => {
    const h = meta.get("handover");
    return h ? { ...h, ...(meta.get("peer_secret") ? { peerSecret: meta.get("peer_secret") } : {}) } : null;
  };

  // ---- peer admission (the module's side of core/wink/node host.serveHome and the relay bridge's peers) ----
  // A peer is a paired server of this space or identity. Admission is decided by the device's key on the identity list (core/wink/node/peer-wire.js), never by a node
  // key claim: the old `shared()` claim path and its binding wrapper are gone (reviewer-3, 4 Oct 2026), and so is the tool that noted claims.
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
    // the pairing confirmation's own refusals say what happened in their own words
    const own = String((e && e.code) || "");
    if (/^(mismatch|expired)$/.test(own) || /^(busy|expired|typed_code_off)$/.test(remote) || (remote === "denied" && /waiting to pair to|said no, so nothing/.test(m))) return m;
    if (/^(presence_required|denied|conflict|person_session_required)$/.test(remote) || /already belongs to|belongs to .+\. Remove|person's own action/.test(m)) {
      const who = /belongs to (.+?)\. (?:Remove|Change)/.exec(m);
      return words("stillOwned", { owner: who ? who[1] : "" });
    }
    return words("adoptFailed", { name, why: m.replace(/[.\s]+$/, "").slice(0, 400) });
  };

  // ---- letting a server go: the app tells it, with the owner's presence already given for the remove ----
  const RELEASE_MS = o.releaseMs ?? 20_000;
  const RELEASE_MAX_MS = o.releaseMaxMs ?? 30 * 86_400_000;
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
      // A release the server never confirmed is given up after releaseMaxMs (30 days): the person is told, and the card offers a reset on the server (cards.removed, release "gaveup").
      if (chan && typeof chan.since === "number" && now() - chan.since > RELEASE_MAX_MS) {
        meta.del(row.k);
        ctx.events.emit("wink.server-release", { device: row.k.slice(8), state: "gaveup", message: removed({ what: "device", name: (devices.get(row.k.slice(8)) || {}).name, release: "gaveup" }) });
        continue;
      }
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
        const f = await ports.finish({ relay, seed: t.seed, name: i.name || String(ctx.config.name || "a device"), waitMs: 5 * 60_000, pollMs: POLL_MS, pairOptions, fetch: w2.fetch, ...(i.seed ? { once: true } : {}) });
        if (!f.ok) {
          // A QR's ticket is already at the relay: "gone" means another scanner used it first, or it ran out. Say so at once, never wait out the five minutes (fifth run, break 2).
          if (/** @type {any} */ (f).reason === "gone") { failWith("failed", words("ticketTaken")); return; }
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
          try { ok = await adopt(pd, i.target, { identity, peerSecret, device: sid, ownerName: i.label, handover, seed: i.seed, onConfirm: (/** @type {string} */ w) => { if (p.state !== "confirm") { p.state = "confirm"; p.words = w; ctx.events.emit("wink.pair-confirm", { pairing: id, words: w }); } } }); }
          catch (e) { why = e; }
          p.adopted = ok === true;
          if (p.state === "confirm") p.state = "waiting";
          if (p.adopted) { const ch = channelOf(pd); if (ch) meta.set(`channel:${sid}`, ch); }
          if (!p.adopted) {
            // the server was not told: nothing is half-added, and the person is told what to do
            if (fresh) { devices.remove(fresh); p.device = null; }
            failWith("failed", adoptReason(name, why || new Error("no answer")));
            return;
          }
        }
        // A phone that scanned the computer's QR is only paired with it so far. It shows the same three words the computer shows and waits for the person's yes there; no yes pairs nothing.
        if (i.kind === "phone" && i.seed) {
          const pd = f.paired || {};
          // Same commit-then-reveal as the server's ask (pairwords.js): this phone commits to its nonce, the computer answers with its own, then this phone reveals.
          const seed = b64url(t.seed), na = newNonce(), commit = await nonceCommit(na), tag = await ticketTag(seed);
          let mine = "";
          for (let n = 0; n < 100_000; n++) {
            let r;
            try { r = await callServer(pd, "wink.phone.wait", { commit, tag, name: String(i.name || ctx.config.name || "").slice(0, 64), ...(mine ? { reveal: na } : {}) }); }
            catch (e) { failWith("failed", /^(denied|expired)$/.test(String(/** @type {any} */ (e).remote || "")) ? String(/** @type {Error} */ (e).message) : words("phoneRefused")); return; }
            if (!mine && r && r.nb && pd.box && pd.device) { mine = await pairWords(String(pd.box), String(pd.device), { ticket: seed, nonceA: na, nonceB: String(r.nb) }).catch(() => ""); if (mine) continue; }
            if (r && r.words && (!mine || String(r.words) !== mine)) { failWith("failed", words("phoneMismatch")); return; }
            if (p.state !== "confirm" && r && r.state === "waiting" && mine && r.words) { p.state = "confirm"; p.words = mine; ctx.events.emit("wink.pair-confirm", { pairing: id, words: p.words }); }
            if (r && r.state === "yes") break;
            if (r && r.state === "no") { failWith("failed", words("phoneRefused")); return; }
            if (!r || r.state === "expired" || (Number(r.until) && now() >= Number(r.until))) { failWith("expired", words("phoneExpired")); return; }
            await new Promise(res => setTimeout(res, o.askPollMs ?? 500));
          }
        }
        p.state = "done";
        ctx.events.emit("wink.pair-done", { pairing: id, kind: i.kind, target: i.target, ...(p.device ? { device: p.device } : {}) });
      } catch (e) { if (fresh) devices.remove(fresh); failWith("failed", String(/** @type {Error} */ (e).message || "pairing failed")); ctx.log(`wink: pairing failed: ${/** @type {Error} */ (e).message}`); }
    })();
    return { pairing: id, ack: t.ack, expires: p.expires };
  };

  /**
   * Puts a ticket from a seed at the relay (relay.ticket.mint, modules only). A `gate` (phone or server) makes its redemption a waiting pairing: nothing is paired, no device or
   * presence key made, until this module confirms (confirmPending) after the person has picked the right words (X-1).
   * @param {Buffer} seed @param {"phone" | "server"} [gate]
   */
  const mint = ports.mint || (async (/** @type {Buffer} */ seed, /** @type {string | undefined} */ gate) => { return ctx.call("relay.ticket.mint", { seed: seed.toString("base64url"), ...(gate ? { gate } : {}) }); });
  /**
   * The yes, to the relay: the waiting pairing of this device becomes a paired device now. `not_found` is fine (a pairing the relay never held, a typed code or an ungated ring); any
   * other refusal is an error the caller must not turn into a yes. @param {string} device
   */
  const confirmPending = async (device, trusted = false) => {
    if (o.confirmPending) return o.confirmPending(device, trusted);
    if (typeof ctx.call !== "function") return null;
    const r = /** @type {any} */ (await ctx.call("relay.pair.pending.confirm", { id: String(device), ...(trusted ? { trusted: true } : {}) }));
    if (r && r.error && r.error.code !== "not_found") throw fail("unavailable", String(r.error.message || "the relay would not pair this device"));
    return r && r.data;
  };

  endPaired = device => {
    if (typeof ctx.call !== "function") return;
    Promise.resolve(ctx.call("presence.person.end-paired", device ? { device } : {})).catch(() => null);
  };
  /** The same, awaited: a removal or a reset that cannot end the paired sessions fails instead of leaving them (reviewer-2 PS-2). No presence module (a bare test ctx) is nothing to end. @param {string} [device] */
  const endPairedNow = async device => {
    if (typeof ctx.call !== "function") return;
    const r = /** @type {any} */ (await ctx.call("presence.person.end-paired", device ? { device } : {}));
    if (r && r.error && r.error.code !== "no_such_tool") throw fail("sessions_not_ended", `the paired sessions could not be ended (${r.error.message || r.error.code}); nothing was removed`);
  };
  /** A P-256 public key as base64url SPKI DER to the JWK the paired session binds to; null for anything else. @param {unknown} spki */
  const jwkOf = spki => {
    try {
      const k = crypto.createPublicKey({ key: Buffer.from(String(spki), "base64url"), format: "der", type: "spki" }).export({ format: "jwk" });
      return k.kty === "EC" && k.crv === "P-256" ? { kty: "EC", crv: "P-256", x: k.x, y: k.y } : null;
    } catch { return null; }
  };
  /**
   * The owner confirmed a phone or computer with a presence proof: record who, with which key and which device key, then ask presence for the one-use grant of its paired session
   * (presence.person.pair-grant). Presence reads the record back through wink.device.record, so it trusts nothing passed here. A refusal or a failure leaves the device paired with no
   * session: the pairing never fails for it. The device fetches the grant's challenge itself (presence.person.pair-challenge) over its own channel.
   * @param {string} device @param {string} identity @param {any} presence the confirm's own presence facts (meta.presence) @param {any} confirmed the relay's answer to the confirm (its offered key)
   */
  const openPairedSession = async (device, identity, presence, confirmed) => {
    try {
      devices.setKeyStorage(device, confirmed && confirmed.storage);
      devices.setConfirmed(device, { by: identity, keyId: presence && presence.keyId ? String(presence.keyId) : null, key: confirmed && confirmed.key && (confirmed.alg === undefined || confirmed.alg === -7) ? jwkOf(confirmed.key) : null });
      if (typeof ctx.call !== "function") return;
      const g = /** @type {any} */ (await ctx.call("presence.person.pair-grant", { device }));
      if (!(g && g.data && g.data.granted)) ctx.log(`wink: no paired session for ${device}: ${g && g.error ? g.error.message : "refused"}`);
    } catch (e) { ctx.log(`wink: no paired session for ${device}: ${/** @type {Error} */ (e).message}`); }
  };

  /** The waiting redeemer of an unconfirmed pairing is `web:<id>` at the relay; it is the device `device:<id>` it will become, so wink compares and records that. @param {string} c */
  const canonDevice = c => (/^web:[a-z2-7]{16}$/.test(c) ? `device:${c.slice(4)}` : c);

  /** Registers this box's own tools. */
  function tools() {
    const { owner } = o;
    ctx.tool("wink.pair.targets", {
      description: "The \"Pair to:\" choices for a server or storage device: you, and each space you administer. Answers { targets: [{ kind: identity | space, id, label, role? }] }. A phone and a computer pair to you only.",
      input: obj(),
      run: async (_, meta = {}) => { owner(meta, "the pair targets"); return { targets: await targets(await o.identity()) }; },
    });
    ctx.tool("wink.pair.server", {
      description: "Pair a new server (or storage device) from this app: give `payload`, the text of the QR the server printed (a scan, or the long code pasted), and choose where it goes. Answers { pairing, ack: null, expires }. The person at the server is then asked to confirm, and this app shows the same three words: wink.pair.status answers state `confirm` with `words` until they say yes there; no answer in 5 minutes pairs nothing. A short typed code is switched off in this release (`code` is refused unless the development flag VYRE_WINK_TYPED_CODE=1 is set).",
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
        if (!scan && !typedOn()) throw fail("typed_code_off", words("typedCodeOff"));
        const who = scan ? { seed: scan.seed, relay: scan.relay || undefined } : { code: String(input.code) };
        return { ...(await startTyping({ ...who, kind, target, label, name: input.name })), target: { ...target, ...(label ? { label } : {}) } };
      },
    });
    ctx.tool("wink.pair.status", {
      description: "Where a pairing is: { state: waiting | confirm | done | failed | expired, device?, reason?, words? }. `confirm` means the person at the server is being asked: show `words` (the same three words the server shows) and say to answer yes there only if they match. A failed pairing says why in plain words (for example that the server already belongs to someone and must be removed first).",
      input: obj({ pairing: str }, ["pairing"]),
      run: async (input, meta = {}) => {
        owner(meta, "pairing");
        const p = pending.get(String(input.pairing));
        if (!p) throw fail("not_found", "no such pairing");
        if (p.state === "waiting" && now() >= p.expires) p.state = "expired";
        return { state: p.state, kind: p.kind, ...(p.device ? { device: p.device } : {}), ...(p.reason ? { reason: p.reason } : {}), ...(p.state === "confirm" && p.words ? { words: p.words, message: words(p.kind === "phone" ? "phoneConfirm" : "pairConfirm", { words: p.words }) } : {}) };
      },
    });

    // The server's side: it shows a QR and a long code to paste; the app scans or pastes it, and the person at the server confirms who is asking (Q-1).
    const typedOn = () => typeof o.typedCode === "function" ? Boolean(/** @type {any} */ (o.typedCode)()) : o.typedCode === true;
    /** The single-use ticket secrets this box minted and that are still live, by tag, so a pairing's words can use the one its device redeemed. @type {Map<string, { seed: string, until: number }>} */
    const liveTickets = new Map();
    const rememberTicket = async (/** @type {string} */ seed) => {
      for (const [k, v] of liveTickets) if (v.until <= now()) liveTickets.delete(k);
      liveTickets.set(await ticketTag(seed), { seed, until: now() + 5 * 60_000 });
    };
    phone.boxTicketLive = () => { for (const v of liveTickets.values()) if (v.until > now()) return true; return false; };
    const mintQr = async (/** @type {any} */ made) => {
      const seed = crypto.randomBytes(16);
      try {
        const t = /** @type {any} */ (await mint(seed, "server"));
        if (!t || t.error) return { ...made, qr: null };
        const qr = serverQrPayload(seed, await o.relayUrl());
        await rememberTicket(b64url(seed));
        return { ...made, qr, art: qrArt(qr), expires: now() + 5 * 60_000 };
      } catch { return { ...made, qr: null }; }
    };
    ctx.tool("wink.server.code", {
      description: "On the new server: make a pairing ticket good for 5 minutes and answer { qr, art, expires }: `qr` is the text to paste into the Vyre app on a computer (the long code), and the same text drawn as a QR for a phone to scan is `art`; qr is null when the relay could not take the ticket. Scanning or pasting only gets the app talking to this server. The person at the server then confirms who is asking (wink.server.pairing shows it and the three words, wink.server.pair.answer says yes or no); no answer pairs nothing. `pairTo` (an identity id or name) is for an unattended install and is set only from this server's own command line (cli or local) at install time: only that identity can complete the pairing, no yes is asked, and the app must PROVE it is that identity with a signature by a key on that identity's list (naming it is not enough). A short typed code is switched off in this release; `typed: true` is refused unless the development flag VYRE_WINK_TYPED_CODE=1 is set.",
      input: obj({ qr: { type: "boolean" }, typed: { type: "boolean" }, pairTo: str }),
      run: async (input, meta = {}) => {
        owner(meta, "adding this server");
        const i = input || {};
        if (i.typed === true && !typedOn()) throw fail("typed_code_off", words("typedCodeOff"));
        if (i.pairTo !== undefined) {
          if (!["cli", "local"].includes(String((meta && meta.caller) || ""))) throw fail("denied", "Who a server pairs to is set at install time, on the server itself.");
          const to = String(i.pairTo).trim();
          if (!to || to.length > 64 || /[\u0000-\u001f"\\]/.test(to)) throw fail("bad_input", "Name the identity to pair to by its id or its name.");
          meta0Set(to);
        }
        // Only the development flag keeps the typed code: its offer and short code are made as before, and the QR is added when asked for.
        if (typedOn() && i.qr !== true && i.typed !== false) return o.openCode("W3");
        const made = typedOn() ? await o.openCode("W3") : {};
        return mintQr(made);
      },
    });
    const meta0Set = (/** @type {string} */ to) => { meta.set("pair_to", to); };
    ctx.tool("wink.server.confirm", {
      description: "On the new server: type back the code the app is showing. One try per code. Answers { ok, message }. A right code means the codes matched, nothing more: the app finishes the pairing (wink.server.adopt) and wink.pair.status on the app is the one place that says it is done or that it failed and why.",
      input: obj({ offer: str, typed: str }, ["offer", "typed"]),
      run: async (input, meta = {}) => { owner(meta, "adding this server"); const r = await o.ack(String(input.offer), String(input.typed)); return r && r.ok ? { ...r, message: words("codeMatched") } : r; },
    });
    ctx.tool("wink.server.status", {
      description: "At the server: has it been paired yet? Answers { owned: false } or { owned: true, space, device }: `space` is the name of what it belongs to (a space's name, or Personal for an identity) and `device` the name of the device that paired it, so the installer can say \"Connected to <space>. Finish setting up on your <device>.\" Only this server's own screen or terminal (cli, local, deck, capsule) reads it.",
      input: obj(),
      run: async (_, meta0 = {}) => {
        owner(meta0, "the server's owner");
        atServer(meta0);
        const cur = meta.get("owner"), by = String(meta.get("adopter") || "");
        if (!cur) return { owned: false };
        const dev = by.startsWith("device:") ? devices.get(by.slice(7)) : null;
        return { owned: true, space: await ownerWords({ ...cur, identity: cur.identity }), device: (dev && dev.name) || (cur.name ? String(cur.name) : "device") };
      },
    });
    ctx.tool("wink.server.pairing", {
      description: "At the server: is a device asking to pair this server right now? Answers { asking: false } or { asking: true, name, choices, until, line }: `name` is who is asking, `choices` three sets of three words (one is what the app shows, two are decoys, in an order made fresh for this pairing), and `line` the question to put to the person (answer with wink.server.pair.answer). Only this server's own screen or terminal (the command line, the local console, the deck or the capsule) sees it: never a paired device, the tailnet, the relay, a module, a session, a hook or an agent, and never a model client (mcp or harness).",
      input: obj(),
      run: async (_, meta0 = {}) => {
        owner(meta0, "the pairing question");
        atServer(meta0);
        const a = askLive();
        if (!a || a.state !== "waiting" || !a.words) return { asking: false, ...(meta.get("pair_to") ? { pairTo: meta.get("pair_to") } : {}) };
        return { asking: true, name: a.name, choices: a.choices, until: a.until, line: words("pairAsk", { name: a.name, choices: a.choices }) };
      },
    });
    ctx.tool("wink.server.pair.answer", {
      description: "At the server: answer the pairing question. { yes: false } refuses it. { yes: true } needs the words check: give `pick` (1, 2 or 3, the choice that matches the three words the app shows) or `words` (all three, typed); a bare yes is refused and adds nothing, and a wrong pick or words is a no. Only this server's own screen or terminal may answer (cli, local, deck, capsule): never a paired device, the tailnet, the relay, a module, a session, a hook, a model client or an agent. Answers { answered, yes, name } or { answered: false } when nobody is asking (or the time ran out).",
      input: obj({ yes: { type: "boolean" }, pick: { type: "integer" }, words: str }, ["yes"]),
      run: async (input, meta0 = {}) => {
        owner(meta0, "the pairing answer");
        atServer(meta0);
        const a = askLive();
        if (!a || a.state !== "waiting") return { answered: false };
        // a yes needs the words on screen (the app has revealed its nonce); a no always works, so a person can close an ask that never shows words
        if (!a.words && input && input.yes === true) return { answered: false };
        let wrong = false;
        if (input && input.yes === true) {
          const j = judgeWords(a, input);
          if (j === "bare") throw fail("words_needed", words("pairPick"));
          wrong = j === "wrong";
        }
        a.state = input && input.yes === true && !wrong ? "yes" : "no";
        if (a.state === "no") dropLater(a.caller);
        answered();
        ctx.events.emit("wink.pair-answered", { yes: a.state === "yes" });
        return { answered: true, yes: a.state === "yes", name: a.name, ...(wrong ? { reason: words("pairPickWrong") } : {}) };
      },
    });
    // W-4: adoption happens once, at the first pairing. The adopter is recorded for every caller kind (a cli adoption too). After an owner exists nothing
    // changes (owner, peer secret, handover, adopter) without the current owner's fresh presence, from the one that adopted it or a screen on this box
    // (wink.server.retarget). The identity named in the input is never a claim: it is supplied by the caller. A signed admin claim is not built.
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
    // ---- Q-1 (ruling, 4 Oct 2026): the first adoption of an unowned server by a paired device is CONFIRMED at the server ----
    // A scan or a paste only gets a device paired to this box (the ticket is single use). Becoming its owner is a second step: the device calls wink.server.adopt, the server
    // keeps that as one pending ask, shows who is asking and three words made from both sides' keys, and waits for yes from a person at the server (a local screen or the
    // installer's terminal). No answer in `askMs` pairs nothing. A server installed unattended was told up front who may complete it (`pairTo`, set by wink.server.code):
    // only that identity completes, and no yes is asked. One ask at a time: a second device is refused while one is pending.
    const ASK_MS = o.askMs ?? 5 * 60_000, HOLD_MS = o.askHoldMs ?? 15_000;
    const confirmAdopt = o.confirmAdopt !== false;
    /** @type {null | { caller: string, input: any, name: string, words: string, choices: string[], until: number, state: "waiting" | "yes" | "no", wake: Array<() => void>, nb: string, commit: string, ticket: string, proven?: string }} */
    let ask = null;
    const norm = (/** @type {unknown} */ x) => String(x ?? "").trim().toLowerCase();
    /** The name the person sees for who is asking: the target's own name from the app, else the identity's id. @param {any} input */
    const askName = (input) => String((input.owner && input.owner.name) || input.identity || (input.owner && input.owner.id) || "someone").replace(/[^\p{L}\p{N} ._@:-]/gu, "").slice(0, 64) || "someone";
    /**
     * Q-3: an unattended install named one identity (`pairTo`), and completing the pairing needs PROOF that the one asking is that identity, never a claim. Everything the caller
     * supplies about itself (identity, owner.id, owner.name) is a claim and is ignored here. The proof is a signature by a key on that identity's list over this pairing's box and
     * relay device (pairToMessage), checked against the entry the identity port reads live. Answers the identity the proof speaks for.
     * @param {string} to @param {any} input @param {string} caller @returns {Promise<string>}
     */
    const proveIdentity = async (to, input, caller) => {
      const pr = input && input.proof && typeof input.proof === "object" ? input.proof : null;
      if (!pr || typeof pr.eid !== "string" || typeof pr.sig !== "string" || pr.eid.length > 64 || pr.sig.length > 200) throw fail("denied", words("pairNeedsProof"));
      if (typeof o.identityEntry !== "function") throw fail("denied", words("pairCannotProve"));
      const e = await Promise.resolve(o.identityEntry(to, pr.eid)).catch(() => null);
      if (!e || e.eid !== pr.eid || typeof e.pub !== "string") throw fail("denied", words("pairWrongIdentity", { name: to }));
      if (!verifyDevice(e.pub, pairToMessage(await boxKey(), caller.slice(7)), pr.sig)) throw fail("denied", words("pairWrongIdentity", { name: to }));
      return String(e.identity || to);
    };
    const boxKey = async () => {
      const r = /** @type {any} */ (await ctx.call("relay.route.id", {}));
      const box = r && r.data && r.data.box;
      if (!box) throw fail("unavailable", "this server cannot make the words yet; try again in a moment");
      return String(box);
    };
    /** The words for one pairing: this pairing's own ticket secret and both nonces (pairwords.js). `o.pairWordsFor` is the test seam. @param {string} device @param {{ ticket: string, na: string, nb: string }} m */
    const wordsFor = async (device, m) => (o.pairWordsFor ? o.pairWordsFor(device) : pairWords(await boxKey(), device, { ticket: m.ticket, nonceA: m.na, nonceB: m.nb }));
    /** The device whose ask ran out unanswered: its next call hears that, once, instead of starting a new ask. @type {string | null} */
    let expiredFor = null;
    // Every way an ask ends leaves nothing on the box (fifth run, break 1): the asking app's relay device is dropped on expired, no, a wrong pair-to, a cancel and an error.
    const askLive = () => { if (ask && ask.until <= now()) { const a = ask; ask = null; expiredFor = a.caller; dropLater(a.caller); for (const w of a.wake) w(); } return ask; };
    /** Wakes the adopt call that is holding for an answer. */
    const answered = () => { const a = ask; if (a) for (const w of a.wake.splice(0)) w(); };
    /**
     * First adoption by a paired device on an unowned server: ask, wait for the person at the server, then adopt.
     * The words need this pairing's own nonces (commit, then reveal): call 1 carries `pairing.commit` and is answered with this server's nonce `nb`; call 2 carries
     * `pairing.reveal` (the app's nonce), the server checks it against the commit, makes the words and shows the question. A pairing that carries none is refused
     * (the words would be a function of the static keys). Several scanners: the one that asked first keeps its ask, every other device is refused (busy) and let go, and
     * the first one is never disturbed. If an attacker scans first, the real app's ticket is gone and it says so at once; the person at the server then sees an app that
     * is not the one in front of them (the words never match, or the app reports a taken code) and answers no, which ends the ask and lets the attacker's device go.
     * @param {any} input @param {string} caller
     */
    const firstAdopt = async (input, caller) => {
      const to = meta.get("pair_to");
      const pr = input.pairing && typeof input.pairing === "object" ? input.pairing : {};
      let a = askLive();
      if (!a && expiredFor === caller) { expiredFor = null; dropLater(caller); throw fail("expired", words("pairExpired")); }
      if (a && a.caller !== caller) { dropLater(caller); throw fail("busy", words("pairBusy")); }
      expiredFor = null;
      if (a && pr.cancel === true) { ask = null; for (const w of a.wake) w(); dropLater(caller); throw fail("denied", words("pairCancelled")); }
      try {
        if (!a) {
          let proven = "";
          if (to) { try { proven = await proveIdentity(to, input, caller); } catch (e) { dropLater(caller); throw e; } }
          const fresh = !to && !o.pairWordsFor;
          // WP-1: a ticket's memory is single use and goes at the first ask, whatever follows (a failed ask, a cancel, a bad commit): a stale tag cannot start a second ask
          const liveTicket = pr.tag ? liveTickets.get(String(pr.tag)) : undefined;
          if (pr.tag) liveTickets.delete(String(pr.tag));
          if (pr.cancel === true) throw fail("denied", words("pairCancelled"));
          if (fresh && !/^[0-9a-f]{64}$/.test(String(pr.commit || ""))) throw fail("bad_input", words("pairNeedsFresh"));
          let ticket = "";
          if (fresh && pr.tag) {
            const t = liveTicket;
            if (!t || t.until <= now()) throw fail("denied", words("ticketTaken"));
            ticket = t.seed;
          }
          const nb = newNonce();
          const w = fresh || to ? "" : await wordsFor(caller.slice(7), { ticket, na: "", nb });
          const until = now() + ASK_MS;
          const mine = ask = a = { caller, input, name: askName(input), words: "", choices: [], until, state: to ? "yes" : "waiting", wake: [], nb, commit: String(pr.commit || ""), ticket, ...(proven ? { proven } : {}) };
          if (w) setWords(mine, w);
          // no answer, no yes: the ask ends by itself and lets the app's relay device go, even when the app never calls again
          const timer = setTimeout(() => { if (ask === mine) askLive(); }, ASK_MS + 5);
          if (timer.unref) timer.unref();
          if (!to && !fresh) ctx.events.emit("wink.pair-asked", { device: caller.slice(7), name: mine.name, choices: mine.choices, until: mine.until });
        }
        if (a.state === "waiting" && !a.words) {
          // not revealed yet: answer with the server's nonce; the words appear when the app reveals its own
          if (typeof pr.reveal !== "string" || !pr.reveal) return { pending: true, nb: a.nb, until: a.until };
          if (!/^[0-9a-f]{32}$/.test(pr.reveal) || (await nonceCommit(pr.reveal)) !== a.commit) { ask = null; for (const w of a.wake) w(); throw fail("denied", words("pairMismatch")); }
          setWords(a, await wordsFor(caller.slice(7), { ticket: a.ticket, na: pr.reveal, nb: a.nb }));
          ctx.events.emit("wink.pair-asked", { device: caller.slice(7), name: a.name, choices: a.choices, until: a.until });
        } else if (a.state === "waiting" && a.words && HOLD_MS > 0) await new Promise(res => { const t = setTimeout(res, HOLD_MS); if (t.unref) t.unref(); a && a.wake.push(() => { clearTimeout(t); res(undefined); }); });
        a = askLive();
        if (!a) throw fail("expired", words("pairExpired"));
        if (a.state === "waiting") return { pending: true, nb: a.nb, words: a.words, until: a.until };
        const mine = a; ask = null;
        if (mine.state === "no") throw fail("denied", words("pairRefused"));
        // the relay makes the app's device only now, after the person's check (X-1); the answer to this call still reaches the app over the waiting channel
        await confirmPending(caller.slice(7));
        // a proven identity is the owner's identity; what the caller said about itself is not
        return await applyAdopt(mine.proven ? { ...mine.input, identity: mine.proven } : mine.input, caller);
      } catch (e) {
        // an error, a refusal or a no: nothing stays behind (a pending return above never gets here)
        if (ask && ask.caller === caller && !/** @type {any} */ (e).keepAsk) ask = null;
        dropLater(caller);
        throw e;
      }
    };
    /**
     * The callers that may see and answer an ask (Q-2): an allow list of this server's own person surfaces, never a deny list. A model client (`mcp`, `harness`), a hook, a
     * module, a session, an agent, the tailnet, a paired device and an anonymous caller are all refused, and so is any name not listed.
     * @param {any} m0
     */
    const atServer = (m0) => { const c = String((m0 && m0.caller) || ""); if (!PERSON_SURFACES.includes(c) || (m0 && m0.agent)) throw fail("denied", words("pairOnServer")); };
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
      meta.del("pair_to");
      ctx.events.emit("wink.server-adopted", { owner: t });
      return { owner: t };
    };
    const adoptInput = obj({ pairing: obj({ commit: str, reveal: str, tag: str, cancel: { type: "boolean" } }), owner: obj({ kind: { type: "string", enum: ["identity", "space"] }, id: str, name: str }, ["kind", "id"]), identity: str, peerSecret: str, handover: obj({ home: str, box: str, controlUrl: str, authKey: str, relay: str, space: str, device: str }) }, ["owner"]);
    ctx.tool("wink.server.adopt", {
      callers: ["web"],
      description: "On a server that was just paired: record who it belongs to, an identity or a space { kind, id }, and the identity that paired it. Called by the pairing app over the paired channel. On a server with no owner the person at the server must say yes first (the server shows who asks and three words; no answer in 5 minutes pairs nothing): the call answers { pending, words, until } until then, and call it again to hear the result; a server installed with a named identity (pairTo) takes only that identity and asks no one. After that it cannot be repeated over the paired channel; the person changes the owner on this box with wink.server.retarget (their own presence), and only the one that adopted it, or a screen on this box, may. Answers { owner }.",
      input: adoptInput,
      // No presence gate in front: the platform would turn a stranger away before this ran, and its relay device row would stay on the box.
      // The same rule is kept here: once there is an owner, a change needs the owner's fresh presence (meta0.presence) from the one that adopted it.
      run: async (input, meta0 = {}) => {
        owner(meta0, "adopting a server");
        // A scanner whose pairing is not yet confirmed arrives as `web:<id>` (the relay, BR-2); the adopter is recorded, and later compared, as the device it becomes: `device:<id>`.
        const caller = canonDevice(String((meta0 && meta0.caller) || "anonymous"));
        const prior = meta.get("owner"), adopter = meta.get("adopter");
        if (prior) {
          // Once there is an owner, a change needs the owner's fresh presence, and comes from the one that adopted it or from a screen on this box.
          // A refused device that is not the adopter leaves nothing behind: its relay device goes (after the refusal has been answered).
          const stranger = caller.startsWith("device:") && adopter !== caller;
          if (stranger) dropLater(caller);
          if (!meta0.presence) throw fail("presence_required", words("serverOwned", { owner: await ownerWords(prior) }));
          if (stranger) throw fail("denied", words("serverOwned", { owner: await ownerWords(prior) }));
        }
        else if (confirmAdopt && caller.startsWith("device:")) return firstAdopt(input, caller);
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
      db.prepare("UPDATE wink_devices SET removed_at = ?, sign_key = NULL WHERE id = 'self' AND removed_at IS NULL").run(now());
      ctx.events.emit("wink.server-released", {});
    };
    clearOwnerHook = clearOwner;
    ctx.tool("wink.server.release", {
      description: "On a server: let go of its owner. The app that adopted it calls this over the paired channel when the person removes the server there (the app has the owner's presence for the removal). Only the app that adopted this server may; anyone else is refused, and a person at this server uses wink.server.reset. Clears the owner, the adopter and the hand-over and keeps the server's own keys, so it can be paired again. Answers { released }.",
      input: obj(),
      run: async (_, meta0 = {}) => {
        owner(meta0, "letting a server go");
        const caller = String((meta0 && meta0.caller) || "anonymous");
        // an unowned server answers `already` to a paired device only: a stranger who can reach it must not learn that it is unowned (reviewer-3, LOW)
        if (!meta.get("owner")) { if (!caller.startsWith("device:")) throw fail("denied", "Only a device paired to this server may ask it to let go."); return { released: true, already: true }; }
        if (!caller.startsWith("device:") || meta.get("adopter") !== caller) throw fail("denied", words("releaseDenied", { owner: await ownerWords(meta.get("owner")) }));
        clearOwner();
        return { released: true };
      },
    });
    ctx.tool("wink.device.record", {
      internal: true,
      description: "What this module recorded when the owner confirmed a device: { id, kind, owner, confirmed, confirmedBy, confirmKeyId, key, hardware }, for the presence module to decide on a paired session. Only the presence module asks; null for a device the owner never confirmed.",
      input: obj({ id: str }, ["id"]),
      run: async (input, meta0 = {}) => {
        if (String((meta0 && meta0.caller) || "") !== "module:presence") throw fail("denied", "the device record is for the presence module");
        return devices.record(String(input.id));
      },
    });
    ctx.tool("wink.server.handover", {
      internal: true,
      description: "What this server was handed when it was adopted, to reach its home: { home, box, controlUrl, authKey, relay, space, device } (any may be missing), and the peer secret. The auth key joins the control plane and the peer secret proves this server to its home, so this answers only the Wink module itself, never another module, a person or a device, and never a caller that is not named. Answers { handover } or { handover: null }.",
      input: obj(),
      run: async (_, meta0 = {}) => {
        const c = String((meta0 && meta0.caller) || "");
        if (!c) throw fail("denied", "the hand-over is for the Wink module on this server");
        if (c !== "module:wink") throw fail("denied", "the hand-over is for the Wink module on this server");
        return { handover: ownHandover() };
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

    // A phone (DESIGN-wink section 4): a signed-in computer shows a QR and a long code (a long secret, one use, 5 minutes); the phone scans or pastes it; both show the same three
    // words made from both sides' keys; the person says yes on the computer. No yes in 5 minutes, a no, or wrong words: nothing is added and the phone is let go.
    // The typed code stays behind the development flag only.
    /** @type {null | { qr: string, art: string, until: number, claimed: boolean, seed: string }} the QR on show */
    let phoneTicket = null;
    /** @type {null | { device: string, name: string, fingerprint: string, words: string, choices: string[], until: number, state: "waiting" | "yes" | "no" | "expired", nb: string, commit: string, ticket: string, named: boolean }} the phone asking to be added */
    let phoneAsk = null;
    const phoneLive = () => {
      if (phoneAsk && phoneAsk.state === "waiting" && phoneAsk.until <= now()) { phoneAsk.state = "expired"; dropLater(`device:${phoneAsk.device}`); }
      return phoneAsk;
    };
    /** The name a phone gave itself, made safe to show: letters, digits and a few marks, at most 64 characters; nothing usable (or only a generic word) gives "". @param {unknown} x */
    const cleanPhoneName = x => { const n = String(x ?? "").replace(/[^\p{L}\p{N} ._@:'\u2019-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 64); return /^(a )?(device|phone|computer|unknown)$/i.test(n) ? "" : n; };
    /** Holds one phone for the person's yes: this module's own ticket (`ticket` is its secret) or a ring (no secret known here, so the words rest on the keys and both nonces). @param {any} p @param {string} ticket */
    const holdPhone = async (p, ticket) => {
      const id = String(p.id);
      const live = phoneLive();
      if (live && live.state === "waiting") { dropLater(`device:${id}`); return true; } // one phone at a time; the other is let go
      const until = now() + ASK_MS;
      const mine = phoneAsk = { device: id, name: cleanPhoneName(p.name) || "A phone", fingerprint: String(p.fingerprint || ""), words: "", choices: [], until, state: "waiting", nb: newNonce(), commit: "", ticket, named: false };
      if (o.pairWordsFor) { setWords(mine, await o.pairWordsFor(id)); ctx.events.emit("wink.pair-asked", { device: id, name: mine.name, choices: mine.choices, until, kind: "phone" }); }
      const t = setTimeout(() => { if (phoneAsk === mine) phoneLive(); }, Math.max(0, until - now()) + 5);
      if (t.unref) t.unref();
      return true;
    };
    /** The wink module hands every newly paired device here first. A phone that redeemed the QR on show is held for the person's yes (true); anything else is not this file's (false). @param {any} p */
    phone.hold = async p => {
      if (!phoneTicket || phoneTicket.claimed || phoneTicket.until <= now()) return false;
      phoneTicket.claimed = true;
      return holdPhone(p, phoneTicket.seed);
    };
    /** The old ring (relay.pair.ticket) pairs a phone with no words and no yes. Nothing is registered for it until the same three words are confirmed on this computer (a ring phone that cannot show words is let go after 5 minutes). @param {any} p */
    phone.holdRing = async p => holdPhone(p, "");
    ctx.tool("wink.phone.open", {
      description: "Add a phone. From a computer already signed in to you: show a QR and a long code (the same text, to scan or to paste on the phone), a long secret good for one phone and 5 minutes. Answers { qr, link, art, expires }: `art` is the QR drawn for the screen. The phone then shows three words and this computer asks you the same (wink.phone.pairing); say yes only if they match (wink.phone.pair.answer). A phone pairs to you only, never to a space. A short typed code is switched off in this release (`typed: true` is refused unless the development flag VYRE_WINK_TYPED_CODE=1 is set).",
      input: obj({ space: str, typed: { type: "boolean" } }),
      presence: { summary: async () => "Show a code to add a phone" },
      run: async (input, meta = {}) => {
        owner(meta, "adding a phone");
        if (input.space) throw fail("identity_only", words("phoneIdentityOnly"));
        if (input.typed === true) {
          if (!typedOn()) throw fail("typed_code_off", words("typedCodeOff"));
          const c = await o.openCode("W1");
          return { ...c, qr: qrPayload(c.code, await o.relayUrl()) };
        }
        if (phoneTicket && !phoneTicket.claimed && phoneTicket.until > now()) return { qr: phoneTicket.qr, link: phoneTicket.qr, art: phoneTicket.art, expires: phoneTicket.until };
        const seed = crypto.randomBytes(16);
        const t = /** @type {any} */ (await mint(seed, "phone"));
        if (!t || t.error) throw fail("unavailable", words("offline"));
        const qr = phoneQrPayload(seed, await o.relayUrl());
        phoneTicket = { qr, art: qrArt(qr), until: now() + 5 * 60_000, claimed: false, seed: b64url(seed) };
        phoneAsk = null;
        return { qr, link: qr, art: phoneTicket.art, expires: phoneTicket.until };
      },
    });
    ctx.tool("wink.phone.scan", {
      description: "On the phone: read the QR the computer shows, or the long code pasted (`payload`). Answers { pairing, ack: null, expires }: wink.pair.status then says `confirm` with `words`: show them, and the person says yes on the computer only if they match. No yes in 5 minutes adds nothing. A phone only pairs to the person's own identity. A short typed code is refused unless the development flag VYRE_WINK_TYPED_CODE=1 is set.",
      input: obj({ payload: str, code: str, target: obj({ kind: str, id: str }) }),
      run: async (input, meta = {}) => {
        owner(meta, "adding this phone");
        // a typed code is switched off: say so plainly, not "payload is required"
        if (input.payload === undefined && input.code !== undefined && !typedOn()) throw fail("typed_code_off", words("typedCodeOff"));
        if (input.payload === undefined && input.code === undefined) throw fail("bad_input", words("notACode"));
        const text = String(input.payload !== undefined ? input.payload : input.code);
        const scan = parsePhoneQr(text);
        const q = scan ? null : parseQr(text);
        if (!scan && !q) throw fail("bad_input", words("notACode"));
        if (q && !typedOn()) throw fail("typed_code_off", words("typedCodeOff"));
        const identity = await o.identity();
        const target = await checkTarget(identity, "phone", input.target || { kind: "identity", id: identity });
        const label = (await targets(identity)).find(x => x.kind === target.kind && x.id === target.id)?.label;
        // With no target the phone joins the identity of whoever shows the code: say whose name that is, never the phone's own local identity.
        const shown = input.target ? { ...target, ...(label ? { label } : {}) } : { kind: "identity", label: label || "you" };
        const via = scan ? { seed: scan.seed, relay: scan.relay || undefined } : { code: /** @type {any} */ (q).code, relay: /** @type {any} */ (q).relay || undefined };
        return { ...(await startTyping({ ...via, kind: "phone", target, label })), target: shown };
      },
    });
    ctx.tool("wink.phone.pairing", {
      description: "On the computer showing the QR: is a phone asking to be added right now? Answers { asking: false } or { asking: true, name, choices, until, line }: `choices` are three sets of three words, one of them what the phone shows and two decoys in an order made fresh for this pairing, and `line` the question to put to the person (answer with wink.phone.pair.answer).",
      input: obj(),
      run: async (_, meta = {}) => {
        owner(meta, "the phone question");
        const a = phoneLive();
        if (!a || a.state !== "waiting" || !a.words) return { asking: false };
        return { asking: true, name: a.name, choices: a.choices, until: a.until, line: words("phoneAsk", { name: a.name, choices: a.choices }) };
      },
    });
    ctx.tool("wink.phone.pair.answer", {
      description: "On the computer: answer the phone question. { yes: false } sends it away and adds nothing. { yes: true } needs the words check: give `pick` (1, 2 or 3, the choice that matches the three words the phone shows) or `words` (all three, typed). A bare yes is refused and adds nothing; a wrong pick or words is a no. Answers { answered, yes, name, device? } or { answered: false } when nobody is asking (or the time ran out).",
      input: obj({ yes: { type: "boolean" }, pick: { type: "integer" }, words: str }, ["yes"]),
      presence: { summary: async () => "Add a phone to you" },
      run: async (input, meta = {}) => {
        owner(meta, "the phone answer");
        const a = phoneLive();
        if (!a || a.state !== "waiting" || (!a.words && input.yes === true)) return { answered: false };
        let wrong = false;
        if (input.yes === true) {
          const j = judgeWords(a, input);
          if (j === "bare") throw fail("words_needed", words("pairPick"));
          wrong = j === "wrong";
        }
        if (input.yes !== true || wrong) {
          a.state = "no";
          dropLater(`device:${a.device}`);
          ctx.events.emit("wink.pair-answered", { yes: false, kind: "phone" });
          return { answered: true, yes: false, name: a.name, ...(wrong ? { reason: words("phoneWrongWords") } : {}) };
        }
        const identity = await o.identity();
        const dev = devices.add({ id: a.device, identity, kind: "phone", name: a.name, fingerprint: a.fingerprint, target: { kind: "identity", id: identity } });
        // the relay makes the device only now (X-1); if it will not, nothing stays here either
        /** @type {any} */ let confirmed = null;
        try { confirmed = await confirmPending(a.device, true); }
        catch (e) { devices.remove(a.device); a.state = "no"; dropLater(`device:${a.device}`); throw e; }
        a.state = "yes";
        await openPairedSession(a.device, identity, meta.presence, confirmed);
        ctx.events.emit("wink.pair-answered", { yes: true, kind: "phone" });
        ctx.events.emit("wink.joined", { device: dev.id, flow: "W1", kind: "phone" });
        return { answered: true, yes: true, name: a.name, device: dev.id };
      },
    });
    ctx.tool("wink.phone.wait", {
      callers: ["web"],
      description: "From the phone that scanned the QR, over its own paired connection: where the question stands, and the way the three words are made. The phone sends `commit` (the hash of its fresh nonce) and its own `name`, hears this computer's nonce `nb`, then sends `reveal` (its nonce); the words appear only then. Answers { state: waiting | yes | no | expired, nb, words?, until }. Only that phone gets an answer.",
      input: obj({ commit: str, reveal: str, tag: str, name: str }),
      run: async (input, meta = {}) => {
        owner(meta, "the phone's wait");
        const a = phoneLive();
        if (!a || canonDevice(String((meta && meta.caller) || "")) !== `device:${a.device}`) throw fail("denied", words("phoneNotYours"));
        const i = input || {};
        if (!a.named && i.name) { const n = cleanPhoneName(i.name); if (n) a.name = n; a.named = true; }
        if (a.state === "waiting" && !a.words) {
          if (!a.commit && /^[0-9a-f]{64}$/.test(String(i.commit || ""))) a.commit = String(i.commit);
          if (a.commit && typeof i.reveal === "string" && i.reveal) {
            if (!/^[0-9a-f]{32}$/.test(i.reveal) || (await nonceCommit(i.reveal)) !== a.commit) { a.state = "no"; dropLater(`device:${a.device}`); throw fail("denied", words("phoneMismatch")); }
            setWords(a, await pairWords(await boxKey(), a.device, { ticket: a.ticket, nonceA: i.reveal, nonceB: a.nb }));
            ctx.events.emit("wink.pair-asked", { device: a.device, name: a.name, choices: a.choices, until: a.until, kind: "phone" });
          }
        }
        return { state: a.state, nb: a.nb, ...(a.words ? { words: a.words } : {}), until: a.until };
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

  /** Lets a waiting pairing go: the relay closes its channels and forgets it (relay.devices.drop answers for a device that never existed). @param {string} device */
  const dropPending = async device => { if (typeof ctx.call === "function") await ctx.call("relay.devices.drop", { id: String(device) }); };
  return { devices, endPairedNow, targets, checkTarget, phone, computeAllowed, compute, dropPending, tools: () => { tools(); startRetries(); }, startTyping, pending, peers, meta, clearOwner: () => clearOwnerHook(), releaseServer, retryReleases, stop, ownHandover: () => ownHandover() };
}

/** The QR a computer shows for a phone: the code and where to meet. @param {string} code @param {string} relay */
export const qrPayload = (code, relay) => `vyre://wink/1?c=${encodeURIComponent(code)}&r=${encodeURIComponent(relay)}`;
/**
 * The QR a new server shows for a phone or app to scan: the 16-byte secret of a ticket already at the relay (128 bits, so no PAKE is needed
 * and nothing is typed) and where to meet. Version 2 of the payload; the typed code's QR (version 1, above) carries a code instead.
 * @param {Uint8Array} seed @param {string} relay
 */
export const serverQrPayload = (seed, relay) => `vyre://wink/2?t=${b64url(seed)}&r=${encodeURIComponent(relay)}`;
/** The QR a computer shows for a phone: the same long secret as a server's, marked for a phone so a server's QR is not taken for one. @param {Uint8Array} seed @param {string} relay */
export const phoneQrPayload = (seed, relay) => `vyre://wink/2?t=${b64url(seed)}&r=${encodeURIComponent(relay)}&k=phone`;
/** Reads a phone QR: { seed, relay } or null (a server's QR is not one). @param {string} s @returns {{ seed: Uint8Array, relay: string } | null} */
export function parsePhoneQr(s) {
  const m = /^vyre:\/\/wink\/2\?(.*)$/.exec(String(s).trim());
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const seed = unb64url(q.get("t") || "");
  return q.get("k") === "phone" && seed && seed.length === 16 ? { seed, relay: q.get("r") || "" } : null;
}
/** Reads a server's QR payload: { seed, relay } or null. @param {string} s @returns {{ seed: Uint8Array, relay: string } | null} */
export function parseServerQr(s) {
  const m = /^vyre:\/\/wink\/2\?(.*)$/.exec(String(s).trim());
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  if (q.get("k") === "phone") return null;
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
