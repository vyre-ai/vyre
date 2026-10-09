// @ts-check
// fill: the autofill door. A browser extension a person paired asks for the logins that match
// the page in front of them and, once unlocked, for one login's username and password
// (docs/adr/0010-vault-autofill.md, the addendum to ADR 0001).
//
// This is the only path by which a login's value leaves the vault for a screen, so it is built
// as a separate listener with its own credentials rather than as a registry tool:
//   - Agents never reach it. There is no vault.fill tool, only a route on this listener.
//   - A web page never reaches it. Any request carrying an Origin that is not a browser
//     extension is refused before anything else is read, so a page cannot drive it from script.
//   - A device token alone reveals nothing. It lists names for a page; a value needs a session,
//     and a session needs a person: Touch ID (or another presence proof) through the Capsule
//     helper, or, on a machine with no Touch ID, a passphrase typed into the extension.
//   - A session is the fill window of ADR 0028, decision 5: it lasts 30 minutes from the proof
//     that opened it and does not extend with use. `vault.fill.window` in config.json can make it
//     shorter (minutes, 1 to 30), never longer. endAll() closes every window at once (sleep,
//     screen lock, vault.lock).
//   - A login fills only a page whose origin is one of its hosts, exactly: scheme, host and port.
//     A lookalike host is the whole point of phishing, so there is no suffix or wildcard match.
//   - Tokens, codes and the unlock passphrase are stored only as hashes, and nothing here ever
//     writes a value, a token or a passphrase into an audit row, an event, an error or a log.

import crypto from "node:crypto";
import http from "node:http";
import { canonical, same } from "./crypto.js";
import { totp } from "./totp.js";
import { otpRoute, saveRoute } from "./fill-save.js";
import { saveKeyRoute } from "./fill-key.js";
import * as passkeys from "./fill-passkey.js";
import * as cards from "./fill-cards.js";
import { newPrefixedId } from "../../lib/id.js";

export const FILL_MIGRATION = `CREATE TABLE vault_devices (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
     created INTEGER NOT NULL, last_seen INTEGER, revoked INTEGER
   );
   CREATE TABLE vault_sessions (
     id TEXT PRIMARY KEY, device TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
     created INTEGER NOT NULL, expires INTEGER NOT NULL, last_used INTEGER NOT NULL
   );
   CREATE INDEX vault_sessions_device ON vault_sessions (device);
   CREATE TABLE vault_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE vault_pairing (
     code_hash TEXT PRIMARY KEY, name TEXT, expires INTEGER NOT NULL, used INTEGER
   );`;

/**
 * A phone's device key (ADR 0028, decision 5): a P-256 key the phone keeps in StrongBox or the
 * Secure Enclave behind its biometric prompt. Paired with the device, it opens a fill window by
 * signing a one-time challenge, the phone's version of Touch ID through the Capsule. Its own
 * table, MACed, so a module that writes vyre.db cannot swap in a key of its own.
 */
export const FILL_KEY_MIGRATION = `CREATE TABLE vault_device_keys (device TEXT PRIMARY KEY, key TEXT NOT NULL, at INTEGER NOT NULL, mac TEXT);
   ALTER TABLE vault_pairing ADD COLUMN phone INTEGER NOT NULL DEFAULT 0;`;
/**
 * A native Android app, as the phone's autofill service names it: its package and the SHA-256 of
 * its signing certificate. A login fills it only when the login lists exactly this in `apps`,
 * because a package name alone is anyone's to take (ADR 0028, threat model).
 * @param {unknown} u @returns {string|null} "android:<package>@<sha256>"
 */
