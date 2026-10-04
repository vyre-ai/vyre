// @ts-check
// The person session: which requests over the network are the person, not only their device.
//
// Over the tailnet the box knows a request's node and its login (whois), and every node signed in
// as the owner is the owner's device. A script on that Mac or phone is too, so the device alone
// never makes a person's action (answering an ask, approving, a terminal, a vault secret). The
// person signs in once per browser with a passkey (presence.person.start); that makes a session pinned to
// the node it was made on, lasting 30 days from its last use and 90 at most, listed and revocable.
//
// Two carriers:
// - cookie: the Deck and the phone at the box's own address. `__Host-vyre_person`, HttpOnly,
//   Secure, SameSite=Strict, so no page script reads it and no other site sends it.
// - bearer: the hosted app at another origin (app.vyre.run), where a cookie would be third-party.
//   The app goes to the box's own sign-in page with a PKCE challenge, gets a one-time code back,
//   and trades it with the verifier and the public half of a non-extractable key for a token
//   (`authorization: Vyre <id>.<secret>`). Every request is signed with that key
//   (`x-vyre-proof: t=<ms> n=<nonce> sig=<b64url>`), so the token alone is not enough.
//
// What it cannot do: a process of the same user can read a browser's storage from disk. The
// session raises the bar from one curl to stealing a browser's store; presence proofs (a passkey
// or Touch ID each time) stay the hard line for HUMAN_ONLY.

import crypto from "node:crypto";
import { migrate } from "../store/index.js";
import { MIGRATIONS } from "./index.js";

export const COOKIE = "__Host-vyre_person";
const DAY = 86_400_000;
export const IDLE = 30 * DAY;
export const MAX = 90 * DAY;
const CODE_TTL = 60_000;
const SKEW = 60_000;
// last_used is written at most this often, so a busy Deck does not write on every call.
const TOUCH = 60_000;
// A paired device's last use is shown and written at most hourly.
const TOUCH_PAIRED = 3_600_000;
export const GRANT_TTL = 10 * 60_000;
const GRANT_TRIES = 3;
// A paired session's secret is replaced at least this often, signed by the device's key.
export const ROTATE_EVERY = 30 * DAY;
// No maximum life: the far end of the clock, so every `max` comparison still reads.
const NEVER = Number.MAX_SAFE_INTEGER;
const jwkOk = k => k && k.kty === "EC" && k.crv === "P-256" && typeof k.x === "string" && typeof k.y === "string" && !k.d;
// A paired session that has not rotated within this long after it was due accepts only the rotation.
const ROTATE_GRACE = 3 * DAY;
/** What a device signs to turn its grant into a session: its id and the challenge this box made for that grant. */
export const pairedStart = ({ device, challenge }) => `paired-start\n${device}\n${challenge}`;
/** What a paired session signs to get a new secret. */
export const pairedRotate = ({ id, t, n }) => `paired-rotate\n${id}\n${t}\n${n}`;

const b64url = n => crypto.randomBytes(n).toString("base64url");
const hash = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const same = (a, b) => crypto.timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
export const bodyHash = raw => crypto.createHash("sha256").update(raw || "").digest("base64url");


/**
 * Did something other than this origin's own page start this request? The cookie is the person's only when the browser says the request is
 * same-origin, or "none" (the person typed the address, followed a bookmark or a notification), or says nothing (curl, a native client, an
 * old browser). Cross-site is refused (an opaque-origin frame counts as cross-site even to the same host), and so is same-site: vyre.run is not
 * on the Public Suffix List, so every box's <name>.vyre.run is same-site with every other box's, and a SameSite=Strict cookie still rides a
 * request from one box's page to another (reviewer-2, 2 Oct 2026). A frame, iframe, embed or object load that is not from this origin is refused too.
 * @param {any} headers
 */
export function foreignFetch(headers) {
  const site = String(headers["sec-fetch-site"] || "").toLowerCase();
  const dest = String(headers["sec-fetch-dest"] || "").toLowerCase();
  if (site !== "" && site !== "same-origin" && site !== "none") return true;
  return ["iframe", "frame", "embed", "object"].includes(dest) && site !== "" && site !== "same-origin";
}

