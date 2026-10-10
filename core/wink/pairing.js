// @ts-check
// pairing: devices belong to the IDENTITY, never to spaces (team/0.3/DESIGN-wink.md sections 3, 4 and 7).
//
//   Registry     wink_devices: one row per device, keyed by the identity that holds it, with a kind (phone, computer, server, storage)
//                and per-device offers. A server or storage device may be owned by a space its identity administers. A device is never a
//                member of a space, but it is enrolled per space (ruling 4 Oct, DESIGN-spaces-first section 3): the spaces module keeps each
//                device's list (spaces.devices.set at pairing, every space pre-ticked; spaces.devices.enrolled is what the kernel asks), and a
//                device not enrolled in a space gets no chain for it.
//   Targets      wink.pair.targets: "Pair to:" choices, the identity plus the spaces the person administers (read through the
//                directory port below: the kernel's memberships and roles, or a fake until the real directory is merged).
//   Pairing      two ways: scan a QR, or paste the long code; both confirmed by the same three words. A phone pairs to
//                the identity only. wink.pair.server (the app scans the server's QR or takes its pasted long code), wink.server.code / wink.server.adopt
//                (the server's side), wink.phone.open / wink.phone.scan (QR or paste, three words on both sides, a yes on the computer); the typed code is on by default, with a kill switch.
//   Compute      wink.offer.set and computeAllowed: a computer's compute reaches a space only when the space allows it AND the member
//                accepts (DESIGN-wink section 7).
// The module wiring (index.js) owns the Wink code state machine and hands this file the pieces it needs.

import crypto from "node:crypto";
import { deviceIdOf } from "../../lib/caller.js";
import { withinOrThrow } from "../../lib/within.js";
import { ROLE_IDS } from "../../kernel/contracts/index.js";
import { typeWinkCode, finishJoin } from "../../relay/client/join.js";
import { parseCode, b64url, unb64url } from "../../relay/client/code.js";
import { codeToAvatarBytes } from "../../relay/client/avatarcode.js";
import { qrArt } from "../../relay/client/qr.js";
import { pairWords, nonceCommit, ticketTag, newNonce } from "../../relay/client/pairwords.js";
import { connect as relayConnect, resolveTicket } from "../../relay/client/client.js";
import { nodeCrypto, fileKeyStore } from "../../relay/client/nodecrypto.js";
import { WORDS as WORDLIST } from "../../relay/client/words.js";
import { verifyDevice } from "./node/peer-wire.js";
import { verifyWith } from "../../kernel/identity/chain.js";
import { base32 } from "./grants.js";
import { words, removed } from "./cards.js";
import { createServerLinks } from "./serverlink.js";
import { directKey } from "./directkey.js";
import { p256 } from "@noble/curves/p256";
import { deviceKey } from "./devicekey.js";
import { presenceKeyFor } from "./presence-key.js";
import { isReleaseBuild, devKindSwitch } from "./buildkind.js";
import { httpFetch } from "../../lib/http.js";

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const sha = (/** @type {string} */ s) => crypto.createHash("sha256").update(s).digest();
const str = { type: "string" };
const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });

export const KINDS = Object.freeze(["phone", "computer", "server", "storage", "web"]);
/** The callers that are a person at this machine: the question of an unowned server is shown and answered on these only (Q-2). */
export const PERSON_SURFACES = Object.freeze(["cli", "local", "deck", "capsule"]);
/** What the app signs to prove it is the identity an unattended server was installed for (Q-3): this pairing's box and device, nothing a stranger could reuse. @param {string} box @param {string} device */
/** What the identity key signs for a pairing: this box and this relay device, and (PI-3) this pairing's own ticket tag, so a proof is good for one pairing only. @param {string} box @param {string} device @param {string} [tag] */
export const pairToMessage = (box, device, tag) => Buffer.from(`vyre-wink-pair-to-v1\n${box}\n${device}${tag ? `\n${tag}` : ""}`, "utf8");
const SPKI_P256 = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
/** The Secure Enclave key's ECDSA P-256 signature (raw r||s or DER) over a message; `enclave` is the raw uncompressed point, base64url. @param {string} enclave @param {Buffer} msg @param {string} esig */
const verifyEnclave = (enclave, msg, esig) => {
  try {
    const pt = Buffer.from(String(enclave), "base64url");
    if (pt.length !== 65 || pt[0] !== 4) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_P256, pt]), format: "der", type: "spki" });
    const sig = Buffer.from(String(esig), "base64url");
    return crypto.verify("sha256", msg, { key, dsaEncoding: sig.length === 64 ? "ieee-p1363" : "der" }, sig);
  } catch { return false; }
};
/** What each kind of device may offer (DESIGN-wink section 3). */
export const KIND_OFFERS = Object.freeze({ web: ["access"], phone: ["access"], computer: ["access", "compute"], server: ["access", "compute", "storage"], storage: ["storage"] });
/** The kind each typed-code flow adds (W1 a phone, W2 a computer, W3 a server). */
export const FLOW_KIND = Object.freeze({ W1: "phone", W2: "computer", W3: "server" });
/** Roles that may add a server or storage device to a space. */
export const ADMIN_ROLES = Object.freeze(["owner", "admin"]);
/**
 * What an offered device entry may carry beyond its key and label, copied into the entry the identity list takes: `agree` (its key-agreement point), `enclave` (its chip key) and `held: "web"` (a key a
 * page script can reach, so the entry cannot change who speaks for the identity). The chain validates each one's shape; nothing else is copied, and a `held` that is not "web" or true is dropped.
 * @param {any} e @returns {{ agree?: string, enclave?: string, held?: "web", attest?: string }}
 */
/** Is this a real P-256 key-agreement point: 65 bytes, uncompressed, and ON the curve (noble's decoder throws off-curve), so a made-up point never reaches the identity list. @param {string} v */
const onCurve = v => { try { const b = Buffer.from(v, "base64url"); if (b.length !== 65 || b[0] !== 4 || b.toString("base64url") !== v) return false; p256.ProjectivePoint.fromHex(new Uint8Array(b)); return true; } catch { return false; } };

export const entryExtras = e => ({
  ...(e && typeof e.agree === "string" && onCurve(e.agree) ? { agree: e.agree } : {}),
  ...(e && typeof e.enclave === "string" && e.enclave ? { enclave: e.enclave.slice(0, 200) } : {}),
  ...(e && (e.held === "web" || e.held === true) ? { held: /** @type {"web"} */ ("web") } : {}),
  ...(e && typeof e.attest === "string" && e.attest && e.attest.length <= 16384 ? { attest: e.attest } : {}),
});
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
  // what the server VERIFIED about the owner proof that paired this device ("enclave, unattested", "software"): the strength of the sessions it opens, never the app's own claim about its key storage
  `ALTER TABLE wink_devices ADD COLUMN proof_strength TEXT`,
  // the identity entry's enclave key (uncompressed P-256 point, base64url) the server verified at pairing: a sign-in signed by it proves the session's enclave strength
  `ALTER TABLE wink_devices ADD COLUMN enclave_key TEXT`,
  // which entry on the identity's list held that enclave key and under which Vyre name the list is read, and whether a check found the entry gone or revoked (the device must be paired again)
  `ALTER TABLE wink_devices ADD COLUMN enclave_eid TEXT`,
  `ALTER TABLE wink_devices ADD COLUMN vyre_name TEXT`,
  `ALTER TABLE wink_devices ADD COLUMN needs_repair INTEGER NOT NULL DEFAULT 0`,
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
 * @typedef {{ typist?: typeof typeWinkCode, finish?: typeof finishJoin, resolve?: typeof resolveTicket, mint?: (seed: Buffer) => Promise<any>, adopt?: (paired: any, target: { kind: string, id: string }) => Promise<boolean> }} Ports
 */

/**
 * @param {{ ctx: any, now: () => number, identity: () => Promise<string>, space: () => Promise<string>, directory: Directory, ports?: Ports,
 *   openCode: (flow: "W1" | "W2" | "W3" | "W5", carry?: any) => Promise<{ offer: string, code: string, expires: number }>,
 *   ack: (offer: string, typed: string) => Promise<{ ok: boolean }>, owner: (meta: any, what: string) => void, relayUrl: () => Promise<string>, keyFile?: string, spaceNow?: () => string,
 *   handover?: Handover, releaseMs?: number, dropMs?: number, releaseRetryMs?: number, releaseMaxMs?: number,
 *   looseOwnerIds?: boolean (tests only: owner ids of any length, for fixtures with short made-up ids),
 *   vyreName?: (identity: string, claimed?: string) => Promise<string | null> | string | null,
 *   identityPin?: () => Promise<{ id: string, seq: number, head: string } | null> | { id: string, seq: number, head: string } | null,
 *   signIdentity?: (message: Buffer) => Promise<{ eid: string, sig: string } | null> | { eid: string, sig: string } | null,
 *   identityEntry?: (identity: string, eid: string) => Promise<{ eid: string, kind?: string, pub: string, identity?: string } | null | undefined> | { eid: string, kind?: string, pub: string, identity?: string } | null | undefined,
 *   serve?: (tool: string, input: any, from: string) => Promise<any>,
 *   confirmPending?: (device: string, trusted?: boolean) => Promise<any>,
 *   typedCode?: boolean | (() => boolean), typedDefault?: () => boolean, codeNow?: () => { code: string, expires: number, offer: string } | null, cancelCode?: () => void, confirmAdopt?: boolean, askMs?: number, askHoldMs?: number, askPollMs?: number, pairWordsFor?: (device: string) => Promise<string>,
 *   offers?: { get(space: string, device: string): { space_allows: number | boolean, member_accepts: number | boolean } | Promise<any>, set(space: string, device: string, side: "space" | "member", on: boolean): void | Promise<void> } }} o
 */