export function appOf(u) {
  const m = /^android:\/\/([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)@([0-9a-f]{64})$/i.exec(String(u ?? ""));
  return m ? `android:${m[1].toLowerCase()}@${m[2].toLowerCase()}` : null;
}
const CHALLENGE_TTL_MS = 60_000;
const unlockMessage = nonce => Buffer.from(`vyre:fill-unlock:v1:${nonce}`, "utf8");

/** No 0/O, 1/I/L: a code read off a terminal and typed into a popup should not be misread. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LEN = 8;
const CODE_TTL_MS = 5 * 60_000;
/** The fill window (ADR 0028, decision 5): 30 minutes from the proof, and config may only shorten it. */
export const FILL_WINDOW_MIN = 30;
const FAIL_WINDOW_MS = 15 * 60_000;
const MAX_UNLOCK_FAILS = 5;
const MAX_PAIR_FAILS = 10;
const MIN_PASSPHRASE = 8;
const MAX_BODY = 64 * 1024;
/** scrypt as the vault key uses it (ADR 0001, decision 2): 128 MB, so a copied verifier is costly. */
const SCRYPT = { N: 1 << 17, r: 8, p: 1 };
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension):\/\/[A-Za-z0-9-]{1,64}$/;
const DEVICE_NAME = /[^A-Za-z0-9 ._@()'-]/g;

const sha = v => crypto.createHash("sha256").update(String(v)).digest("hex");
/** A P-256 SPKI public key, base64url, as it will be stored; null for anything else. @param {unknown} k */
function deviceKey(k) {
  if (typeof k !== "string" || !/^[A-Za-z0-9_-]{40,400}$/.test(k)) return null;
  try {
    const pub = crypto.createPublicKey({ key: Buffer.from(k, "base64url"), format: "der", type: "spki" });
    if (pub.asymmetricKeyType !== "ec" || /** @type {any} */ (pub.asymmetricKeyDetails).namedCurve !== "prime256v1") return null;
    return /** @type {Buffer} */ (pub.export({ format: "der", type: "spki" })).toString("base64url");
  } catch { return null; }
}
const newToken = () => crypto.randomBytes(32).toString("base64url");
const newId = p => newPrefixedId(p.replace(/_$/, ""));
const json = (v, d) => { try { return v == null ? d : JSON.parse(String(v)); } catch { return d; } };
const isStr = v => typeof v === "string" && v.length > 0;

/**
 * An http(s) origin, as vault.js's origin() computes it. Kept here rather than imported so that
 * vault.js can import FILL_MIGRATION from this file without a cycle at load time.
 * @returns {string|null}
 */
function origin(u) {
  try { const x = new URL(String(u)); return ["http:", "https:"].includes(x.protocol) ? x.origin : null; } catch { return null; }
}

/** @param {string} pass @param {Buffer} salt @param {{N:number,r:number,p:number}} o @returns {Promise<Buffer>} */
function scrypt(pass, salt, o) {
  return new Promise((resolve, reject) => crypto.scrypt(String(pass).normalize("NFKC"), salt, 32, { ...o, maxmem: 256 * 1024 * 1024 },
    (e, k) => (e ? reject(e) : resolve(k))));
}

/**
 * The fill window in milliseconds from config.json's `vault.fill.window` (minutes). Anything
 * that is not a number gives the default; a number is clamped to 1..30, so config can shorten
 * the window but never lengthen it.
 * @param {any} config the whole config, or null
 */
export function fillWindowMs(config) {
  const v = config && config.vault && config.vault.fill && typeof config.vault.fill === "object" ? config.vault.fill.window : undefined;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  const min = Number.isFinite(n) ? Math.min(FILL_WINDOW_MIN, Math.max(1, n)) : FILL_WINDOW_MIN;
  return Math.round(min * 60_000);
}

/** A code as people type it: case, spaces and dashes do not matter. */
const normalCode = c => String(c ?? "").toUpperCase().replace(/[\s-]/g, "");

const fail = (status, code, message) => ({ status, body: { error: { code, message } } });
const ok = data => ({ status: 200, body: { data } });

/**
 * @typedef {{ status: number, body: any }} Reply
 * @typedef {{ id: string, name: string, token_hash: string, created: number, last_seen: number|null, revoked: number|null }} Device
 */

export class Fill {
  /**
   * @param {{ vault: import("./vault.js").Vault, verifyVaultPassphrase?: (p: string) => Promise<boolean>, now?: () => number, config?: any, extensions?: string[],
   *   connect?: (k: { item: string, kind: string, provider: string }) => Promise<{ module: string }|null> }} deps
   *   config: the whole config.json, for `vault.fill.window`. extensions: the extension origins
   *   that may pair (vault.fill.extensions); empty means any. connect: called after a page's API
   *   key is saved (fill-key.js) so it can be granted to a module whose need names its provider.
   */
  constructor({ vault, verifyVaultPassphrase, now = Date.now, config = null, extensions = [], connect }) {
    this.connect = typeof connect === "function" ? connect : null;
    this.extensions = new Set(extensions.map(String));
    /** Signed-request nonces seen, with when each can be forgotten. @type {Map<string, number>} */
    this.proofNonces = new Map();
    this.vault = vault;
    /** How long a session lasts from the proof that opened it. */
    this.windowMs = fillWindowMs(config);
    /** What the OS autofill store gets for each login: "usernames" (the default) or "names" (ADR 0028). */
    this.identities = config && config.vault && config.vault.autofill && config.vault.autofill.identities === "names" ? "names" : "usernames";
    this.db = vault.db;
    this.verifyVaultPassphrase = verifyVaultPassphrase;
    this.now = now;
    // Pairing codes are hashed under a key that lives only in this process. vyre.db is readable
    // by every module, and 31^8 codes is a space a GPU walks in minutes, which is inside the
    // five minutes a code lives. With the key in memory the rows are useless to a reader.
    this.pepper = crypto.randomBytes(32);
    /** Failed unlocks per device, as timestamps. In memory: a restart is not an attacker's to cause. */
    this.fails = new Map();
    /** Failed pairings, all devices together (nobody is known yet). */
    this.pairFails = [];
    /** Session tokens opened by unlockDevice, waiting for that device's next status call. Memory only. */
    this.pickup = new Map();
    /** One open challenge per device, for a device-key unlock. Memory only, 60 seconds, single use. */
    this.challenges = new Map();
  }

  // ---- registry tools (FILL_TOOLS) ------------------------------------------------------

  /** A one-time pairing code for `vyre vault pair`. cli/local only. @param {{ name?: string }} [input] */
  code({ name, phone = false } = {}, caller = "cli") {
    const t = this.now();
    this.db.prepare("DELETE FROM vault_pairing WHERE expires < ? OR used IS NOT NULL").run(t);
    let c = "";
    for (let i = 0; i < CODE_LEN; i++) c += ALPHABET[crypto.randomInt(ALPHABET.length)];
    const label = name ? this.deviceName(name) : null;
    this.db.prepare("INSERT INTO vault_pairing (code_hash, name, expires, used, phone) VALUES (?,?,?,NULL,?)").run(this.codeHash(c), label, t + CODE_TTL_MS, phone ? 1 : 0);
    this.vault.audit("pair-code", null, caller, true, `${phone ? "phone" : "browser"}${label ? ` ${label}` : ""}`);
    return { code: c, display: `${c.slice(0, 4)}-${c.slice(4)}`, expires: t + CODE_TTL_MS };
  }

  /** Set (or change) the unlock passphrase. Changing it ends every open session. cli/local only. */
  /** @param {{ passphrase?: string }} [input] */
  async setUnlockPassphrase({ passphrase } = {}, caller = "cli") {
    if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE) throw new Error(`an unlock passphrase is at least ${MIN_PASSPHRASE} characters`);
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(passphrase, salt, SCRYPT);
    const rec = { v: 1, kdf: "scrypt", ...SCRYPT, salt: salt.toString("base64"), hash: hash.toString("base64") };
    const had = this.db.prepare("SELECT 1 FROM vault_meta WHERE key = 'unlock'").get();
    this.db.prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('unlock', ?)").run(canonical(rec));
    const ended = Number(this.db.prepare("DELETE FROM vault_sessions").run().changes);
    this.pickup.clear();
    this.vault.audit("unlock-passphrase", null, caller, true, had ? `changed, ${ended} sessions ended` : "set");
    return { set: true, changed: Boolean(had), sessionsEnded: ended };
  }

  /**
   * Open a session for a device without a passphrase: the Capsule helper calls this after
   * Touch ID. The token is not returned here; the extension collects it on its next status call.
   */
  /** @param {{ device?: string }} [input] */
  unlockDevice({ device } = {}, caller = "local") {
    const d = this.deviceById(device);
    if (!d) throw new Error(`no paired device ${device}`);
    if (d.revoked) throw new Error(`device ${d.id} was revoked`);
    const s = this.openSession(d);
    this.pickup.set(d.id, { token: s.token, id: s.id });
    this.vault.audit("unlock", null, this.who(d), true, `opened by ${caller}`);
    return { ok: true, expires: s.expires };
  }

  /**
   * End every open session now: the Mac slept, its screen locked, or the vault was locked. The
   * extension's next call finds its session gone and asks for a new proof.
   * @param {string} [why] @returns {number} how many sessions ended
   */
  endAll(why = "lock") {
    const ended = Number(this.db.prepare("DELETE FROM vault_sessions").run().changes);
    this.pickup.clear();
    if (ended) this.vault.audit("fill-lock", null, "vyred", true, `${why}: ${ended} sessions ended`);
    return ended;
  }

  /** Paired devices, with how many sessions each has open. Names and times only. */
  devices() {
    const t = this.now();
    const rows = /** @type {Device[]} */ (this.db.prepare("SELECT * FROM vault_devices ORDER BY created").all()).filter(d => this.vault.rowOk("vault_devices", d));
    return {
      devices: rows.map(d => ({
        id: d.id, name: d.name, created: d.created, lastSeen: d.last_seen, revoked: d.revoked || null,
        sessions: this.db.prepare("SELECT created, expires FROM vault_sessions WHERE device = ?").all(d.id)
          .filter(s => this.live(s, t)).length,
      })),
    };
  }

  /** End a device now: its token stops working and its sessions end. */
  /** @param {{ id?: string }} [input] */
  revokeDevice({ id } = {}, caller = "cli") {
    const d = this.deviceById(id);
    if (!d) throw new Error(`no paired device ${id}`);
    if (d.revoked) return { revoked: false, id: d.id };
    this.db.prepare("UPDATE vault_devices SET revoked = ? WHERE id = ?").run(this.now(), d.id);
    this.vault.sign("vault_devices", d.id);
    const ended = Number(this.db.prepare("DELETE FROM vault_sessions WHERE device = ?").run(d.id).changes);
    this.pickup.delete(d.id);
    this.vault.audit("device-revoke", null, caller, true, `${d.id} (${d.name}), ${ended} sessions ended`);
    this.vault.emit("vault.device-revoked", { device: d.id, name: d.name });
    return { revoked: true, id: d.id, sessionsEnded: ended };
  }

  // ---- the listener's handler -----------------------------------------------------------

  /**
   * One request. `route` is "<METHOD> <name>", such as "POST fill" or "GET status".
   * @param {string} route @param {any} body @param {Record<string, any>} [headers]
   * @returns {Promise<Reply>}
   */
  async handle(route, body, headers = {}, { raw = "", path = "" } = {}) {
    /** @type {Record<string, string>} */
    const h = {};
    for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    // What a paired extension's key signed over (device()). Pseudo-headers: a client cannot send
    // a header whose name starts with ":".
    Object.assign(h, { ":method": route.split(" ")[0], ":path": path || `/v1/fill/${route.split(" ")[1]}`, ":raw": raw });
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    // Device rows are MACed under the vault key (ADR 0006): load it if the keystore opens
    // unattended, so the checks below run. A locked passphrase vault stays locked.
    try { if (await this.vault.keys.exists()) await this.vault.key(); } catch {}
    switch (route) {
      case "POST pair": return this.pair(b, h);
      case "POST unlock": return b && typeof b.signature === "string" ? this.unlockKey(b, h) : this.unlock(b, h);
      case "POST challenge": return this.challenge(h);
      case "POST lock": return this.lockRoute(h);
      case "POST match": return this.matchRoute(b, h);
      case "POST fill": return this.fill(b, h);
      case "GET status": return this.status(h);
      case "POST otp": return otpRoute(this, b, h);
      case "POST save": return saveRoute(this, b, h);
      case "POST save-key": return saveKeyRoute(this, b, h);
      case "POST identities": return cards.identitiesRoute(this, b, h);
      case "POST passkeys": return passkeys.listRoute(this, b, h);
      case "POST passkey.create": return passkeys.createRoute(this, b, h);
      case "POST passkey.get": return passkeys.getRoute(this, b, h);
      case "POST passkey.assert": return passkeys.assertRoute(this, b, h);
      case "POST passkey.register": return passkeys.registerRoute(this, b, h);
      case "POST cards": return cards.listRoute(this, b, h);
      case "POST card.fill": return cards.cardRoute(this, b, h);
      case "POST address.fill": return cards.addressRoute(this, b, h);
      default: return fail(404, "not_found", `no route ${route}`);
    }
  }

  /**
   * Pair an extension with a code. Its Origin is kept and must come with every later request, and
   * an ES256 public key (`key`, a JWK) it sends is kept too: then every request must be signed
   * with it (`x-vyre-proof`), so a token copied out of the browser is not enough. A script can
   * send any Origin it likes; the key is what it cannot make up.
   * @param {any} b @param {Record<string, string>} [h] @returns {Reply}
   */
  pair(b, h = {}) {
    const t = this.now();
    const from = String(h.origin || "");
    if (this.extensions.size && !this.extensions.has(from)) return fail(403, "origin_refused", "pairing is done from the Vyre extension");
    // A browser's key is a JWK it signs requests with; a phone's is a base64url SPKI string it
    // unlocks with (below, once the code says it was made for a phone).
    let key = null;
    if (b.key !== undefined && typeof b.key !== "string") {
      const k = b.key;
      try {
        if (!k || k.kty !== "EC" || k.crv !== "P-256" || k.d) throw new Error("no");
        crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: k.x, y: k.y }, format: "jwk" });
        key = { kty: "EC", crv: "P-256", x: String(k.x), y: String(k.y) };
      } catch { return fail(400, "bad_input", "key must be the public JWK of an ES256 key"); }
    }
    this.pairFails = this.pairFails.filter(x => x > t - FAIL_WINDOW_MS);
    if (this.pairFails.length >= MAX_PAIR_FAILS) {
      this.vault.audit("pair", null, "device:unknown", false, "locked out");
      return fail(429, "locked_out", "too many wrong pairing codes; wait 15 minutes and run vyre vault pair again");
    }
    const c = normalCode(b.code);
    if (c.length !== CODE_LEN) return this.pairRefused(t, "that is not a pairing code");
    // A device row must be signed, and signing needs the vault key.
    if (!this.vault.mkey) return fail(423, "vault_locked", "the vault is locked · vyre vault unlock, then pair");
    const hash = this.codeHash(c);
    const row = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_pairing WHERE code_hash = ?").get(hash));
    // Single use, claimed in one statement so two racing requests cannot both win.
    const claimed = row ? Number(this.db.prepare("UPDATE vault_pairing SET used = ? WHERE code_hash = ? AND used IS NULL AND expires > ?").run(t, hash, t).changes) : 0;
    if (!claimed) return this.pairRefused(t, row ? (row.used ? "that code was already used" : "that code has expired") : "unknown code");
    const name = row.name || this.deviceName(b.name || "browser");
    const token = newToken();
    const id = newId("d_");
    // A phone pairs with its device key; a browser has none and unlocks another way.
    let phoneKey = null;
    if (typeof b.key === "string") {
      // A key unlocks with no passphrase and no Touch ID here, so only a code the person made for a phone takes one.
      if (!row.phone) return this.pairRefused(t, "that code is for a browser · vyre vault pair --phone makes one for a phone");
      phoneKey = deviceKey(b.key);
      if (!phoneKey) return fail(400, "bad_input", "the device key is not a P-256 public key");
    }
    this.db.prepare("INSERT INTO vault_devices (id, name, token_hash, created, last_seen, revoked) VALUES (?,?,?,?,?,NULL)").run(id, name, sha(token), t, t);
    this.vault.sign("vault_devices", id);
    if (phoneKey) { this.db.prepare("INSERT OR REPLACE INTO vault_device_keys (device, key, at) VALUES (?,?,?)").run(id, phoneKey, t); this.vault.sign("vault_device_keys", id); }
    if (from) this.db.prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES (?, ?)").run(`device-origin:${id}`, from);
    if (key) this.db.prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES (?, ?)").run(`device-key:${id}`, JSON.stringify(key));
    this.vault.audit("pair", null, `device:${id}:${name}`, true, key ? "key-bound" : phoneKey ? "phone-key" : null);
    this.vault.emit("vault.device-paired", { device: id, name });
    return ok({ device: id, name, token });
  }

  pairRefused(t, why) {
    this.pairFails.push(t);
    this.vault.audit("pair", null, "device:unknown", false, why);
    return fail(403, "bad_code", `${why} · run vyre vault pair for a new one`);
  }

  /** @param {any} b @param {Record<string, string>} h @returns {Promise<Reply>} */
  async unlock(b, h) {
    const d = this.device(h);
    if ("status" in d) return d;
    const who = this.who(d);
    const t = this.now();
    const recent = (this.fails.get(d.id) || []).filter(x => x > t - FAIL_WINDOW_MS);
    this.fails.set(d.id, recent);
    if (recent.length >= MAX_UNLOCK_FAILS) {
      this.vault.audit("unlock", null, who, false, "locked out");
      return fail(429, "locked_out", "too many wrong passphrases from this device; wait 15 minutes");
    }
    if (!isStr(b.passphrase) || b.passphrase.length > 1024) return fail(400, "bad_input", "give the unlock passphrase");
    const rec = json(/** @type {any} */ (this.db.prepare("SELECT value FROM vault_meta WHERE key = 'unlock'").get())?.value, null);
    const vaultPass = this.vault.kind === "passphrase" && typeof this.verifyVaultPassphrase === "function";
    if (!rec && !vaultPass) return fail(409, "not_set", "no unlock passphrase is set · vyre vault unlock-passphrase");
    let good = false, how = "";
    if (rec && await this.checkUnlock(rec, b.passphrase)) { good = true; how = "unlock passphrase"; }
    else if (vaultPass) {
      try { good = Boolean(await /** @type {Function} */ (this.verifyVaultPassphrase)(b.passphrase)); } catch { good = false; }
      if (good) how = "vault passphrase";
    }
    if (!good) {
      recent.push(this.now());
      this.vault.audit("unlock", null, who, false, "wrong passphrase");
      const left = MAX_UNLOCK_FAILS - recent.length;
      return left > 0 ? fail(401, "bad_passphrase", `wrong passphrase, ${left} tries left`) : fail(429, "locked_out", "too many wrong passphrases from this device; wait 15 minutes");
    }
    this.fails.delete(d.id);
    const s = this.openSession(d);
    this.vault.audit("unlock", null, who, true, how);
    return ok({ session: s.token, expires: s.expires });
  }

  /** A one-time challenge for a device-key unlock. @param {Record<string, string>} h @returns {Reply} */
  challenge(h) {
    const d = this.device(h);
    if ("status" in d) return d;
    if (!this.keyOf(d.id)) return fail(409, "no_key", "this device has no device key; unlock with the passphrase");
    const nonce = crypto.randomBytes(32).toString("base64url");
    this.challenges.set(d.id, { nonce, expires: this.now() + CHALLENGE_TTL_MS });
    return ok({ challenge: nonce, message: `vyre:fill-unlock:v1:${nonce}`, expires: this.now() + CHALLENGE_TTL_MS });
  }

  /**
   * Open a fill window with the device key's signature over the challenge. The phone asks for the
   * signature through its biometric prompt, so a signature is a person's presence.
   * @param {any} b @param {Record<string, string>} h @returns {Reply}
   */
  unlockKey(b, h) {
    const d = this.device(h);
    if ("status" in d) return d;
    const who = this.who(d);
    const t = this.now();
    const recent = (this.fails.get(d.id) || []).filter(x => x > t - FAIL_WINDOW_MS);
    this.fails.set(d.id, recent);
    if (recent.length >= MAX_UNLOCK_FAILS) { this.vault.audit("unlock", null, who, false, "locked out"); return fail(429, "locked_out", "too many failed unlocks from this device; wait 15 minutes"); }
    const c = this.challenges.get(d.id);
    this.challenges.delete(d.id);
    const key = this.keyOf(d.id);
    let good = false;
    if (c && c.expires > t && key && /^[A-Za-z0-9_-]{16,200}$/.test(b.signature)) {
      try {
        const pub = crypto.createPublicKey({ key: Buffer.from(key, "base64url"), format: "der", type: "spki" });
        good = crypto.verify("sha256", unlockMessage(c.nonce), { key: pub, dsaEncoding: "der" }, Buffer.from(b.signature, "base64url"));
      } catch { good = false; }
    }
    if (!good) {
      recent.push(t);
      this.vault.audit("unlock", null, who, false, c ? "bad device signature" : "no challenge");
      return fail(401, "bad_signature", c ? "the device key's signature did not check" : "ask for a challenge first");
    }
    this.fails.delete(d.id);
    const s = this.openSession(d);
    this.vault.audit("unlock", null, who, true, "device key");
    return ok({ session: s.token, expires: s.expires });
  }

  /** The device key of a device, checked against its MAC, or null. @param {string} id */
  keyOf(id) {
    const r = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_device_keys WHERE device = ?").get(id));
    return r && this.vault.rowOk("vault_device_keys", r) ? String(r.key) : null;
  }

  /** @param {Record<string, string>} h @returns {Reply} */
  lockRoute(h) {
    const d = this.device(h);
    if ("status" in d) return d;
    const ended = Number(this.db.prepare("DELETE FROM vault_sessions WHERE device = ?").run(d.id).changes);
    this.pickup.delete(d.id);
    this.vault.audit("lock", null, this.who(d), true, `${ended} sessions ended`);
    return ok({ locked: true, sessionsEnded: ended });
  }

  /** @param {any} b @param {Record<string, string>} h @returns {Reply} */
  matchRoute(b, h) {
    const d = this.device(h);
    if ("status" in d) return d;
    const app = appOf(b.url);
    if (app) return ok({ app, logins: this.appLogins(app).map(r => ({ name: r.name, description: r.description, url: r.url })) });
    const o = origin(b.url);
    if (!o) return ok({ origin: null, logins: [] });
    return ok({ origin: o, logins: this.logins(o).map(r => ({ name: r.name, description: r.description, url: r.url })) });
  }

  /** @param {any} b @param {Record<string, string>} h @returns {Promise<Reply>} */
  async fill(b, h) {
    const d = this.device(h);
    if ("status" in d) return d;
    const who = this.who(d);
    const name = isStr(b.name) ? b.name : null;
    const refuse = (status, code, why) => { this.vault.audit("fill", name, who, false, why); return fail(status, code, why); };
    const s = this.session(d, h["x-vyre-session"]);
    if (s === "missing") return refuse(401, "session_required", "unlock first");
    if (s === "expired") return refuse(401, "session_expired", "the session ended; unlock again");
    if (!name) return refuse(400, "bad_input", "give the login's name");
    const app = appOf(b.url);
    const o = app || origin(b.url);
    if (!o) return refuse(400, "bad_input", "the page is not an http or https page");
    const r = this.vault.row(name);
    if (!r || r.kind !== "login") return refuse(404, "not_found", `no login named ${name}`);
    if (app ? !this.appLogins(app).some(x => x.name === r.name) : !this.hostsOf(r).includes(o)) return refuse(403, "wrong_origin", `${name} is not for ${o}`);
    let f;
    try { f = await this.vault.fields(r); }
    catch (e) {
      const locked = /** @type {any} */ (e).code === "locked";
      return refuse(locked ? 423 : 500, locked ? "vault_locked" : "internal", locked ? String(/** @type {any} */ (e).message) : `could not open ${name}`);
    }
    const out = { username: f.username || "", password: f.password || "" };
    if (f.totp) {
      try { out.totp = totp(f.totp, { at: this.now() }).code; } catch { /* a bad seed must not block the password */ }
    }
    this.db.prepare("UPDATE vault_sessions SET last_used = ? WHERE id = ?").run(this.now(), s.id);
    this.vault.audit("fill", name, who, true, o);
    this.vault.emit("vault.filled", { name, device: d.id });
    return ok(out);
  }

  /** @param {Record<string, string>} h @returns {Reply} */
  status(h) {
    const d = this.device(h);
    if ("status" in d) return d;
    const t = this.now();
    const canUnlock = Boolean(this.db.prepare("SELECT 1 FROM vault_meta WHERE key = 'unlock'").get())
      || (this.vault.kind === "passphrase" && typeof this.verifyVaultPassphrase === "function");
    const base = { device: { id: d.id, name: d.name }, canUnlock };
    const waiting = this.pickup.get(d.id);
    if (waiting) {
      this.pickup.delete(d.id);
      const row = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_sessions WHERE id = ?").get(waiting.id));
      if (row && this.live(row, t)) return ok({ ...base, unlocked: true, expires: this.expiry(row), session: waiting.token });
    }
    const s = h["x-vyre-session"] ? this.session(d, h["x-vyre-session"], { touch: false }) : "missing";
    if (typeof s === "object") return ok({ ...base, unlocked: true, expires: this.expiry(s) });
    return ok({ ...base, unlocked: false });
  }

  // ---- helpers --------------------------------------------------------------------------

  codeHash(c) { return crypto.createHmac("sha256", this.pepper).update(normalCode(c)).digest("hex"); }

  deviceName(n) { return String(n).replace(DEVICE_NAME, "").trim().slice(0, 64) || "browser"; }

  /** @param {Device} d */
  who(d) { return `device:${d.id}:${d.name}`; }

  /** @returns {Device|undefined} */
  deviceById(id) {
    const d = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_devices WHERE id = ?").get(String(id ?? "")));
    return d && this.vault.rowOk("vault_devices", d) ? d : undefined;
  }

  /**
   * The device a request's bearer token names, or a refusal.
   * @param {Record<string, string>} h @returns {Device | Reply}
   */
  device(h) {
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(String(h.authorization || ""));
    if (!m) return fail(401, "unauthorized", "pair this browser first · vyre vault pair");
    const hash = sha(m[1]);
    const d = /** @type {Device|undefined} */ (this.db.prepare("SELECT * FROM vault_devices WHERE token_hash = ?").get(hash));
    if (!d || !same(d.token_hash, hash) || !this.vault.rowOk("vault_devices", d)) return fail(401, "unauthorized", "this browser is not paired · vyre vault pair");
    if (d.revoked) return fail(401, "revoked", "this browser was unpaired · vyre vault pair to pair it again");
    const meta = k => /** @type {any} */ (this.db.prepare("SELECT value FROM vault_meta WHERE key = ?").get(k))?.value ?? null;
    const pinned = meta(`device-origin:${d.id}`);
    // Another extension never uses this one's token. A request with no Origin at all is not a
    // browser's; only the key below tells that script from the extension.
    if (pinned && h.origin && String(h.origin) !== pinned) return fail(401, "unauthorized", "this browser's token came from another extension");
    const key = meta(`device-key:${d.id}`);
    if (key) {
      const why = this.checkProof(d.id, key, h);
      if (why) return fail(401, "unauthorized", why);
    }
    this.db.prepare("UPDATE vault_devices SET last_seen = ? WHERE id = ?").run(this.now(), d.id);
    return d;
  }

  /**
   * A key-bound extension's signature over this request: ES256 (P1363) over
   * `METHOD\npath\nsha256b64url(body)\nt\nn`, fresh within a minute, each nonce once.
   * @returns {string|null} why it is refused
   */
  checkProof(id, keyJson, h) {
    const m = /^t=(\d{1,16}) n=([A-Za-z0-9_-]{8,64}) sig=([A-Za-z0-9_-]+)$/.exec(String(h["x-vyre-proof"] || "").trim());
    if (!m) return "this browser signs its requests; the signature is missing";
    const now = this.now();
    if (Math.abs(now - Number(m[1])) > 60_000) return "the request's signature is stale; check the clock";
    for (const [k, until] of this.proofNonces) if (until <= now) this.proofNonces.delete(k);
    if (this.proofNonces.has(`${id}:${m[2]}`)) return "that signed request was already used";
    const msg = `${h[":method"]}\n${h[":path"]}\n${crypto.createHash("sha256").update(h[":raw"] || "").digest("base64url")}\n${m[1]}\n${m[2]}`;
    let good = false;
    try { good = crypto.verify("sha256", Buffer.from(msg), { key: crypto.createPublicKey({ key: JSON.parse(keyJson), format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url")); } catch {}
    if (!good) return "the request's signature does not match this browser's key";
    this.proofNonces.set(`${id}:${m[2]}`, now + 120_000);
    return null;
  }

  /** @param {Device} d */
  openSession(d) {
    const t = this.now();
    const token = newToken();
    const id = newId("s_");
    this.db.prepare("DELETE FROM vault_sessions WHERE device = ? AND (expires <= ? OR created <= ?)").run(d.id, t, t - this.windowMs);
    this.db.prepare("INSERT INTO vault_sessions (id, device, token_hash, created, expires, last_used) VALUES (?,?,?,?,?,?)").run(id, d.id, sha(token), t, t + this.windowMs, t);
    return { id, token, expires: t + this.windowMs };
  }

  /** @param {{ created: number, expires: number }} s @param {number} t */
  live(s, t) { return t < this.expiry(s); }

  /**
   * When a session ends: its window from the proof. Use does not move it. A row written under an
   * older, longer rule (or before the window was shortened) still ends at created + window.
   * @param {{ created: number, expires: number }} s
   */
  expiry(s) { return Math.min(Number(s.expires), Number(s.created) + this.windowMs); }

  /**
   * The session a request names, for this device only.
   * @param {Device} d @param {string|undefined} token
   * @returns {"missing" | "expired" | any}
   */
  session(d, token, { touch = true } = {}) {
    if (!isStr(token) || token.length > 200) return "missing";
    const hash = sha(token);
    const s = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_sessions WHERE token_hash = ? AND device = ?").get(hash, d.id));
    if (!s || !same(s.token_hash, hash)) return "expired";
    if (!this.live(s, this.now())) { this.db.prepare("DELETE FROM vault_sessions WHERE id = ?").run(s.id); return "expired"; }
    // last_used is a record of the last use only. It no longer moves the session's end.
    if (touch) this.db.prepare("UPDATE vault_sessions SET last_used = ? WHERE id = ?").run(this.now(), s.id);
    return s;
  }

  /** A login's allowed origins: its hosts, and the origin of its url. Exact origins, no suffixes. */
  hostsOf(r) {
    const hs = new Set(json(r.hosts, []).map(origin).filter(Boolean));
    const u = r.url ? origin(r.url) : null;
    if (u) hs.add(u);
    return [...hs];
  }

  /** Logins that list a native app, exactly (package and certificate). @param {string} app */
  appLogins(app) {
    return /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_items WHERE kind = 'login' ORDER BY name").all())
      .filter(r => this.vault.rowOk("vault_items", r) && json(r.apps, []).map(a => String(a).toLowerCase()).includes(app));
  }

  /** Logins whose hosts include an origin: the same rule fill applies, so the popup offers only what fills. */
  logins(o) {
    return /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_items WHERE kind = 'login' ORDER BY name").all())
      .filter(r => this.vault.rowOk("vault_items", r) && this.hostsOf(r).includes(o));
  }

  /** @param {any} rec @param {string} passphrase */
  async checkUnlock(rec, passphrase) {
    if (!rec || rec.v !== 1 || rec.kdf !== "scrypt") return false;
    const want = Buffer.from(String(rec.hash), "base64");
    const got = await scrypt(passphrase, Buffer.from(String(rec.salt), "base64"), { N: rec.N, r: rec.r, p: rec.p });
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }
}

// ---- the listener -----------------------------------------------------------------------

const ROUTES = { pair: "POST", unlock: "POST", challenge: "POST", lock: "POST", match: "POST", fill: "POST", status: "GET", otp: "POST", save: "POST", "save-key": "POST",
  identities: "POST", passkeys: "POST", "passkey.create": "POST", "passkey.get": "POST", "passkey.assert": "POST", "passkey.register": "POST", cards: "POST", "card.fill": "POST", "address.fill": "POST" };

class HttpError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "too_large", "request body is over 64 KB");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!size) return { json: {}, raw };
  try { return { json: JSON.parse(raw), raw }; }
  catch { throw new HttpError(400, "bad_input", "request body is not JSON"); }
}

/** Loopback names a Host header may carry whatever the listener is bound to. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** The host part of a Host header, lower case, without port or IPv6 brackets. */
export function hostName(h) {
  const s = String(h ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s.startsWith("[")) { const end = s.indexOf("]"); return end > 0 ? s.slice(1, end) : ""; }
  return s.replace(/:\d*$/, "");
}

/**
 * Start the fill listener. Routes under /v1/fill/; anything else is 404. A request whose Origin
 * is present and is not a browser extension is refused before its body is read, and so is one
 * whose Host is not loopback or a configured name: a page on a domain that re-resolves to
 * 127.0.0.1 (DNS rebinding) sends its own name as Host, and is refused on that.
 * @param {{ host?: string, port?: number, fill: Fill, names?: string[] }} o names: extra host
 *   names people reach this listener by (a Tailscale name, say); loopback is always allowed.
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function serveFill({ host = "127.0.0.1", port = 0, fill, names = [] }) {
  const allowedHosts = new Set([...LOOPBACK, ...names.map(n => hostName(n)).filter(Boolean)]);
  if (host && !["0.0.0.0", "::"].includes(host)) allowedHosts.add(hostName(host.includes(":") && !host.startsWith("[") ? `[${host}]` : host));
  const server = http.createServer(async (req, res) => {
    /** @type {Record<string, string>} */
    const cors = {};
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...cors });
      res.end(JSON.stringify(body));
    };
    try {
      if (!allowedHosts.has(hostName(req.headers.host))) return reply(421, { error: { code: "host_refused", message: "the fill listener answers only on its own address" } });
      const o = req.headers.origin;
      if (o !== undefined) {
        if (!EXTENSION_ORIGIN.test(String(o))) return reply(403, { error: { code: "origin_refused", message: "the fill listener answers the Vyre extension only" } });
        Object.assign(cors, {
          "access-control-allow-origin": String(o), vary: "Origin",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type, x-vyre-session, x-vyre-proof",
          "access-control-max-age": "600",
        });
        if (req.headers["access-control-request-private-network"]) cors["access-control-allow-private-network"] = "true";
      }
      const path = new URL(req.url || "/", "http://fill").pathname;
      const m = /^\/v1\/fill\/([a-z]+(?:[.-][a-z]+)?)$/.exec(path);
      const name = m ? m[1] : "";
      if (!Object.hasOwn(ROUTES, name)) return reply(404, { error: { code: "not_found", message: `${req.method} ${path}` } });
      if (req.method === "OPTIONS") { res.writeHead(204, { ...cors, "content-length": "0" }); return res.end(); }
      if (req.method !== ROUTES[name]) return reply(405, { error: { code: "method", message: `${name} takes ${ROUTES[name]}` } });
      // Pairing is the extension's first step and nothing else makes it. Without an Origin, the
      // caller is a script (an agent with curl), which would otherwise pair itself with a code.
      const got = req.method === "POST" ? await readJson(req) : { json: {}, raw: "" };
      // A phone's autofill service is not a browser and sends no Origin; it pairs with a device
      // key and a phone code, which pair() checks.
      if (name === "pair" && o === undefined && !(got.json && typeof got.json.key === "string")) return reply(403, { error: { code: "origin_required", message: "pairing is done from the Vyre extension" } });
      const out = await fill.handle(`${req.method} ${name}`, got.json, /** @type {any} */ (req.headers), { raw: got.raw, path: `/v1/fill/${name}` });
      reply(out.status || 200, out.body ?? {});
    } catch (e) {
      if (e instanceof HttpError) return reply(e.status, { error: { code: e.code, message: e.message } });
      // An unexpected failure says so without its message: messages can carry what they touched.
      if (!res.headersSent) reply(500, { error: { code: "internal", message: "the fill listener failed" } });
      else res.end();
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => resolve(undefined)); });
  const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
  const h = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
  return {
    url: `http://${h}:${addr.port}`,
    close: () => new Promise(r => { server.close(() => r(undefined)); server.closeAllConnections(); }),
  };
}