/** The session a request carries, and how: the cookie, or the bearer header. Null for none. @param {any} headers */
export function carried(headers) {
  const auth = String(headers.authorization || "");
  const m = /^Vyre ([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{16,128})$/.exec(auth);
  if (m) return { kind: "bearer", id: m[1], secret: m[2] };
  // A cookie is sent by the browser with whatever the page asks for, and WebKit judges SameSite from the top frame, so a sandboxed
  // artifact frame that navigates itself to this origin carries it even as SameSite=Strict. Browsers say who started the request:
  // a request from another site, or a frame, embed or object load that is not from this origin, is not the person's own.
  if (foreignFetch(headers)) return null;
  for (const part of String(headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k !== COOKIE) continue;
    const c = /^([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{16,128})$/.exec(v.join("="));
    if (c) return { kind: "cookie", id: c[1], secret: c[2] };
  }
  return null;
}

/** `t=<ms> n=<nonce> sig=<b64url>`. @param {unknown} h */
function parseProof(h) {
  const out = {};
  for (const part of String(h || "").trim().split(/\s+/)) {
    const m = /^(t|n|sig)=([A-Za-z0-9_-]+)$/.exec(part);
    if (!m || m[1] in out) return null;
    out[m[1]] = m[2];
  }
  return out.t && out.n && out.sig ? out : null;
}

/** What the hosted app signs for one request. */
export const signed = ({ method, path, raw, t, n }) => `${String(method).toUpperCase()}\n${path}\n${bodyHash(raw)}\n${t}\n${n}`;

export class PersonSessions {
  /** @param {{ db: import("node:sqlite").DatabaseSync, now?: () => number, softwareCap?: boolean }} o */
  constructor({ db, now = Date.now, softwareCap = false }) {
    this.db = db;
    // A space's standing rule: a device that keeps its key in software gets the 90-day cap back. Off by default.
    this.softwareCap = Boolean(softwareCap);
    this.now = now;
    migrate(db, "presence", MIGRATIONS);
    /** Nonces seen on bearer proofs, with when each can be forgotten. @type {Map<string, number>} */
    this.nonces = new Map();
  }

  /**
   * A new session on this node. `cookie` for the Deck at the box's address; `bearer` only
   * through exchange(), which binds the app's key.
   * `keyId` is the presence key whose proof opened it, so removing that key ends the session.
   * @param {{ node: string, kind?: "cookie"|"bearer", label?: string|null, key?: any, keyId?: string|null, paired?: boolean, software?: boolean, strength?: string|null }} o
   */
  start({ node, kind = "cookie", label = null, key = null, keyId = null, paired = false, software = false, strength = null }) {
    if (!node) throw Object.assign(new Error("a person session is made on a tailnet device, and this request has none"), { code: "denied" });
    const now = this.now();
    this.prune();
    const id = b64url(12), secret = b64url(32);
    this.db.prepare("INSERT INTO presence_people (id, hash, kind, node, label, key, created, last_used, max, key_id, paired, rotated, software, strength) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, hash(secret), kind, node, label ? String(label).slice(0, 80) : null, key ? JSON.stringify(key) : null, now, now, paired && !(software && this.softwareCap) ? NEVER : now + MAX, keyId ? String(keyId) : null, paired ? 1 : 0, paired ? now : null, software ? 1 : 0, strength ? String(strength).slice(0, 40) : null);
    return { id, secret, token: `${id}.${secret}`, expires: paired && !(software && this.softwareCap) ? now + IDLE : Math.min(now + IDLE, now + MAX) };
  }

  /**
   * A one-time code for the hosted app, bound to the PKCE challenge and this node. The sign-in
   * page on the box hands it back to the app, which trades it at /v1/person/token.
   * The code is also bound to the app's origin, which the caller has checked against the allowed
   * list: only that origin may trade it.
   * @param {{ node: string, cc: string, origin: string, label?: string|null }} o
   */
  code({ node, cc, origin, label = null }) {
    if (!node) throw Object.assign(new Error("a person session is made on a tailnet device, and this request has none"), { code: "denied" });
    if (!/^[A-Za-z0-9_-]{43}$/.test(String(cc))) throw Object.assign(new Error("cc must be a base64url SHA-256 (PKCE S256)"), { code: "bad_input" });
    const code = b64url(24);
    this.db.prepare("DELETE FROM presence_person_codes WHERE expires <= ?").run(this.now());
    this.db.prepare("INSERT INTO presence_person_codes (hash, cc, node, origin, label, expires) VALUES (?,?,?,?,?,?)")
      .run(hash(code), String(cc), node, String(origin), label ? String(label).slice(0, 80) : null, this.now() + CODE_TTL);
    return { code, expires: this.now() + CODE_TTL };
  }

  /**
   * Trade a code, its PKCE verifier and the app's public key for a bearer session. Used once.
   * A native app's code (vyre://) must come with the trade signed by the key it registers
   * (`request`: the trade's own headers, path and body), so an intercepted code and verifier
   * are not enough without the app's hardware key.
   * @param {{ code: string, verifier: string, key: any, node: string, origin: string|null, request?: { headers: any, method: string, path: string, raw: string } }} o
   */
  exchange({ code, verifier, key, node, origin, request }) {
    const row = /** @type {any} */ (this.db.prepare("SELECT * FROM presence_person_codes WHERE hash = ?").get(hash(code || "")));
    if (row) this.db.prepare("DELETE FROM presence_person_codes WHERE hash = ?").run(row.hash);
    if (!row || row.expires <= this.now()) return { error: { code: "denied", message: "that sign-in code is used or expired; sign in again" } };
    if (row.node !== node) return { error: { code: "denied", message: "that sign-in code was made on another device" } };
    // A loopback or native code is traded by the Mac's vyred or the app, which send no Origin; any
    // other only by its web app.
    const noOrigin = row.origin === "loopback" || row.origin === "app:vyre";
    if (noOrigin ? origin : (!origin || row.origin !== origin)) return { error: { code: "denied", message: "that sign-in code is for another app" } };
    const cc = crypto.createHash("sha256").update(String(verifier || "")).digest("base64url");
    if (!same(cc, row.cc)) return { error: { code: "denied", message: "the verifier does not match the sign-in" } };
    if (!key || key.kty !== "EC" || key.crv !== "P-256" || typeof key.x !== "string" || typeof key.y !== "string" || key.d) {
      return { error: { code: "bad_input", message: "key must be the public JWK of an ES256 key" } };
    }
    let pub;
    try { pub = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: key.x, y: key.y }, format: "jwk" }); }
    catch { return { error: { code: "bad_input", message: "key is not a P-256 public key" } }; }
    if (row.origin === "app:vyre") {
      const p = request && parseProof(request.headers["x-vyre-proof"]);
      const t = p ? Number(p.t) : NaN;
      let good = false;
      if (p && Number.isFinite(t) && Math.abs(this.now() - t) <= SKEW) {
        try { good = crypto.verify("sha256", Buffer.from(signed({ method: request.method, path: request.path, raw: request.raw, t: p.t, n: p.n })), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(p.sig, "base64url")); } catch {}
      }
      if (!good) return { error: { code: "denied", message: "the app must sign this trade with the key it registers" } };
    }
    const s = this.start({ node, kind: "bearer", label: row.label, key: { kty: "EC", crv: "P-256", x: key.x, y: key.y } });
    return { data: { token: s.token, expires: s.expires, id: s.id }, native: row.origin === "app:vyre" || row.origin === "loopback", label: row.label };
  }

  /**
   * Does this request carry a live session made on this node? For a bearer, the request must
   * also be signed by the session's key, fresh and never seen before.
   * @param {{ headers: any, node: string|null, method?: string, path?: string, raw?: string }} r
   * A session whose presence key was removed (Presence.remove) is gone, but the credential it held
   * still checks against what was remembered for 30 days: the answer is `removed: true`, and only a
   * holder of that real credential gets it. Anything else, a guess or a stranger's cookie, gets the
   * same "no such session" as before, so nothing says which keys or sessions ever existed.
   * @returns {{ ok: true, id: string, kind: string } | { ok: false, why: string, removed?: true } | null} null when none is carried
   */
  check({ headers, node, method = "GET", path = "/", raw = "" }) {
    const c = carried(headers);
    if (!c) return null;
    const now = this.now();
    const row = /** @type {any} */ (this.db.prepare("SELECT * FROM presence_people WHERE id = ?").get(c.id));
    if (!row) {
      const gone = /** @type {any} */ (this.db.prepare("SELECT hash FROM presence_removed WHERE id = ? AND kind = 'session' AND removed > ?").get(c.id, now - 30 * DAY));
      if (gone && gone.hash && same(hash(c.secret), gone.hash)) return { ok: false, removed: true, why: "this device was removed" };
      return { ok: false, why: "no such session; sign in again" };
    }
    if (!same(hash(c.secret), row.hash)) return { ok: false, why: "no such session; sign in again" };
    // A command-line session (`vyre signin`) travels as the bearer header but is signed by no key: it is pinned to the terminal login it was made for (node `cli:<login key>`, which the daemon measures
    // from the kernel's own view of the peer and never reads from the call), so a program that is not in that login cannot present it.
    if (row.kind !== c.kind && !(row.kind === "cli" && c.kind === "bearer")) return { ok: false, why: "that session is not carried that way" };
    if (row.max <= now || row.last_used + IDLE <= now) return { ok: false, why: "the session has lapsed; sign in again" };
    if (!node || row.node !== node) return { ok: false, why: "that session was made on another device" };
    if (row.kind === "bearer") {
      const p = parseProof(headers["x-vyre-proof"]);
      if (!p) return { ok: false, why: "the request is not signed (x-vyre-proof)" };
      const t = Number(p.t);
      if (!Number.isFinite(t) || Math.abs(now - t) > SKEW) return { ok: false, why: "the request's signature is stale; check the device clock" };
      const seen = `${row.id}:${p.n}`;
      for (const [k, until] of this.nonces) if (until <= now) this.nonces.delete(k);
      if (this.nonces.has(seen)) return { ok: false, why: "that signed request was already used" };
      let good = false;
      try {
        const pub = crypto.createPublicKey({ key: JSON.parse(row.key), format: "jwk" });
        good = crypto.verify("sha256", Buffer.from(signed({ method, path, raw, t: p.t, n: p.n })), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(p.sig, "base64url"));
      } catch {}
      if (!good) return { ok: false, why: "the request's signature does not match the session's key" };
      this.nonces.set(seen, now + 2 * SKEW);
      if (this.nonces.size > 10_000) this.nonces.delete(/** @type {string} */ (this.nonces.keys().next().value));
    }
    if (now - row.last_used > (row.paired ? TOUCH_PAIRED : TOUCH)) this.db.prepare("UPDATE presence_people SET last_used = ? WHERE id = ?").run(now, row.id);
    if (row.paired) {
      const age = now - (row.rotated || row.created);
      // Past the grace the secret is only good for the one call that replaces it (a leaked secret dies by day 33).
      return { ok: true, id: row.id, kind: row.kind, paired: true, rotateDue: age >= ROTATE_EVERY, ...(age >= ROTATE_EVERY + ROTATE_GRACE ? { rotateOnly: true } : {}) };
    }
    return { ok: true, id: row.id, kind: row.kind };
  }

  /**
   * The strength of a live session, for a module that relays a paired device's act: one of STRENGTHS (core/presence/strengths.js: software, enclave, "enclave, unattested", passkey), or null when there is no such session. A row records its opening proof's strength (the `strength` column, startPaired's) and answers with that; an older paired row records none and reads as software (fail closed, so that device proves its key again), any other
   * older row keeps its `software` flag. @param {string} id @returns {string|null}
   */
  strength(id) {
    const row = /** @type {any} */ (this.db.prepare("SELECT software, strength, paired FROM presence_people WHERE id = ?").get(String(id)));
    if (!row) return null;
    if (typeof row.strength === "string" && row.strength) return row.strength;
    // No recorded strength: a paired device's session proved nothing about its key (fail closed); any other row keeps its flag.
    return row.paired || row.software ? "software" : "enclave";
  }

  /**
   * The pairing's one-use grant for a device. Written only by the pairing's owner-confirmed path
   * (the tool checks the caller and reads the pair record); a device with a live grant or a live
   * paired session is replaced, never stacked.
   * @param {{ device: string, keyId: string, deviceKey: any, software?: boolean }} o
   */
  grant({ device, keyId, deviceKey, software = false }) {
    if (!device || !keyId || !jwkOk(deviceKey)) throw Object.assign(new Error("a grant needs the device, the confirming key and the device's public key"), { code: "bad_input" });
    const now = this.now();
    this.prune();
    // Replace, never stack: whatever this device held before ends now.
    this.endDevice(device);
    const challenge = b64url(24);
    this.db.prepare("INSERT INTO presence_pair_grants (device, key_id, device_key, challenge, software, created, expires, tries) VALUES (?,?,?,?,?,?,?,0)")
      .run(String(device), String(keyId), JSON.stringify({ kty: "EC", crv: "P-256", x: deviceKey.x, y: deviceKey.y }), challenge, software ? 1 : 0, now, now + GRANT_TTL);
    return { expires: now + GRANT_TTL, challenge };
  }

  /** Whether a device holds a pairing grant or a live paired session now: a renewal never replaces either. @param {string} device */
  holds(device) {
    this.prune();
    const now = this.now();
    if (this.db.prepare("SELECT 1 FROM presence_pair_grants WHERE device = ?").get(String(device || ""))) return true;
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT last_used, max FROM presence_people WHERE node = ? AND paired = 1").all(String(device || "")));
    return rows.some(r => Math.min(r.last_used + IDLE, r.max) > now);
  }

  /**
   * The challenge for a device's grant, for the device to sign. A device with no grant gets a
   * random one of the same shape, so nothing says whether a grant exists.
   * @param {string} device
   */
  challengeFor(device) {
    this.prune();
    const row = /** @type {any} */ (this.db.prepare("SELECT challenge FROM presence_pair_grants WHERE device = ?").get(String(device || "")));
    return row ? String(row.challenge) : b64url(24);
  }

  /**
   * The device's first start: it proves it holds the key the owner confirmed (a signature over its
   * id and the challenge this box made for the grant), and the grant becomes a session bound to
   * that key. A signed start from an earlier grant for the same device is worth nothing. One refusal
   * for no grant, an expired one, a used one and a wrong key; three wrong attempts delete it.
   * @param {{ device: string, sig: string, label?: string|null }} o
   * @returns {{ id: string, token: string, expires: number } | { refused: true, deleted?: boolean }}
   */
  startPaired({ device, sig, label = null }) {
    const now = this.now();
    this.prune();
    const row = /** @type {any} */ (this.db.prepare("SELECT * FROM presence_pair_grants WHERE device = ?").get(String(device || "")));
    if (!row) return { refused: true };
    let good = false;
    try {
      const pub = crypto.createPublicKey({ key: JSON.parse(row.device_key), format: "jwk" });
      good = crypto.verify("sha256", Buffer.from(pairedStart({ device: row.device, challenge: row.challenge })), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(String(sig || ""), "base64url"));
    } catch {}
    if (!good) {
      const tries = row.tries + 1;
      if (tries >= GRANT_TRIES) { this.db.prepare("DELETE FROM presence_pair_grants WHERE device = ?").run(row.device); return { refused: true, deleted: true }; }
      this.db.prepare("UPDATE presence_pair_grants SET tries = ? WHERE device = ?").run(tries, row.device);
      return { refused: true };
    }
    // One use: the row goes and the session exists together, or neither.
    let s;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const gone = this.db.prepare("DELETE FROM presence_pair_grants WHERE device = ? AND tries = ?").run(row.device, row.tries);
      if (!Number(gone.changes)) { this.db.exec("ROLLBACK"); return { refused: true }; }
      s = this.start({ node: row.device, kind: "bearer", label, key: JSON.parse(row.device_key), keyId: row.key_id, paired: true, software: Boolean(row.software), strength: row.software ? "software" : "enclave" });
      this.db.exec("COMMIT");
    } catch (e) { try { this.db.exec("ROLLBACK"); } catch {} throw e; }
    return { id: s.id, token: s.token, expires: s.expires };
  }

  /**
   * A paired session gets a new secret, signed by the device's key, so a secret seen once does
   * not live for ever. The old secret stops working at once.
   * @param {{ id: string, t: string, n: string, sig: string }} o
   */
  rotate({ id, t, n, sig }) {
    const now = this.now();
    const row = /** @type {any} */ (this.db.prepare("SELECT * FROM presence_people WHERE id = ? AND paired = 1").get(String(id || "")));
    if (!row) return null;
    const ts = Number(t);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(n)) || !Number.isFinite(ts) || Math.abs(now - ts) > SKEW) return null;
    let good = false;
    try {
      const pub = crypto.createPublicKey({ key: JSON.parse(row.key), format: "jwk" });
      good = crypto.verify("sha256", Buffer.from(pairedRotate({ id: row.id, t: String(t), n })), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(String(sig || ""), "base64url"));
    } catch {}
    if (!good) return null;
    const secret = b64url(32);
    this.db.prepare("UPDATE presence_people SET hash = ?, rotated = ? WHERE id = ?").run(hash(secret), now, row.id);
    return { id: row.id, token: `${row.id}.${secret}`, expires: now + IDLE };
  }

  /**
   * End everything a device holds: its grant and its sessions (the device was removed, its key left
   * the identity list, or the owner reset or signed out everywhere). Without a device, every paired
   * session and grant. A holder of the real credential is then told "this device was removed".
   * @param {string} [device]
   */
  endDevice(device) {
    const now = this.now();
    const rows = /** @type {any[]} */ (device
      ? this.db.prepare("SELECT id, hash FROM presence_people WHERE node = ? AND paired = 1").all(String(device))
      : this.db.prepare("SELECT id, hash FROM presence_people WHERE paired = 1").all());
    for (const r of rows) {
      this.db.prepare("INSERT OR REPLACE INTO presence_removed (id, kind, hash, key_id, removed) VALUES (?, 'session', ?, NULL, ?)").run(r.id, r.hash, now);
      this.db.prepare("DELETE FROM presence_people WHERE id = ?").run(r.id);
    }
    const g = device ? this.db.prepare("DELETE FROM presence_pair_grants WHERE device = ?").run(String(device)) : this.db.prepare("DELETE FROM presence_pair_grants").run();
    return rows.length + Number(g.changes);
  }

  /** Every live session, never a secret or a key. */
  list() {
    this.prune();
    return /** @type {any[]} */ (this.db.prepare("SELECT id, kind, node, label, created, last_used, max, paired, software FROM presence_people ORDER BY last_used DESC").all())
      .map(r => ({ id: r.id, kind: r.kind, node: r.node, label: r.label, created: r.created, last_used: r.last_used, expires: Math.min(r.last_used + IDLE, r.max), ...(r.paired ? { paired: true, ...(r.software ? { software: true } : {}) } : {}) }));
  }

  /** End every command-line session made for this terminal login (`vyre signout`). @param {string} node `cli:<login key>` @returns {number} */
  revokeNode(node) {
    return Number(this.db.prepare("DELETE FROM presence_people WHERE node = ? AND kind = 'cli'").run(String(node)).changes);
  }

  /** @param {string} id */
  revoke(id) {
    return Number(this.db.prepare("DELETE FROM presence_people WHERE id = ?").run(String(id)).changes) > 0;
  }

  prune() {
    const now = this.now();
    this.db.prepare("DELETE FROM presence_people WHERE max <= ? OR last_used <= ?").run(now, now - IDLE);
    this.db.prepare("DELETE FROM presence_pair_grants WHERE expires <= ?").run(now);
    this.db.prepare("DELETE FROM presence_removed WHERE removed <= ?").run(now - 30 * DAY);
  }
}