export function createPairing(o) {
  const { ctx, now, directory } = o;
  const db = ctx.store.db;
  const ports = { typist: typeWinkCode, finish: finishJoin, resolve: resolveTicket, ...(o.ports || {}) };
  const meta = {
    get: (/** @type {string} */ k) => { const r = /** @type {any} */ (db.prepare("SELECT v FROM wink_meta WHERE k = ?").get(k)); return r ? JSON.parse(r.v) : null; },
    set: (/** @type {string} */ k, /** @type {any} */ v) => { db.prepare("INSERT INTO wink_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(k, JSON.stringify(v)); },
    del: (/** @type {string} */ k) => { db.prepare("DELETE FROM wink_meta WHERE k = ?").run(k); },
  };
  /** Node's crypto and a key file under the box's home: the typing side has no IndexedDB. @type {any} */
  // This computer's own device key (P-256, software) is offered in every pairing hello, so a server it pairs can bind this computer's paired session to it; the same key signs the sign-in.
  const ownKey = o.keyFile && !o.signDevice ? (() => { try { return deviceKey(`${o.keyFile}.device`); } catch { return null; } })() : null;
  const stepMs = o.stepMs ?? 20_000;
  const pairOptions = o.keyFile ? { crypto: nodeCrypto(), keyStore: fileKeyStore(o.keyFile), ...(ownKey ? { presenceKey: ownKey.presenceKey } : {}) } : {};
  /** Pairings this device is typing for (secret seeds stay in memory). @type {Map<string, any>} */
  const pending = new Map();
  /** The phone flow's hold, set when the tools are registered: the module's device.paired handler asks it first. `holdRing` holds a ring (relay.pair.ticket) phone for the words, `boxTicketLive` says a QR this box printed is still open. @type {{ hold: (p: any) => Promise<boolean>, holdRing: (p: any) => Promise<boolean>, boxTicketLive: () => boolean }} */
  /** Set when the tools are registered: what reset.js calls to free the server. @type {() => void} */
  /** Set when the tools are registered: the relay says a waiting pairing's app went away and did not come back; its ask is dropped at once, so the next scanner is not told "busy". @type {(device: string) => void} */
  let abandonHook = () => {};
  let clearOwnerHook = () => { throw fail("not_ready", "the pairing tools are not registered"); };
  const phone = { hold: async () => false, holdRing: async () => false, boxTicketLive: () => false };
  /** The typed-back acks of this server's person, by the tag of the ticket the typed code's key made: the ack IS the owner's yes for the device that redeems that ticket (DESIGN-wink, the typed code: no three words). Single use. @type {Map<string, number>} */
  const typedAcks = new Map();
  const takeTypedAck = (/** @type {string} */ tag) => { for (const [k, until] of typedAcks) if (until <= now()) typedAcks.delete(k); const until = typedAcks.get(tag); if (until === undefined) return false; typedAcks.delete(tag); return true; };

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
    setEnclaveKey(id, key, eid = null, name = null) { db.prepare("UPDATE wink_devices SET enclave_key = ?, enclave_eid = ?, vyre_name = ?, needs_repair = 0 WHERE id = ? AND removed_at IS NULL").run(key ? String(key).slice(0, 200) : null, eid ? String(eid).slice(0, 64) : null, name ? String(name).slice(0, 253) : null, String(id)); },
    setNeedsRepair(id) { db.prepare("UPDATE wink_devices SET needs_repair = 1 WHERE id = ? AND removed_at IS NULL").run(String(id)); },
    setKeyStorage(id, storage) { db.prepare("UPDATE wink_devices SET key_storage = ? WHERE id = ? AND removed_at IS NULL").run(storage === "hardware" || storage === "software" ? storage : "unknown", String(id)); },
    /** What the presence module reads to decide on a paired session: only what this module itself recorded at the owner's confirm. Null for a device never confirmed, or removed. @param {string} id */
    record(id) {
      const r = /** @type {any} */ (db.prepare("SELECT * FROM wink_devices WHERE id = ? AND removed_at IS NULL").get(String(id)));
      if (!r || !r.confirmed_by) return null;
      return { id: r.id, kind: r.kind, owner: r.identity, confirmed: true, confirmedBy: r.confirmed_by, confirmKeyId: r.confirm_key || null, key: r.device_key ? JSON.parse(r.device_key) : null, hardware: r.hardware === 1, keyStorage: r.key_storage || "unknown", name: r.name || "a device", proofStrength: r.proof_strength || null, enclaveKey: r.enclave_key || null, enclaveEid: r.enclave_eid || null, vyreName: r.vyre_name || null, identity: r.identity };
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
  /** One step of a pairing, bounded: a step that does not answer in `stepMs` ends the call with words for the person and a log line naming the step. @template T @param {string} name @param {Promise<T>} p @returns {Promise<T>} */
  const stepOf = (name, p) => {
    /** @type {any} */ let timer;
    const limit = new Promise((_, rej) => { timer = setTimeout(() => { ctx.log(`wink: pairing is stuck at "${name}" (no answer in ${Math.round(stepMs / 1000)} s)`); rej(fail("unavailable", words("pairStuck", { step: name }))); }, stepMs); });
    return Promise.race([p, limit]).finally(() => clearTimeout(timer));
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
    // The personal space is the identity's own (the stand-in key of a build with no kernel) or the home's Space (the kernel's id); the member of the home's Space is its owner.
    const home = ctx.kernel && typeof ctx.kernel.space === "string" ? ctx.kernel.space : null;
    const personal = q.space === d.identity || (home !== null && q.space === home);
    const member = personal && home !== null && q.space === home && typeof ctx.kernel.owner === "string" ? ctx.kernel.owner : d.identity;
    if (!personal && !(await directory.memberships(d.identity)).some(m => m.space === q.space)) return { ok: false, reason: "its owner is not a member of that space" };
    const row = (await compute.get(q.space, q.device, { member, device_key: d.nodeKey || undefined })) || { space_allows: 0, member_accepts: 0 };
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
   * @param {any} paired @param {{ kind: string, id: string }} target @param {{ identity: string, peerSecret: string, device: string, ownerName?: string, handover?: any, seed?: Uint8Array, typedSeed?: Uint8Array, onConfirm?: (words: string, until: number) => void }} x */
  const adopt = async (paired, target, x) => {
    if (ports.adopt) return ports.adopt(paired, target, x);
    const hand = x.handover && typeof x.handover === "object" ? { ...x.handover, device: x.device } : { device: x.device };
    const vyre = typeof o.identityVyre === "function" ? await Promise.resolve(o.identityVyre()).catch(() => null) : null;
    // The head and length of the identity chain this computer last verified: a release server asks for it (PI-2) of whoever proves the identity, a computer as much as a phone
    const pin = typeof o.identityPin === "function" ? await Promise.resolve(o.identityPin()).catch(() => null) : null;
    const input = { owner: { ...target, ...(x.ownerName ? { name: String(x.ownerName).slice(0, 64) } : {}), ...(vyre ? { vyre: String(vyre) } : {}), ...(pin && pin.head ? { pin: { id: String(pin.id), seq: Number(pin.seq), head: String(pin.head) } } : {}) }, identity: x.identity, peerSecret: x.peerSecret, handover: hand, deviceKind: "computer", deviceName: String(ctx.config.name || "a computer").slice(0, 64) };
    // A server installed to pair to one identity asks for proof that this app IS that identity: a signature by a key on its list over this pairing's box and device (Q-3).
    if (typeof o.signIdentity === "function" && paired && paired.box && paired.device) {
      const sigTag = x.seed ? await ticketTag(b64url(x.seed)) : x.typedSeed ? await ticketTag(b64url(x.typedSeed)) : "";
      const sig = await Promise.resolve(o.signIdentity(pairToMessage(String(paired.box), String(paired.device), sigTag))).catch(() => null);
      if (sig && sig.eid && sig.sig) /** @type {any} */ (input).proof = { eid: String(sig.eid), sig: String(sig.sig), ...(sig.esig ? { esig: String(sig.esig) } : {}) };
    }
    // The three words are made from this pairing's own material (pairwords.js): the ticket secret, both keys and two fresh nonces. Commit then reveal: this app sends
    // sha256(its nonce) first, the server answers with its own nonce, then this app reveals its nonce, so neither side can pick a nonce after seeing the other's.
    const seed = x.seed ? b64url(x.seed) : "";
    const na = newNonce(), commit = await nonceCommit(na), tag = seed ? await ticketTag(seed) : "";
    // A pairing that came in by the typed code names that code's ticket in its own field (`typed_tag`), never in `tag`: a server that has the typed-ack rule reads it, an older one ignores it and asks the words as before
    const typedTag = x.typedSeed ? await ticketTag(b64url(x.typedSeed)) : "";
    const pair = (/** @type {any} */ more) => ({ ...input, pairing: { commit, ...(tag ? { tag } : {}), ...(typedTag ? { typed_tag: typedTag } : {}), ...more } });
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
    /** The identity-list-shaped entry a LIVE paired server of this home has on the direct door: its key is derived from the peer secret this home holds for it (core/wink/directkey.js), so only the server can sign. Null for anything else. @param {string} deviceId */
    directEntry(deviceId) {
      if (!peers.allow(deviceId)) return null;
      return { eid: String(deviceId), kind: "device", pub: directKey(peers.secretFor(String(deviceId))).pub };
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
    // the probe forgets a server the person removed: it answers `removed`, not whatever the old route still says
    if (r !== "unknown") { meta.set(`removed:${sid}`, now()); meta.del(`probe:${sid}`); }
    if (r === "released") { if (links) links.forget(sid); meta.del(`channel:${sid}`); meta.del(`paired:${sid}`); meta.del(`release:${sid}`); ctx.events.emit("wink.server-release", { device: sid, state: "released" }); return "released"; }
    meta.del(`channel:${sid}`); meta.del(`paired:${sid}`);
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
  let stopped = false;
  const stop = () => { stopped = true; if (retryTimer) clearInterval(retryTimer); retryTimer = null; if (links) { try { links.close(); } catch { /* closed */ } links = null; } };

  /** Keeps what the relay answered with, so a refusal can be told from a missing connection. */
  const watchFetch = () => {
    const f0 = httpFetch;
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
      /** The channel this pairing wrote and what was there before it: a pairing that fails after that gives it back, so no half-made pairing leaves a server this computer could later call. @type {{ sid: string, was: { channel: any, probe: any } } | null} */ let channelMade = null;
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
          try { ok = await adopt(pd, i.target, { identity, peerSecret, device: sid, ownerName: i.label, handover, seed: i.seed, ...(i.code && !i.seed ? { typedSeed: t.seed } : {}), onConfirm: (/** @type {string} */ w) => { if (p.state !== "confirm") { p.state = "confirm"; p.words = w; ctx.events.emit("wink.pair-confirm", { pairing: id, words: w }); } } }); }
          catch (e) { why = e; }
          p.adopted = ok === true;
          if (p.state === "confirm") p.state = "waiting";
          if (p.adopted) { const ch = channelOf(pd); if (links) links.forget(sid); if (ch) { channelMade = { sid, was: { channel: meta.get(`channel:${sid}`), probe: meta.get(`probe:${sid}`) } }; meta.set(`channel:${sid}`, ch); meta.set(`probe:${sid}`, ch); meta.del(`removed:${sid}`); ctx.events.emit("wink.server-paired", { device: sid }); } }
          if (!p.adopted) {
            // the server was not told: nothing is half-added, and the person is told what to do
            if (fresh) { devices.remove(fresh); p.device = null; }
            failWith("failed", adoptReason(name, why || new Error("no answer")));
            return;
          }
        }
        // A phone that scanned the computer's QR is only paired with it so far. It shows the same three words the computer shows and waits for the person's yes there; no yes pairs nothing.
        if (i.kind === "phone") {
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
        // the pairing is complete: only now is this server one this computer is paired to, and the newest such is the home
        if (channelMade) meta.set(`paired:${channelMade.sid}`, { at: now() });
        p.state = "done";
        ctx.events.emit("wink.pair-done", { pairing: id, kind: i.kind, target: i.target, ...(p.device ? { device: p.device } : {}) });
      } catch (e) {
        if (fresh) devices.remove(fresh);
        if (channelMade) { const { sid: cs, was } = channelMade; try { if (links) links.forget(cs); } catch { /* closed */ } if (was.channel) meta.set(`channel:${cs}`, was.channel); else meta.del(`channel:${cs}`); if (was.probe) meta.set(`probe:${cs}`, was.probe); else meta.del(`probe:${cs}`); channelMade = null; }
        failWith("failed", String(/** @type {Error} */ (e).message || "pairing failed")); ctx.log(`wink: pairing failed: ${/** @type {Error} */ (e).message}`); }
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
      if (typeof ctx.call !== "function") return false;
      const g = /** @type {any} */ (await ctx.call("presence.person.pair-grant", { device }));
      if (!(g && g.data && g.data.granted)) { ctx.log(`wink: no paired session for ${device}: ${g && g.error ? g.error.message : "refused"}`); return false; }
      return true;
    } catch (e) { ctx.log(`wink: no paired session for ${device}: ${/** @type {Error} */ (e).message}`); return false; }
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
      description: "Pair a new server (or storage device) from this app: give `payload`, the text of the QR the server printed (a scan, or the long code pasted), and choose where it goes. Answers { pairing, ack: null, expires }. The person at the server is then asked to confirm, and this app shows the same three words: wink.pair.status answers state `confirm` with `words` until they say yes there; no answer in 5 minutes pairs nothing. The short typed code works too (`code`: type the one the server shows, then the server asks for the code this app shows); it is refused only when the kill switch is set on this computer (VYRE_WINK_TYPED_CODE=0 or config wink.typedCode: false).",
      input: obj({ code: str, payload: str, target: obj({ kind: { type: "string", enum: ["identity", "space"] }, id: str }, ["kind", "id"]), kind: { type: "string", enum: ["server", "storage"] }, name: str }, ["target"]),
      presence: { summary: async () => "Add a server to Vyre" },
      run: async (input, meta = {}) => {
        owner(meta, "pairing a server");
        const kind = String(input.kind || "server");
        if (kind !== "server" && kind !== "storage") throw fail("bad_input", words("chooseTarget"));
        // Each step is bounded and named: a step that never answers ends this call with a plain reason in seconds (and one log line saying which step), never a silent minute and a half
        const identity = await stepOf("looking up your identity", o.identity());
        const target = await stepOf("checking where this server should go", checkTarget(identity, kind, input.target));
        const label = (await stepOf("listing your spaces", targets(identity))).find(x => x.kind === target.kind && x.id === target.id)?.label;
        const scan = input.payload ? parseServerQr(String(input.payload)) : null;
        if (input.payload && !scan) throw fail("bad_input", words("notACode"));
        if (!scan && !input.code) throw fail("bad_input", words("wrongCode"));
        if (!scan && !typedOn()) throw fail("typed_code_off", words("typedCodeOff"));
        const who = scan ? { seed: scan.seed, relay: scan.relay || undefined } : { code: String(input.code) };
        return { ...(await stepOf("starting the pairing", startTyping({ ...who, kind, target, label, name: input.name }))), target: { ...target, ...(label ? { label } : {}) } };
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
        return { state: p.state, kind: p.kind, ...(p.device ? { device: p.device } : {}), ...(p.reason ? { reason: p.reason } : {}), ...(p.invite ? { invite: p.invite } : {}), ...(p.kind === "invite" && p.state === "waiting" && p.ack ? { ack: p.ack } : {}), ...(p.state === "confirm" && p.words ? { words: p.words, message: words(p.kind === "phone" ? "phoneConfirm" : "pairConfirm", { words: p.words }) } : {}) };
      },
    });

    // ---- redeeming a typed code (RC1) ----
    // One tool for the typing side. `for: "invite"` (the default) runs the code's PAKE, shows the ack to type back on the inviter's device, and then reads the invitation's link out of the ticket's sealed record: the same
    // link the long form is, handed to spaces.invites.accept as before (the typed code adds no way in). `for: "phone" | "server" | "storage"` is wink.phone.scan / wink.pair.server with a typed code, unchanged.
    const REDEEM_MS = 10 * 60_000;
    ctx.tool("wink.code.redeem", {
      description: "Use a typed Wink code (WINK-NNPP-PPPP). Answers { pairing, ack, expires }: show `ack` ('type this on your other device'); the person types it there. Then wink.pair.status says `done`. For an invitation (`for` omitted or \"invite\") it carries `invite: { link }`, which goes to spaces.invites.accept like a pasted link. `for` phone, server or storage pairs this app with that device (target as in wink.pair.server). One try per code: a wrong code closes it. Codes last 10 minutes.",
      input: obj({ code: str, for: { type: "string", enum: ["invite", "phone", "server", "storage"] }, target: obj({ kind: { type: "string", enum: ["identity", "space"] }, id: str }), name: str }, ["code"]),
      presence: { summary: async () => "Use a code to join or add a device" },
      run: async (input, meta = {}) => {
        owner(meta, "using a code");
        if (!typedOn()) throw fail("typed_code_off", words("typedCodeOff"));
        const what = String(input.for || "invite");
        if (!parseCode(String(input.code))) throw fail("bad_input", words("wrongCode"));
        if (what === "phone" || what === "server" || what === "storage") {
          const identity = await o.identity();
          if (what !== "phone" && !input.target) throw fail("bad_input", words("chooseTarget"));
          const target = await checkTarget(identity, what, input.target || { kind: "identity", id: identity });
          const label = (await targets(identity)).find(x => x.kind === target.kind && x.id === target.id)?.label;
          return { ...(await startTyping({ code: String(input.code), kind: what, target, label, name: input.name })), target: { ...target, ...(label ? { label } : {}) } };
        }
        const relay = await o.relayUrl();
        const w = watchFetch();
        const t = await ports.typist({ relay, input: String(input.code), fetch: w.fetch });
        if (!t.ok) {
          if (w.seen.old) throw fail("relay_old", words("relayOld"));
          throw fail(t.reason === "format" ? "bad_input" : t.reason === "offline" ? "unavailable" : "refused", words(t.reason === "offline" ? "offline" : t.reason === "busy" ? "busy" : "wrongCode"));
        }
        const id = `pr_${base32(crypto.randomBytes(10), 16)}`;
        const p = /** @type {any} */ ({ id, state: "waiting", kind: "invite", target: null, expires: now() + REDEEM_MS, relay, device: null, reason: "", ack: t.ack });
        pending.set(id, p);
        ctx.events.emit("wink.pair-waiting", { pairing: id, kind: "invite" });
        const failWith = (/** @type {string} */ state, /** @type {string} */ reason) => { p.state = state; p.reason = reason; p.ack = null; ctx.events.emit("wink.pair-failed", { pairing: id, reason }); };
        // The ticket appears at the relay only after the right ack was typed back; poll until it does or the code's life ends. The sealed record is the box's own (checked by its MAC under the seed).
        void (async () => {
          while (!stopped && now() < p.expires && p.state === "waiting") {
            try {
              const r = await ports.resolve(t.seed, { relay, fetch: httpFetch });
              if (stopped) return;
              const inv = r && r.invite;
              if (!inv || inv.kind !== "space-invite" || typeof inv.link !== "string" || !/^https:\/\/[^\s]+$/.test(inv.link) || inv.link.length > 1500) { failWith("failed", words("wrongCode")); return; }
              p.invite = { link: inv.link, ...(typeof inv.space === "string" ? { space: inv.space.slice(0, 64) } : {}) };
              p.state = "done"; p.ack = null;
              ctx.events.emit("wink.pair-done", { pairing: id, kind: "invite" });
              return;
            } catch (e) {
              const c = /** @type {any} */ (e).code;
              if (stopped) return;
              if (c !== "ticket_gone" && c !== "rate_limited") { failWith("failed", c === "bad_record" || c === "contested" ? words("wrongCode") : words("offline")); return; }
            }
            await new Promise(res => { const h = setTimeout(res, o.pollMs ?? POLL_MS); if (h.unref) h.unref(); });
          }
          if (!stopped && p.state === "waiting") { p.state = "expired"; p.reason = words("codeExpired"); p.ack = null; }
        })();
        return { pairing: id, ack: t.ack, expires: p.expires };
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
      // With no typed code to fall back on, a relay that does not answer is said plainly and soon, not left to the CLI's own timeout (walk, 4 Oct)
      const unreachable = (/** @type {string} */ why) => (made && made.code ? { ...made, qr: null } : (() => { throw fail("unavailable", `This server cannot reach its relay${why ? ` (${why})` : ""}. Check its network, then run this again.`); })());
      try {
        /** @type {any} */ let h;
        const t = /** @type {any} */ (await Promise.race([mint(seed, "server"), new Promise(res => { h = setTimeout(() => res({ error: "no answer in 6 seconds" }), o.mintMs ?? 6000); })]).finally(() => clearTimeout(h)));
        if (!t || t.error) return unreachable(t && t.error ? String(t.error).slice(0, 80) : "");
        const qr = serverQrPayload(seed, await o.relayUrl());
        await rememberTicket(b64url(seed));
        // `expires` is the QR's life; with a typed code beside it, `code_expires` is the code's own (ten minutes, code.js), so a screen can say each
        return { ...made, qr, art: qrArt(qr), expires: now() + 5 * 60_000, ...(made && made.code ? { code_expires: made.expires, code_tries: made.tries } : {}) };
      } catch (e) { if (/** @type {any} */ (e).code === "unavailable") throw e; return unreachable(""); }
    };
    ctx.tool("wink.server.code", {
      description: "On the new server: make a pairing ticket good for 5 minutes and answer { qr, art, expires, code?, code_expires?, code_tries? }: `code` (with `code_expires`, ten minutes, and `code_tries`, the wrong tries that close it) is the short typed code when it is on and `qr: true` was asked for; `qr` is the text to paste into the Vyre app on a computer (the long code), and the same text drawn as a QR for a phone to scan is `art`; qr is null when the relay could not take the ticket. Scanning or pasting only gets the app talking to this server. The person at the server then confirms who is asking (wink.server.pairing shows it and the three words, wink.server.pair.answer says yes or no); no answer pairs nothing. `pairTo` (an identity id or name) is for an unattended install and is set only from this server's own command line (cli or local) at install time: only that identity can complete the pairing, no yes is asked, and the app must PROVE it is that identity with a signature by a key on that identity's list (naming it is not enough). The server also offers a short typed code (WINK-XXXX-XXXX, 10 minutes, three wrong tries, one use) beside the QR when `qr: true` is asked for: the app types it, shows a code, and the person types that back at the server (wink.server.confirm). `typed: true` is refused only when the kill switch is set (VYRE_WINK_TYPED_CODE=0 or config wink.typedCode: false).",
      input: obj({ qr: { type: "boolean" }, typed: { type: "boolean" }, pairTo: str }),
      run: async (input, meta = {}) => {
        owner(meta, "adding this server");
        const i = input || {};
        // an unowned server holds no device that matters: rows left by a pairing that never completed ownership must not refuse the new owner's pairing (first owner wins once it is owned)
        if (!hasOwner() && typeof ctx.call === "function") { try { await ctx.call("relay.devices.clear-leftover", {}); } catch { /* no relay module here */ } }
        if (i.typed === true && !typedOn()) throw fail("typed_code_off", words("typedCodeOff"));
        if (i.pairTo !== undefined) {
          if (!["cli", "local"].includes(String((meta && meta.caller) || ""))) throw fail("denied", "Who a server pairs to is set at install time, on the server itself.");
          const to = String(i.pairTo).trim();
          if (!to || to.length > 64 || /[\u0000-\u001f"\\]/.test(to)) throw fail("bad_input", "Name the identity to pair to by its id or its name.");
          meta0Set(to);
        }
        // The typed code is on by default (kill switch aside): its offer and short code are made, and the QR is added when asked for.
        const preferTyped = typeof o.typedDefault === "function" ? Boolean(o.typedDefault()) : typedOn();
        if (preferTyped && i.qr !== true && i.typed !== false) return o.openCode("W3");
        const made = preferTyped ? await o.openCode("W3") : {};
        return mintQr(made);
      },
    });
    const meta0Set = (/** @type {string} */ to) => { meta.set("pair_to", to); };
    // An app-led install (spec 0.3.0 part 10): the server was installed with a setup code its owner's app made. The app, once the words match, opens the setup channel (it alone holds the code's key) and asks
    // here for the pairing ticket, for ITS identity only: the same single-use ticket and the same identity proof as an install with --pair-to, so nobody is asked a yes at a terminal.
    ctx.tool("wink.server.setup-offer", {
      description: "Over the setup channel only: an unowned server installed with a setup code makes its pairing ticket for one identity and answers { qr, expires }. The app pairs with it and proves the identity; nothing is asked at the server.",
      input: obj({ identity: str }, ["identity"]),
      run: async (input, meta1 = {}) => {
        if (!/^setup:[a-z2-7]{16}$/.test(String((meta1 && meta1.caller) || ""))) throw fail("denied", "Only the setup page's or app's own channel can ask for this.");
        if (hasOwner()) throw fail("owned", "This server already belongs to someone.");
        const to = String((input && input.identity) || "").trim();
        if (!to || to.length > 64 || /[\u0000-\u001f"\\]/.test(to)) throw fail("bad_input", "Name the identity to pair to by its id.");
        if (typeof ctx.call === "function") { try { await ctx.call("relay.devices.clear-leftover", {}); } catch { /* no relay module here */ } }
        meta0Set(to);
        const made = await mintQr({});
        return { qr: made.qr, expires: made.expires };
      },
    });

    const hasOwner = () => Boolean(meta.get("owner"));
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
        if (!cur) {
          // released by its app, but the kernel keeps its owner (an identity's spaces are never handed on silently): the server is still owned, and says by whom
          const claimed = await claimedOwner().catch(() => null);
          if (!claimed) return { owned: false };
          return { owned: true, space: (await nameOf(claimed)) || "another Vyre identity", device: null, released: true, note: "The app that paired this server let go of it, but the server still belongs to that identity. The same identity can pair it again; to start over, reset the server at its console." };
        }
        const dev = deviceIdOf(by) !== null ? devices.get(/** @type {string} */ (deviceIdOf(by))) : null;
        return { owned: true, space: await ownerWords({ ...cur, identity: cur.identity }), device: (dev && dev.name) || (cur.name ? String(cur.name) : "device"), ...(meta.get("owner_proof") ? { owner_proof: String(meta.get("owner_proof")), owner_pin: String(meta.get("owner_pin") || "none") } : {}) };
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
      for (const k of ["home", "box", "controlUrl", "authKey", "relay", "route", "space", "device", "hostname", "peerAddr", "pin"]) if (typeof x[k] === "string" && x[k] && x[k].length <= 512 && !/[\u0000-\u001f]/.test(x[k])) out[k] = x[k];
      return Object.keys(out).length ? out : null;
    };
    /** Who an owner row names, in words. @param {any} cur */
    const ownerWords = async cur => {
      if (cur.kind === "space") {
        if (cur.name) return cur.name;
        try { const m = (await directory.memberships(cur.identity)).find(x => x.space === cur.id); if (m && m.name) return m.name; } catch { /* the directory may not know it */ }
        return "another space";
      }
      // an identity's own name, as the app sent it when it paired this server (never "You" or an id)
      return cur.name ? String(cur.name) : "Personal";
    };
    // ---- Q-1 (ruling, 4 Oct 2026): the first adoption of an unowned server by a paired device is CONFIRMED at the server ----
    // A scan or a paste only gets a device paired to this box (the ticket is single use). Becoming its owner is a second step: the device calls wink.server.adopt, the server
    // keeps that as one pending ask, shows who is asking and three words made from both sides' keys, and waits for yes from a person at the server (a local screen or the
    // installer's terminal). No answer in `askMs` pairs nothing. A server installed unattended was told up front who may complete it (`pairTo`, set by wink.server.code):
    // only that identity completes, and no yes is asked. One ask at a time: a second device is refused while one is pending.
    const ASK_MS = o.askMs ?? 5 * 60_000, HOLD_MS = o.askHoldMs ?? 15_000;
    const ENROL_MS = o.enrolMs ?? 3 * 60_000;
    const confirmAdopt = o.confirmAdopt !== false;
    // the development switch lets the older real-daemon tests pair with no proof; a release build ignores it
    const needProof = o.requireProof ?? (confirmAdopt && !devKindSwitch(process.env.VYRE_TEST_PAIR_NO_PROOF, o.buildRoot));
    /** @type {null | { caller: string, input: any, name: string, words: string, choices: string[], until: number, state: "waiting" | "yes" | "no", wake: Array<() => void>, nb: string, commit: string, ticket: string, proven?: string }} */
    let ask = null;
    const norm = (/** @type {unknown} */ x) => String(x ?? "").trim().toLowerCase();
    /** The name the person sees for who is asking: the target's own name from the app, else the identity's id. @param {any} input */
    // What the person at the server reads for who is asking (lead ruling, 4 Oct): the display name the app sent, then the claimed Vyre name, the one thing a stranger cannot fake (the directory
    // answers it for the identity id: `o.vyreName`): `Alex (alex.vyre.run)`. No Vyre name known: the display name with the short id, `Alex (id aaaaaa)`. A look-alike display name (letters of
    // more than one script) is dropped: the Vyre name alone, or the short id alone. Never a raw `per_` id. The three words stay the real proof.
    /** A name as the app sent it, reduced to letters, digits, space and . _ @ : - (no control, no bidi mark, no escape): what is shown at the server AND what is stored (reviewer-3 SP-2). @param {unknown} n @param {number} [max] */
    const cleanName = (n, max = 48) => String(n || "").replace(/[^\p{L}\p{N} ._@:-]/gu, "").replace(/ {2,}/g, " ").trim().slice(0, max);
    const SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u, /\p{Script=Arabic}/u, /\p{Script=Hebrew}/u, /\p{Script=Han}/u, /\p{Script=Hangul}/u, /\p{Script=Devanagari}/u, /\p{Script=Armenian}/u, /\p{Script=Georgian}/u];
    const mixedScript = (/** @type {string} */ t) => SCRIPTS.filter(r => r.test(t)).length > 1;
    const askNameOf = async (/** @type {any} */ input) => {
      const display = cleanName(input.owner && input.owner.name);
      const id = String(input.identity || (input.owner && input.owner.id) || "");
      const tag = id.replace(/^[a-z]+_/, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 6);
      /** @type {string | null} */ let vyre = null;
      if (typeof o.vyreName === "function" && id) { try { const v = await o.vyreName(id, String((input.owner && input.owner.vyre) || "") || undefined); if (typeof v === "string" && /^[a-z0-9.-]{3,253}$/.test(v)) vyre = v; } catch { vyre = null; } }
      const ok = display && !mixedScript(display);
      if (vyre) return ok ? `${display} (${vyre})` : vyre;
      const short = tag ? `id ${tag}` : "";
      return ok ? (short ? `${display} (${short})` : display) : (short || "someone");
    };
    /**
     * Q-3: an unattended install named one identity (`pairTo`), and completing the pairing needs PROOF that the one asking is that identity, never a claim. Everything the caller
     * supplies about itself (identity, owner.id, owner.name) is a claim and is ignored here. The proof is a signature by a key on that identity's list over this pairing's box and
     * relay device (pairToMessage), checked against the entry the identity port reads live. Answers the identity the proof speaks for.
     * @param {string} to @param {any} input @param {string} caller @returns {Promise<string>}
     */
    /** How each pairing's owner proof was held, by caller, until adoption records it: an enclave key whose attestation the server did not verify says so (never "hardware"), or a software key (development builds only). @type {Map<string, "enclave, unattested" | "software">} */
    const proofKinds = new Map();
    /** The enclave key (uncompressed point), the entry id and the Vyre name of the identity entry whose Face ID signature checked out, by caller, until adoption records it on the device. @type {Map<string, { key: string, eid: string, name: string | null }>} */
    const enclaveKeys = new Map();
    /** @type {Map<string, "given" | "none">} */
    const pinKinds = new Map();
    const proveIdentity = async (to, input, caller, open = false) => {
      const pr = input && input.proof && typeof input.proof === "object" ? input.proof : null;
      // a server installed with no pair-to is not waiting for anyone: its refusals say what was missing, not whom it waits for
      const shownName = String((input && input.owner && input.owner.name) || to).slice(0, 48);
      if (!pr || typeof pr.eid !== "string" || typeof pr.sig !== "string" || pr.eid.length > 64 || pr.sig.length > 1200) throw fail(open ? "denied_no_proof" : "denied", words(open ? "pairNeedsIdentity" : "pairNeedsProof"));
      if (typeof o.identityEntry !== "function") throw fail("denied", words("pairCannotProve"));
      // A fresh server has never seen this identity's chain: the app says the Vyre name it claims (`owner.vyre`) and the port reads that name's chain from the names directory, pinned and verified, and
      // keeps it only if the chain is the claimed id's. The directory out of reach is its own answer, never a "not them", and nothing is paired on a proof that could not be checked.
      const claimed = input.owner && typeof input.owner.vyre === "string" ? input.owner.vyre : undefined;
      const pin = input.owner && input.owner.pin && typeof input.owner.pin === "object" ? input.owner.pin : undefined;
      const e = await Promise.resolve(o.identityEntry(to, pr.eid, claimed, pin)).catch((/** @type {any} */ err) => { if (err) ctx.log(`wink: the identity lookup for ${to} failed (${err.code || "error"}): ${String(err.message || "").slice(0, 200)}`); return err && err.code === "unreachable" ? { unreachable: true } : err && err.code === "refused" ? { refused: String(err.message || "") } : null; });
      if (e && e.refused) throw fail("unavailable", e.refused);   // the directory address was refused: the person is told why, not that the directory is out of reach
      if (e && e.unreachable) throw fail("unavailable", words("pairCannotCheckNow"));
      const notThem = () => fail(open ? "denied_wrong_proof" : "denied", words(open ? "pairNotProven" : "pairWrongIdentity", open ? { name: shownName } : { name: to }));
      if (!e || e.eid !== pr.eid || typeof e.pub !== "string") { ctx.log(`wink: the identity proof named an entry that ${to} does not have${claimed ? " in the directory" : ""}`); throw notThem(); }
      // PI-3: the open flow's message carries this pairing's own ticket tag, so a proof from an earlier pairing of the same device and box is no proof; a release build requires the tag
      // a typed code's ticket is named `typed_tag` (never `tag`: the server keeps no seed for it), and its proof binds to that tag as a scanned one binds to its own
      const tag = input.pairing && typeof input.pairing.tag === "string" ? input.pairing.tag : input.pairing && typeof input.pairing.typed_tag === "string" ? input.pairing.typed_tag : "";
      const release = o.releaseProof ?? isReleaseBuild(o.buildRoot);
      if (open && release && !tag) { ctx.log("wink: the identity proof carried no pairing tag"); throw notThem(); }
      // PI-2: on a release build the app always says which head and length of its own chain it last saw (the prover is a phone, which holds its chain); a development build may pair with no pin and says so
      if (open && release && !pin) throw fail("no_pin", words("pairNeedsPin"));
      const message = pairToMessage(await boxKey(), caller.slice(7), tag);
      // a --pair-to server also takes the older message with no tag (an installer made before the tag); the open flow never does
      // A passkey's signature is a WebAuthn assertion (a longer envelope the chain's own check reads), not a bare signature: the entry says which (alg, rp), the way the identity chain checks it.
      const sigOk = async (/** @type {Uint8Array} */ m) => (e.alg === "webauthn-es256" ? await verifyWith(e.pub, m, pr.sig, /** @type {any} */ ({ alg: e.alg, pub: e.pub, rp: e.rp })) : verifyDevice(e.pub, m, pr.sig));
      if (!(await sigOk(message)) && !(!open && tag && await sigOk(pairToMessage(await boxKey(), caller.slice(7))))) { ctx.log("wink: the identity proof's signature did not match this pairing"); throw notThem(); }
      if (open) {
        // PI-1: who owns a server speaks from a hardware-held key. A phone's entry carries `enclave` (its Secure Enclave key behind Face ID) and must add that key's signature over the same message; a browser-held
        // entry and a plain software key are accepted on a development build only; a passkey is accepted anywhere, which says so in wink.server.status (owner_proof: software).
        // A passkey is hardware-class: its assertion carries user presence AND verification, which the chain's check requires (kernel/identity/chain.js verifyWebAuthn), so it owns a server on a release build too (lead ruling 5 Oct).
        const passkey = e.alg === "webauthn-es256";
        const hardware = passkey || (Boolean(e.enclave) && e.held !== "web" && e.alg === undefined);
        if (hardware && !passkey && !(typeof pr.esig === "string" && verifyEnclave(e.enclave, message, pr.esig))) { ctx.log("wink: the identity proof lacks its Face ID signature"); throw notThem(); }
        if (!hardware && release) { ctx.log("wink: the identity proof came from a key that is not hardware-held"); throw fail("not_hardware", words("pairNotHardware")); }
        proofKinds.set(caller, hardware ? (passkey ? "passkey" : "enclave, unattested") : "software"); pinKinds.set(caller, pin ? "given" : "none"); if (hardware && !passkey) enclaveKeys.set(caller, { key: String(e.enclave), eid: String(e.eid), name: input.owner && typeof input.owner.vyre === "string" ? input.owner.vyre : null }); else enclaveKeys.delete(caller);
      }
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
    abandonHook = device => { const a = ask; if (a && a.caller === `device:${device}`) { ask = null; for (const w of a.wake) w(); } };
    const askLive = () => { if (ask && ask.until <= now()) { const a = ask; ask = null; expiredFor = a.caller; dropLater(a.caller); for (const w of a.wake) w(); } return ask; };
    /** Wakes the adopt call that is holding for an answer. */
    const answered = () => { const a = ask; if (a) for (const w of a.wake.splice(0)) w(); };
    /**
     * The identity that already took this home's owner place in the kernel (first owner wins), or null. The wink record alone does not say: a home whose person claimed an identity at its own
     * screen has an owner the pairing record never heard of. A build with no spaces module has none; any other failure to ask is a refusal, never a pass.
     */
    /** The Vyre name of the identity that owns this home, for the words a refusal says (null when it cannot be read). @param {string} id */
    const nameOf = async id => {
      try { const r = /** @type {any} */ (await ctx.call("spaces.identity.name-of", { id })); const n = r && r.data && typeof r.data.name === "string" ? r.data.name : null; return n; } catch { return null; }
    };
    const claimedOwner = async () => {
      /** @type {any} */ let r;
      try { r = await ctx.call("spaces.owner.claimed", {}); } catch (e) { r = { error: { code: String(/** @type {any} */ (e) && /** @type {any} */ (e).code || "failed") } }; }
      if (!r) return null;
      if (r.error) { if (r.error.code === "no_such_tool") return null; throw fail("unavailable", words("pairOwnerFailed")); }
      return r.data && typeof r.data.claimed === "string" ? r.data.claimed : null;
    };
    /** The presence key this device offered in its hello, as the home's sealing process takes it: a software key only from a computer that says it keeps it in software (the sealing process refuses it on a release-kind build), a hardware key only with the signer kind the device names. Anything else is not enrolled here. @param {string} device @param {any} confirmed @param {any} input */
    // presenceKeyFor: core/wink/presence-key.js
    /**
     * Device-first pairing (lead ruling, 4 Oct): the pick of the three words at the server IS the owner's confirmation of the device that asked. When the app says what it is (`deviceKind`: phone,
     * computer or web), the device is recorded as one of the owner's with that kind, its key storage as the app reported it, and its paired session is granted in the same act, so it can go
     * straight to pair-challenge and start-paired. A web device gets the session and nothing more. A failure here leaves the device paired with no session, never a failed pairing.
     * @param {string} device @param {any} input @param {string} identity @param {{ kind: string, id: string }} target @param {any} confirmed
     */
    const recordOwnerDevice = async (device, input, identity, target, confirmed, proven, proofKind = null, /** @type {{ key: string, eid: string, name: string | null } | null} */ enclaveKey = null) => {
      const kind = String(input.deviceKind || "");
      if (!["phone", "computer", "web"].includes(kind)) return false;
      let session = false;
      // The relay's own device event may have written a provisional row for this device (a phone, by the ring's flow; a server, by a typed code's flow, under the identity this box had before it had an owner) before this call knew its kind and owner: an unconfirmed row for this very device is replaced.
      try { const at = devices.get(device); if (at && !at.removed && (at.kind !== kind || at.identity !== identity) && !devices.record(device)) db.prepare("DELETE FROM wink_devices WHERE id = ? AND confirmed_by IS NULL").run(device); } catch { /* none */ }
      let row = null;
      try { row = devices.add({ id: device, identity, kind, name: cleanName(input.deviceName, 64) || "a device", target }); } catch (e) { ctx.log(`wink: could not record ${device} as the owner's device: ${/** @type {Error} */ (e).message}`); return false; }
      // The kernel decides who owns this home, and it decides BEFORE the device has a session or an enrolment (its row alone is made first, because the relay's own device event may already have written one that this call must agree with, and a refusal takes the row back). A refusal fails the pairing
      // (the caller takes the owner record back); it is never logged and carried on. Without a verified proof the home's owner is unchanged, and the early check in wink.server.adopt has already
      // refused a different claimed owner.
      if (proven) {
        // A phone or computer that offered a key and whose key could not be enrolled as the owner's presence key would pair and then never be able to approve anything: that is refused now, with the reason, not found out later.
        if (["phone", "computer"].includes(String(input.deviceKind || "")) && confirmed && typeof confirmed.key === "string" && !presenceKeyFor(device, confirmed, input)) {
          ctx.log(`wink: ${device} offered a key but did not say how it keeps it (storage: ${String(confirmed.storage || input.keyStorage || "not stated")}, signer: ${String(confirmed.signer || "not stated")}); nothing was paired`);
          try { devices.remove(device); } catch { /* none */ }
          throw fail("unavailable", "This device did not say how it keeps its key, so it could not be made your approving device and nothing was paired. Update Vyre on it and pair again.");
        }
        /** @type {any} */ let adopted;
        try { adopted = await ctx.call("spaces.owner.adopt", { person: identity, ...(input.owner && typeof input.owner.vyre === "string" ? { name: input.owner.vyre } : {}), ...(presenceKeyFor(device, confirmed, input) ? { presence_key: presenceKeyFor(device, confirmed, input) } : {}) }); } catch (e) { adopted = { error: { code: String(/** @type {any} */ (e) && /** @type {any} */ (e).code || "failed"), message: String(/** @type {any} */ (e) && /** @type {any} */ (e).message || "") } }; }
        if (adopted && adopted.error && adopted.error.code !== "no_such_tool") {
          ctx.log(`wink: the kernel refused ${identity} as this home's owner (${adopted.error.code}); nothing was paired`);
          try { devices.remove(device); } catch { /* none */ }
          throw fail(["owned_by_other", "already_adopted", "not_allowed", "forbidden"].includes(adopted.error.code) ? "owned_by_other" : "unavailable", words(["owned_by_other", "already_adopted", "not_allowed", "forbidden"].includes(adopted.error.code) ? "pairOwnedByOther" : "pairOwnerFailed", { name: await nameOf(await claimedOwner().catch(() => null) || "") }));
        }
      } else ctx.log(`wink: ${device} paired without a verified identity proof: the home's owner is unchanged`);
      try {
        if (input.keyStorage) devices.setKeyStorage(device, input.keyStorage);
        if (enclaveKey) devices.setEnclaveKey(device, enclaveKey.key, enclaveKey.eid, enclaveKey.name);
        // The first pairing of a server with no owner: nobody can give presence yet, so the grant needs none. What stands for the confirmation is the three-word pick at this server's own terminal
        // (this code runs only after it) and the verified identity proof. The key the paired session is bound to is the device's own presence key when it offered one, else this pairing itself.
        const pk = /** @type {any} */ (await ctx.call("relay.device.presence", { id: device }).catch(() => null));
        const keyId = pk && pk.data && pk.data.key ? String(pk.data.key) : `pairing:${device}`;
        // A ticket the relay did not gate (a server's typed code) was never confirmed through the relay's pending door, so its key comes from what the device offered in its hello.
        if (!(confirmed && confirmed.key) && pk && pk.data && typeof pk.data.public_key === "string") confirmed = { ...(confirmed || {}), key: pk.data.public_key, alg: pk.data.alg, storage: pk.data.storage };
        if (!(confirmed && confirmed.key)) ctx.log(`wink: ${device} offered no device key in its pairing hello (presenceKey: { public_key: P-256 SPKI base64url, alg: -7 }), so it cannot be given a paired session`);
        session = await openPairedSession(device, identity, { keyId }, { ...(confirmed || {}), ...(input.keyStorage && !(confirmed && confirmed.storage) ? { storage: input.keyStorage } : {}) });
        // (the home's owner was decided above, before this device had any row or session)
        const space = await Promise.resolve(o.space()).catch(() => "");
        if (space) await ctx.call("spaces.devices.enrolled", { device, space }).catch(() => null);
      } catch (e) { session = false; ctx.log(`wink: could not record ${device} as the owner's device: ${/** @type {Error} */ (e).message}`); }
      return session;
    };
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
          // A proof offered on a server with no --pair-to is checked too (SP-1): the claimed identity must be the one the key speaks for. No proof is the words check alone.
          // Becoming an owner always needs the proof (lead, 4 Oct, G-2): the three words confirm the DEVICE to the person here, the proof confirms the IDENTITY to this server. A missing proof, another
          // identity's, and a names directory out of reach each refuse in their own words, and nothing is owned. (`requireProof: false` is a unit-test seam.)
          else if (needProof || input.proof) {
            const claimed = input.owner && input.owner.kind === "identity" ? String(input.owner.id) : String(input.identity || "");
            if (!claimed) { dropLater(caller); throw fail("denied_no_proof", words("pairNeedsIdentity")); }
            if (typeof o.identityEntry !== "function") { dropLater(caller); throw fail("denied", words("pairCannotProve")); }
            try { proven = await proveIdentity(claimed, input, caller, true); } catch (e) { dropLater(caller); throw e; }
          }
          const fresh = !to && !o.pairWordsFor;
          // The owner typed back the ack of the typed code this device came in by: that is the yes, so no three words are asked (single use; the QR and long-code paths ask them)
          const typedYes = Boolean(pr.typed_tag) && takeTypedAck(String(pr.typed_tag));
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
          const w = fresh || to || typedYes ? "" : await wordsFor(caller.slice(7), { ticket, na: "", nb });
          const until = now() + ASK_MS;
          const mine = ask = a = { caller, input, name: await askNameOf(input), words: "", choices: [], until, state: to || typedYes ? "yes" : "waiting", wake: [], nb, commit: String(pr.commit || ""), ticket, ...(proven ? { proven } : {}) };
          if (w) setWords(mine, w);
          // no answer, no yes: the ask ends by itself and lets the app's relay device go, even when the app never calls again
          const timer = setTimeout(() => { if (ask === mine) askLive(); }, ASK_MS + 5);
          if (timer.unref) timer.unref();
          if (!to && !fresh && !typedYes) ctx.events.emit("wink.pair-asked", { device: caller.slice(7), name: mine.name, choices: mine.choices, until: mine.until });
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
        const confirmed = await confirmPending(caller.slice(7));
        // a proven identity is the owner's identity; what the caller said about itself is not
        // what the server verified about this pairing's owner proof (set when the proof checked out, before adoption consumes it)
        const ownerProofKind = proofKinds.get(caller) || null;
        const ownerEnclave = enclaveKeys.get(caller) || null; enclaveKeys.delete(caller);
        const adopted = await applyAdopt(mine.proven ? { ...mine.input, identity: mine.proven } : mine.input, caller, Boolean(meta.get("owner")));
        // `session` says whether the device now has its paired session, so an app does not wait for one that is not coming (G-3)
        /** @type {boolean} */ let session;
        // The kernel refusing the owner fails the whole pairing and takes back what applyAdopt wrote (the owner record, the adopter and its relay device)
        try { session = await recordOwnerDevice(caller.slice(7), mine.input, mine.proven || String(mine.input.identity || mine.input.owner.id), adopted.owner, confirmed, Boolean(mine.proven), ownerProofKind, ownerEnclave); } catch (e) { clearOwner(); throw e; }
        return { ...adopted, session };
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
    const applyAdopt = async (/** @type {any} */ input, /** @type {string} */ caller, additional = false) => {
      const t = { kind: String(input.owner.kind), id: String(input.owner.id) };
      // Another device of the owner the server already has: nothing about the owner, the adopter, the hand-over or the peer secret changes. Adopt never changes who owns a server.
      if (additional) { proofKinds.delete(caller); pinKinds.delete(caller); return { owner: t }; }
      // An owner is a person identity or a space, by its id's own shape; anything else is refused before it is stored or shown (reviewer-3 SP-1)
      const ident = String(input.identity || (t.kind === "identity" ? t.id : "") || await o.identity());
      const ownerName = cleanName(input.owner.name, 64);
      const first = !meta.get("owner") || !meta.get("adopter");
      meta.set("owner", { ...t, identity: ident, ...(ownerName ? { name: ownerName } : {}) });
      { const k = proofKinds.get(caller); if (k) { meta.set("owner_proof", k); meta.set("owner_pin", pinKinds.get(caller) || "none"); proofKinds.delete(caller); pinKinds.delete(caller); } else if (first) { meta.del("owner_proof"); meta.del("owner_pin"); } }
      if (first) meta.set("adopter", caller);
      if (input.peerSecret && /^[A-Za-z0-9_-]{20,80}$/.test(String(input.peerSecret))) meta.set("peer_secret", String(input.peerSecret));
      const h = cleanHandover(input.handover);
      if (h) meta.set("handover", h);
      devices.setSelf({ identity: ident, name: String(ctx.config.name || "this server"), target: t });
      meta.del("pair_to");
      ctx.events.emit("wink.server-adopted", { owner: t });
      return { owner: t };
    };
    const adoptInput = obj({ pairing: obj({ commit: str, reveal: str, tag: str, cancel: { type: "boolean" } }), owner: obj({ kind: { type: "string", enum: ["identity", "space"] }, id: str, name: str, vyre: str, pin: obj({ id: str, seq: { type: "integer" }, head: str }) }, ["kind", "id"]), identity: str, peerSecret: str, proof: obj({ eid: str, sig: str, esig: str }), deviceKind: { type: "string", enum: ["phone", "computer", "web"] }, deviceName: str, keyStorage: { type: "string", enum: ["hardware", "software"] }, handover: obj({ home: str, box: str, controlUrl: str, authKey: str, relay: str, route: str, space: str, device: str, hostname: str, peerAddr: str, pin: str }) }, ["owner"]);
    /** The adoption itself (wink.server.adopt's body). @param {any} input @param {any} meta0 */
    const adoptBody = async (input, meta0 = {}) => {
        owner(meta0, "adopting a server");
        // An owner is a person identity or a space, by its id's own shape; anything else is refused before it is asked about, stored or shown (reviewer-3 SP-1)
        if (!((o.looseOwnerIds === true ? (input.owner.kind === "identity" ? /^per_[a-z2-7]{1,26}$/ : /^spc_[a-z2-7]{1,26}$/) : (input.owner.kind === "identity" ? /^per_[a-z2-7]{26}$/ : /^spc_[a-z2-7]{12}([a-z2-7]{14})?$/))).test(String(input.owner.id))) throw fail("bad_input", "That is not an identity or space id. Pair again from the Vyre app.");
        // A scanner whose pairing is not yet confirmed arrives as `web:<id>` (the relay, BR-2); the adopter is recorded, and later compared, as the device it becomes: `device:<id>`.
        const caller = canonDevice(String((meta0 && meta0.caller) || "anonymous"));
        // First owner wins: a home whose kernel already has an owner is not paired by a different identity, whatever the pairing record says. This runs before any ask, ticket, relay device or session.
        const claimed = await claimedOwner().catch((/** @type {any} */ e) => { dropLater(caller); throw e; });
        const asked = String(input.identity || (input.owner.kind === "identity" ? input.owner.id : ""));
        if (claimed && asked && asked !== claimed) { dropLater(caller); throw fail("owned_by_other", words("pairOwnedByOther", { name: await nameOf(claimed) })); }
        const prior = meta.get("owner"), adopter = meta.get("adopter");
        if (prior) {
          // Adopt never changes who owns a server (handing it over is a separate act that needs the owner's presence and the new identity's accept): a different owner, whoever asks and whatever they hold,
          // is refused, and a refused device that is not the adopter leaves nothing behind.
          const sameOwner = String(input.owner.kind) === String(prior.kind) && String(input.owner.id) === String(prior.id) && (!asked || asked === String(prior.identity));
          if (!sameOwner) { if ((deviceIdOf(caller) !== null) && adopter !== caller) dropLater(caller); throw fail("owned_by_other", words("serverOwned", { owner: await ownerWords(prior) })); }
          // Another device of the same owner (a phone and a computer): it brings the owner's identity proof (checked against the directory like the first) and the person at the server picks the words.
          if (confirmAdopt && input.proof && typeof input.proof === "object" && (deviceIdOf(caller) !== null) && adopter !== caller) return firstAdopt(input, caller);
          // Once there is an owner, a change needs the owner's fresh presence, and comes from the one that adopted it or from a screen on this box.
          // A refused device that is not the adopter leaves nothing behind: its relay device goes (after the refusal has been answered).
          const stranger = (deviceIdOf(caller) !== null) && adopter !== caller;
          if (stranger) dropLater(caller);
          if (!meta0.presence) throw fail("presence_required", words("serverOwned", { owner: await ownerWords(prior) }));
          if (stranger) throw fail("denied", words("serverOwned", { owner: await ownerWords(prior) }));
        }
        else if (confirmAdopt && (deviceIdOf(caller) !== null)) return firstAdopt(input, caller);
        return applyAdopt(input, caller);
    };
    ctx.tool("wink.server.adopt", {
      callers: ["web"],
      description: "On a server that was just paired: record who it belongs to, an identity or a space { kind, id }, and the identity that paired it. Called by the pairing app over the paired channel. On a server with no owner the person at the server must say yes first (the server shows who asks and three words; no answer in 5 minutes pairs nothing): the call answers { pending, words, until } until then, and call it again to hear the result; a server installed with a named identity (pairTo) takes only that identity and asks no one. After that it cannot be repeated over the paired channel; the person changes the owner on this box with wink.server.retarget (their own presence), and only the one that adopted it, or a screen on this box, may. Answers { owner }.",
      input: adoptInput,
      // No presence gate in front: the platform would turn a stranger away before this ran, and its relay device row would stay on the box.
      // The same rule is kept here: once there is an owner, a change needs the owner's fresh presence (meta0.presence) from the one that adopted it.
      run: async (input, meta0 = {}) => {
        try { return await adoptBody(input, meta0); }
        catch (e) {
          // every pairing that does not finish says why in this server's log (the app only says "the pairing did not finish"); a question still waiting for the person's answer is not a refusal
          const c = /** @type {any} */ (e);
          if (c && !c.keepAsk && c.code !== "pending") ctx.log(`wink: a pairing from ${String((meta0 && meta0.caller) || "a device").slice(0, 40)} did not finish (${String(c.code || "failed").slice(0, 40)}): ${String(c.message || e).slice(0, 160)}`);
          throw e;
        }
      },
    });
    /** Takes a paired app's relay device off this box, so it no longer reaches it as an owner device. Waits a moment so the answer to the call that asked still travels. @param {any} caller */
    function dropLater(caller) {
      const c = String(caller || "");
      if (!(deviceIdOf(c) !== null) || typeof ctx.call !== "function") return;
      const id = /** @type {string} */ (deviceIdOf(c));
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
        if (!meta.get("owner")) { if (!(deviceIdOf(caller) !== null)) throw fail("denied", "Only a device paired to this server may ask it to let go."); return { released: true, already: true }; }
        if (!(deviceIdOf(caller) !== null) || meta.get("adopter") !== caller) throw fail("denied", words("releaseDenied", { owner: await ownerWords(meta.get("owner")) }));
        clearOwner();
        return { released: true };
      },
    });
    // Is the enclave key this device was paired with still on its identity's list? Read from the DIRECTORY (the list the person edits: a lost phone's entry is revoked there), cached for 10 minutes so a sign-in costs
    // one lookup per window. An entry that is gone, revoked or carries another key makes the device software and marks it as needing to be paired again; a directory that cannot be reached is software for this sign-in only
    // (nothing is remembered). Only the presence module asks.
    const LIVE_MS = 10 * 60_000;
    /** @type {Map<string, { ok: boolean, at: number }>} */ const liveCache = new Map();
    ctx.tool("wink.device.enclave-live", {
      internal: true,
      description: "For the presence module at a paired device's sign-in: does the enclave key this device was paired with still stand on its identity's list in the directory? { ok }. Cached for 10 minutes. When the entry is gone or revoked the device is marked as needing to be paired again.",
      input: obj({ device: str }, ["device"]),
      run: async (input, meta0 = {}) => {
        if (String((meta0 && meta0.caller) || "") !== "module:presence") throw fail("denied", "the enclave check is for the presence module");
        const id = String(input.device);
        const rec = devices.record(id);
        if (!rec || !rec.enclaveKey || !rec.enclaveEid || !rec.vyreName || !rec.owner) return { ok: false };
        const t = now();
        const hit = liveCache.get(id);
        if (hit && t - hit.at < LIVE_MS) return { ok: hit.ok };
        /** @type {any} */ let r;
        try { r = await ctx.call("spaces.identity.lookup", { name: rec.vyreName, id: rec.owner }); } catch { return { ok: false }; }
        if (!r || r.error) return { ok: false };
        const entries = r.data && Array.isArray(r.data.entries) ? r.data.entries : [];
        const ok = entries.some((/** @type {any} */ x) => x && x.eid === rec.enclaveEid && x.kind === "device" && x.enclave === rec.enclaveKey);
        liveCache.set(id, { ok, at: t });
        if (!ok) { devices.setNeedsRepair(id); ctx.events.emit("wink.device-needs-repair", { device: id }); }
        return { ok };
      },
    });
    ctx.tool("wink.device.record", {
      internal: true,
      description: "What this module recorded when the owner confirmed a device: { id, kind, owner, confirmed, confirmedBy, confirmKeyId, key, hardware }, for the presence module to decide on a paired session. Only the presence module asks; null for a device the owner never confirmed.",
      input: obj({ id: str }, ["id"]),
      run: async (input, meta0 = {}) => {
        const recordCallers = ["module:presence", "module:vyred", "module:approvals"];
        if (!recordCallers.includes(String((meta0 && meta0.caller) || ""))) throw fail("denied", "the device record is for the presence module and the daemon");
        const rec = devices.record(String(input.id));
        // `homeOwner`: this device's person is the one this server's own pairing record names as its owner (PW-1): a confirmed device of another member is a paired device, not the owner's.
        const own = meta.get("owner");
        return rec ? { ...rec, homeOwner: Boolean(own && typeof own.identity === "string" && own.identity === rec.owner) } : rec;
      },
    });
    ctx.tool("wink.server.probe", {
      effect: "read",
      description: "Call a server this device paired, with a read-only system.info over the channel it paired on, and say whether the server still answers this device: { reachable, ... }. After wink.remove the server has let this device go, so it answers { reachable: false, code } here. For checking that a removed device is really refused.",
      input: obj({ device: str }, ["device"]),
      run: async (input, meta0 = {}) => {
        owner(meta0, "probing a server");
        const chan = meta.get(`probe:${String(input.device)}`);
        if (!chan && meta.get(`removed:${String(input.device)}`)) return { reachable: false, code: "removed", message: "this server was removed from this device" };
        if (!chan || !chan.route) return { reachable: false, code: "unknown", message: "this device never paired a server by that id" };
        try {
          const r = await withinOrThrow(callServer({ relay: String(chan.relay || ""), route: String(chan.route), box: String(chan.box || "") }, "system.info", {}), 8000, () => Object.assign(new Error("no answer in 8 seconds"), { remote: "timeout" }));
          return { reachable: true, answered: Boolean(r) };
        } catch (e) { return { reachable: false, code: String((/** @type {any} */ (e)).remote || (/** @type {any} */ (e)).code || "refused"), message: String((/** @type {Error} */ (e)).message || "").slice(0, 200) }; }
      },
    });
    ctx.tool("wink.server.owner", {
      internal: true,
      description: "For the spaces and files modules: the identity this server's own pairing record names as its owner, { identity, kind, id, name? }, or null. Read only; it is how spaces.owner.adopt knows the identity came from the pairing and not from a caller.",
      input: obj(),
      run: async (_i, meta0 = {}) => {
        if (!["module:spaces", "module:files"].includes(String((meta0 && meta0.caller) || ""))) throw fail("denied", "this is for the spaces and files modules");
        const o2 = meta.get("owner");
        return o2 && typeof o2.identity === "string" ? { identity: o2.identity, kind: o2.kind, id: o2.id, ...(o2.name ? { name: o2.name } : {}) } : null;
      },
    });
    ctx.tool("wink.server.paired", {
      internal: true,
      description: "For the spaces module: is this device a server paired to this identity, and still paired? Answers { paired, name? }. Modules only, read only; it names no one else's devices.",
      input: obj({ device: str, identity: str }, ["device", "identity"]),
      run: async (input, meta0 = {}) => {
        if (!String((meta0 && meta0.caller) || "").startsWith("module:")) throw fail("denied", "this is for modules");
        const d = devices.list(String(input.identity)).find((/** @type {any} */ x) => x.id === String(input.device) && x.kind === "server");
        return d ? { paired: true, name: d.name } : { paired: false };
      },
    });
    ctx.tool("wink.server.channel", {
      internal: true,
      description: "For the spaces module: where a paired server is reached (relay, route and box id), so a space it hosts can say where its home is. Modules only, read only; it names no secret.",
      input: obj({ device: str, identity: str }, ["device", "identity"]),
      run: async (input, meta0 = {}) => {
        if (!String((meta0 && meta0.caller) || "").startsWith("module:")) throw fail("denied", "this is for modules");
        const d = devices.list(String(input.identity)).find((/** @type {any} */ x) => x.id === String(input.device) && x.kind === "server");
        const c = d ? meta.get(`channel:${d.id}`) : null;
        return c && c.route ? { channel: { relay: String(c.relay || ""), route: String(c.route), box: String(c.box || "") } } : { channel: null };
      },
    });
    ctx.tool("wink.server.owned", {
      internal: true,
      description: "Does this server have an owner yet (a device paired and was confirmed)? Answers { owned: boolean }, nothing else. Asked by the onboarding module, which refuses every sign-in and name before it is true.",
      input: obj(),
      run: async (_, meta0 = {}) => {
        const c = String((meta0 && meta0.caller) || "");
        if (!c.startsWith("module:")) throw fail("denied", "this is for the server's own modules");
        return { owned: Boolean(meta.get("owner") && meta.get("adopter")) };
      },
    });
    ctx.tool("wink.device.paired", {
      internal: true,
      description: "For the spaces module: is this device (of any kind) one of this identity's, still paired? Answers { paired, kind? }. Modules only, read only; it names no one else's devices.",
      input: obj({ device: str, identity: str }, ["device", "identity"]),
      run: async (input, meta0 = {}) => {
        if (!String((meta0 && meta0.caller) || "").startsWith("module:")) throw fail("denied", "this is for modules");
        const d = devices.list(String(input.identity)).find((/** @type {any} */ x) => x.id === String(input.device));
        return d ? { paired: true, kind: d.kind } : { paired: false };
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
        if ((deviceIdOf(caller) !== null) && meta.get("adopter") !== caller) throw fail("denied", "only the one that adopted this server may change its owner");
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
    // The typed code is on by default (kill switch: VYRE_WINK_TYPED_CODE=0 or wink.typedCode: false).
    /** @type {null | { qr: string, art: string, until: number, claimed: boolean, seed: string }} the QR on show */
    let phoneTicket = null;
    /** @type {null | { device: string, name: string, fingerprint: string, words: string, choices: string[], until: number, state: "waiting" | "yes" | "no" | "expired", nb: string, commit: string, ticket: string, named: boolean }} the phone asking to be added */
    let phoneAsk = null;
    const phoneLive = () => {
      if (phoneAsk && phoneAsk.state === "waiting" && phoneAsk.until <= now()) { phoneAsk.state = "expired"; dropLater(`device:${phoneAsk.device}`); }
      // the owner's app signs the list change for a phone and says so (wink.phone.enrolled); if it never does, the phone is told its key was not added, and stays paired
      if (phoneAsk && phoneAsk.state === "enrolling" && /** @type {any} */ (phoneAsk).enrolUntil <= now()) { /** @type {any} */ (phoneAsk).enrolled = false; /** @type {any} */ (phoneAsk).enrolReason = "The app that holds your name did not add this device in time."; phoneAsk.state = "yes"; }
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
      const byCode = phoneTicket.byCode === true, presence = phoneTicket.presence;
      try { if (o.cancelCode) o.cancelCode(); } catch { /* the QR was the way in; a code left showing lapses */ }
      const held = await holdPhone(p, phoneTicket.seed);
      // A phone that came in by the typed code was confirmed by the code itself (the PAKE key made the ticket, and the person typed its ack back here): no three words to pick, the yes is done when it asks (wink.phone.wait).
      if (byCode && phoneAsk && phoneAsk.device === String(p.id)) { /** @type {any} */ (phoneAsk).auto = true; /** @type {any} */ (phoneAsk).autoPresence = presence; }
      return held;
    };
    /** The old ring (relay.pair.ticket) pairs a phone with no words and no yes. Nothing is registered for it until the same three words are confirmed on this computer (a ring phone that cannot show words is let go after 5 minutes). @param {any} p */
    phone.holdRing = async p => holdPhone(p, "");
    /** The avatar's 8 bytes for a typed code (the camera reader's picture of the same code), base64url. @param {string} code */
    const avatarOf = code => { const b = codeToAvatarBytes(code); return b ? b64url(b) : null; };
    ctx.tool("wink.phone.open", {
      description: "Add a phone. From a computer already signed in to you: show a QR and a long code (the same text, to scan or to paste on the phone), a long secret good for one phone and 5 minutes. Answers { qr, link, art, expires }: `art` is the QR drawn for the screen. The phone then shows three words and this computer asks you the same (wink.phone.pairing); say yes only if they match (wink.phone.pair.answer). A phone pairs to you only, never to a space. The short typed code works too (`typed: true` asks for it) unless the kill switch is set (VYRE_WINK_TYPED_CODE=0 or config wink.typedCode: false).",
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
        /** The typed code beside the QR: the same pairing window, either one pairs one phone and ends the other. A relay with no code to give leaves `code` null and the QR works. @param {any} base */
        const withCode = async base => {
          if (!typedOn()) return base;
          try { const c = await o.openCode("W1"); return { ...base, code: c.code, code_expires: c.expires, code_offer: c.offer, avatar: avatarOf(c.code) }; } catch { return { ...base, code: null }; }
        };
        if (phoneTicket && !phoneTicket.claimed && phoneTicket.until > now()) {
          const now0 = o.codeNow ? o.codeNow() : null;
          const base = { qr: phoneTicket.qr, link: phoneTicket.qr, art: phoneTicket.art, expires: phoneTicket.until };
          return now0 ? { ...base, code: now0.code, code_expires: now0.expires, code_offer: now0.offer, avatar: avatarOf(now0.code) } : base;
        }
        const seed = crypto.randomBytes(16);
        const t = /** @type {any} */ (await mint(seed, "phone"));
        if (!t || t.error) throw fail("unavailable", words("offline"));
        const qr = phoneQrPayload(seed, await o.relayUrl());
        phoneTicket = { qr, art: qrArt(qr), until: now() + 5 * 60_000, claimed: false, seed: b64url(seed) };
        phoneAsk = null;
        return withCode({ qr, link: qr, art: phoneTicket.art, expires: phoneTicket.until });
      },
    });
    /** A phone came in by the typed code (its ack was typed back): the QR is spent too. */
    /** A phone typed the code and the person typed its ack back: the ticket both ends derived from the PAKE key is the pairing now (the QR's is spent), and the phone is confirmed by the code. @param {string} seed base64url @param {any} presence */
    phone.codeSeed = (seed, presence) => { phoneTicket = { qr: "", art: "", until: now() + 5 * 60_000, claimed: false, seed, byCode: true, presence }; phoneAsk = null; };
    ctx.tool("wink.phone.scan", {
      description: "On the phone: read the QR the computer shows, or the long code pasted (`payload`). Answers { pairing, ack: null, expires }: wink.pair.status then says `confirm` with `words`: show them, and the person says yes on the computer only if they match. No yes in 5 minutes adds nothing. A phone only pairs to the person's own identity. A short typed code works too unless the kill switch is set (VYRE_WINK_TYPED_CODE=0 or config wink.typedCode: false).",
      input: obj({ payload: str, code: str, target: obj({ kind: str, id: str }) }),
      run: async (input, meta = {}) => {
        owner(meta, "adding this phone");
        // the kill switch is set: say so plainly, not "payload is required"
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
      description: "On the computer showing the QR: is a phone asking to be added right now? Answers { asking: false } or { asking: true, name, choices, until, line } (no `words`: the person types the three the phone shows), or { asking: false, enrol: { device, name, entry, until } } when a phone was added and this server cannot sign its key onto the name's list (the owner's app does, then calls wink.phone.enrolled): `choices` are three sets of three words, one of them what the phone shows and two decoys in an order made fresh for this pairing, and `line` the question to put to the person (answer with wink.phone.pair.answer).",
      input: obj(),
      run: async (_, meta = {}) => {
        owner(meta, "the phone question");
        const a = phoneLive();
        // a phone the person said yes to, whose key this server cannot put on the name's list: the owner's app does it (wink.phone.enrolled reports it)
        if (a && a.state === "enrolling" && a.entry) return { asking: false, enrol: { device: a.device, name: a.name, entry: a.entry, until: a.enrolUntil } };
        if (!a || a.state !== "waiting" || !a.words) return { asking: false };
        return { asking: true, name: a.name, choices: a.choices, until: a.until, line: words("phoneAsk", { name: a.name, choices: a.choices }) };
      },
    });
    /** The yes, done: the phone is a device of this identity now (the relay makes it, the identity list takes its key, a paired session opens). Used by the person's answer and by a typed code's own ack. @param {any} a @param {any} presence */
    const acceptPhone = async (a, presence) => {
      const identity = await o.identity();
      const dev = devices.add({ id: a.device, identity, kind: "phone", name: a.name, fingerprint: a.fingerprint, target: { kind: "identity", id: identity } });
      // the relay makes the device only now (X-1); if it will not, nothing stays here either
      /** @type {any} */ let confirmed = null;
      try { confirmed = await confirmPending(a.device, true); }
      catch (e) { devices.remove(a.device); a.state = "no"; dropLater(`device:${a.device}`); throw e; }
      // the identity's own list takes the device's identity key, signed by THIS device's entry (the new entry is a newcomer for 24 hours); a refusal leaves the pairing made and says so
      if (a.entry) {
        try {
          const r = /** @type {any} */ (await ctx.call("spaces.identity.enrol", { publicKey: a.entry.publicKey, label: a.entry.label, ...entryExtras(a.entry) }));
          a.enrolled = Boolean(r && !r.error && r.data);
          if (!a.enrolled) a.enrolReason = String((r && r.error && r.error.message) || "the identity list did not take this device").slice(0, 200);
          // A server that holds no identity (the name's key lives in the owner's computer app) cannot sign the list change: it records the request, and the owner's app signs and reports (wink.phone.enrolled)
          if (!a.enrolled && r && r.error && (r.error.code === "no_identity" || /Choose your Vyre name first/.test(String(r.error.message)))) { a.state = "enrolling"; a.enrolUntil = now() + ENROL_MS; a.enrolReason = ""; }
        } catch (e) { a.enrolled = false; a.enrolReason = String(/** @type {Error} */ (e).message || "the identity list did not take this device").slice(0, 200); }
      }
      if (a.state !== "enrolling") a.state = "yes";
      await openPairedSession(a.device, identity, presence, confirmed);
      ctx.events.emit("wink.pair-answered", { yes: true, kind: "phone" });
      ctx.events.emit("wink.joined", { device: dev.id, flow: "W1", kind: "phone" });
      if (a.state === "enrolling") ctx.events.emit("wink.enrol-asked", { device: dev.id });
      return dev;
    };
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
        const dev = await acceptPhone(a, meta.presence);
        return { answered: true, yes: true, name: a.name, device: dev.id, ...(a.entry ? { enrolled: a.enrolled === true } : {}) };
      },
    });
    ctx.tool("wink.phone.enrolled", {
      description: "From the owner's app, after it signed a phone's key onto the name's list itself (the server holds no identity): { device, ok, reason?, identity?: { id, vyre? } }. The waiting phone is then told (wink.phone.wait): added, or why not.",
      input: obj({ device: str, ok: { type: "boolean" }, reason: str, identity: obj({ id: str, vyre: str }) }, ["device", "ok"]),
      run: async (input, meta = {}) => {
        owner(meta, "the phone's enrolment");
        const a = phoneLive();
        if (!a || a.state !== "enrolling" || a.device !== String(input.device)) throw fail("not_found", "no phone is waiting to be added to the name's list");
        a.enrolled = input.ok === true;
        if (!a.enrolled) a.enrolReason = cleanName(input.reason, 200) || "The app that holds your name could not add this device.";
        if (input.identity && typeof input.identity.id === "string") a.joinedIdentity = { id: String(input.identity.id).slice(0, 64), ...(typeof input.identity.vyre === "string" ? { vyre: input.identity.vyre.slice(0, 253) } : {}) };
        a.state = "yes";
        ctx.events.emit("wink.enrolled", { device: a.device, ok: a.enrolled });
        return { ok: true };
      },
    });
    ctx.tool("wink.phone.wait", {
      callers: ["web"],
      description: "From the phone that scanned the QR, over its own paired connection: where the question stands, and the way the three words are made. The phone sends `commit` (the hash of its fresh nonce) and its own `name`, hears this computer's nonce `nb`, then sends `reveal` (its nonce); the words appear only then. Answers { state: waiting | yes | no | expired, nb, words?, until }. Only that phone gets an answer.",
      input: obj({ commit: str, reveal: str, tag: str, name: str, entry: obj({ publicKey: str, label: str, agree: str, enclave: str, attest: str, held: { anyOf: [{ type: "string" }, { type: "boolean" }] } }) }),
      run: async (input, meta = {}) => {
        owner(meta, "the phone's wait");
        const a = phoneLive();
        if (!a || canonDevice(String((meta && meta.caller) || "")) !== `device:${a.device}`) throw fail("denied", words("phoneNotYours"));
        const i = input || {};
        if (!a.named && i.name) { const n = cleanPhoneName(i.name); if (n) a.name = n; a.named = true; }
        // A box-less device joining the person's identity (relay/client/phonepair.js) says which identity key it holds, once: the yes at the three words covers it, because it came over this device's own channel
        if (!a.entry && i.entry && typeof i.entry === "object" && typeof i.entry.publicKey === "string" && Buffer.from(i.entry.publicKey, "base64url").length === 32) a.entry = { publicKey: i.entry.publicKey, label: cleanPhoneName(i.entry.label) || a.name, ...entryExtras(i.entry) };
        if (a.state === "waiting" && !a.words) {
          if (!a.commit && /^[0-9a-f]{64}$/.test(String(i.commit || ""))) a.commit = String(i.commit);
          if (a.commit && typeof i.reveal === "string" && i.reveal) {
            if (!/^[0-9a-f]{32}$/.test(i.reveal) || (await nonceCommit(i.reveal)) !== a.commit) { a.state = "no"; dropLater(`device:${a.device}`); throw fail("denied", words("phoneMismatch")); }
            setWords(a, await pairWords(await boxKey(), a.device, { ticket: a.ticket, nonceA: i.reveal, nonceB: a.nb }));
            ctx.events.emit("wink.pair-asked", { device: a.device, name: a.name, choices: a.choices, until: a.until, kind: "phone" });
            if (/** @type {any} */ (a).auto === true && a.state === "waiting") await acceptPhone(a, /** @type {any} */ (a).autoPresence);
          }
        }
        // Once the yes is done the phone is told whose identity it joined (the id, and the Vyre name when the identity has one), so it can read the identity's list from the directory without guessing from the box's name.
        let joined = null;
        if (a.state === "yes" && /** @type {any} */ (a).joinedIdentity) joined = /** @type {any} */ (a).joinedIdentity;
        else if (a.state === "yes") { const idn = await o.identity().catch(() => null); const vy = typeof o.identityVyre === "function" ? await Promise.resolve(o.identityVyre()).catch(() => null) : null; if (idn) joined = { id: String(idn), ...(vy ? { vyre: String(vy) } : {}) }; }
        return { state: a.state, nb: a.nb, ...(joined ? { identity: joined } : {}), ...(a.words ? { words: a.words } : {}), ...(a.state === "yes" && a.entry ? { enrolled: a.enrolled === true, ...(a.enrolled === true ? {} : { reason: a.enrolReason || "the identity list did not take this device" }) } : {}), until: a.until };
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
  /** The automatic software presence signer: only a development build behind the software signer's switch (devKindSwitch, never the raw environment), so a packaged build ignores it. */
  const autoPresence = o.autoPresence ?? devKindSwitch(process.env.VYRE_SEAL_SOFTWARE, o.buildRoot);
  /** @type {ReturnType<typeof createServerLinks> | null} */ let links = null;
  /** This device's open peer session to a server it paired, by the server's device id, and the kernel's remote client over it; made on first use. */
  const serverLinks = () => links || (links = createServerLinks({ connect: relayConnect, options: pairOptions, ...(o.serve ? { serve: o.serve } : {}), name: String(ctx.config.name || "a device"), log: m => ctx.log(m), ...(o.signDevice ? { sign: o.signDevice } : ownKey ? { sign: async (/** @type {string} */ m) => ownKey.sign(m) } : {}), ...(o.presenceSigner ? { presenceSigner: o.presenceSigner } : {}), ...(o.proveTool ? { proveTool: o.proveTool } : ownKey ? { proveTool: ownKey.proveTool } : {}), autoPresence: autoPresence,
    channelOf: sid => { const c = meta.get(`channel:${sid}`); return c && c.route ? { relay: String(c.relay || ""), route: String(c.route), box: String(c.box || "") } : null; } }));
  /** The id of the server this device is paired to (the home a drive on this computer is offered to), or null. One home: the first paired server by id. */
  const homeServerId = () => {
    try {
      // the newest completed pairing; a channel with no completion mark (made before the mark existed) counts as the oldest, and a failed pairing leaves no channel at all
      const rows = /** @type {any[]} */ (db.prepare("SELECT k FROM wink_meta WHERE k LIKE 'channel:%' ORDER BY k").all());
      /** @type {string | null} */ let best = null; let bestAt = -1;
      for (const r of rows) { const sid = String(r.k).slice("channel:".length); const m = meta.get(`paired:${sid}`); const at = m && Number.isFinite(Number(m.at)) ? Number(m.at) : 0; if (at > bestAt) { best = sid; bestAt = at; } }
      return best;
    } catch { return null; }
  };
  return { typedAck: (/** @type {string} */ tag) => { typedAcks.set(String(tag), now() + 5 * 60_000); }, forgetTypedAck: (/** @type {string} */ tag) => { typedAcks.delete(String(tag)); }, autoPresence, serverLinks, homeServerId, devices, abandoned: (/** @type {string} */ d) => abandonHook(String(d)), endPairedNow, targets, checkTarget, phone, computeAllowed, compute, dropPending, tools: () => { tools(); startRetries(); }, startTyping, pending, peers, meta, clearOwner: () => clearOwnerHook(), releaseServer, retryReleases, stop, ownHandover: () => ownHandover() };
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