// ---- the registry tools the vault module registers ---------------------------------------

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });

/**
 * Tools for index.js to register. `callers: null` means every caller, as in index.js. Each run
 * is `(input, { caller }) => fill[method](input, caller)`. There is deliberately no fill tool.
 * `presence(fill, input)` is the words a person sees before proving presence (ADR 0006,
 * section 3): what is being unlocked or paired, never a code, token or passphrase.
 * @type {{ name: string, callers: string[]|null, description: string, input: any, method: "code"|"devices"|"revokeDevice"|"unlockDevice"|"setUnlockPassphrase", presence?: (fill: Fill, input: any) => string }[]}
 */
export const FILL_TOOLS = [
  { name: "vault.device.code", callers: ["cli", "local"], method: "code", input: obj({ name: str, phone: { type: "boolean" } }),
    presence: (f, i) => (i && i.phone
      ? `Pair a phone${i.name ? ` (${f.deviceName(i.name)})` : ""} for autofill: it will unlock with its own fingerprint or face`
      : `Pair a new browser${i && i.name ? ` (${f.deviceName(i.name)})` : ""} for autofill`),
    description: "A one-time code (8 characters, 5 minutes) to pair a browser extension, or with phone a phone's autofill service that unlocks with its device key." },
  { name: "vault.devices", callers: ["cli", "local", "deck", "capsule"], method: "devices", input: obj({}),
    description: "Browsers paired for autofill, when each was last seen and how many sessions it has open." },
  { name: "vault.device.revoke", callers: ["cli", "local", "deck", "capsule"], method: "revokeDevice", input: obj({ id: str }, ["id"]),
    description: "Unpair a browser: its token and every session it holds stop working now." },
  { name: "vault.device.unlock", callers: ["cli", "local"], method: "unlockDevice", input: obj({ device: str }, ["device"]),
    presence: (f, i) => `Unlock autofill in ${f.deviceById(i && i.device)?.name || "a paired browser"} for 30 minutes`,
    description: "Open an autofill session for a paired browser without a passphrase, after Touch ID. Returns no token." },
  { name: "vault.unlock-passphrase", callers: ["cli", "local"], method: "setUnlockPassphrase", input: obj({ passphrase: str }, ["passphrase"]),
    presence: () => "Set the passphrase that unlocks autofill in paired browsers",
    description: "Set the passphrase a paired browser types to unlock autofill. Changing it ends every session." },
];
