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

const b64url = n => crypto.randomBytes(n).toString("base64url");
const hash = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const same = (a, b) => crypto.timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
export const bodyHash = raw => crypto.createHash("sha256").update(raw || "").digest("base64url");

/** The session a request carries, and how: the cookie, or the bearer header. Null for none. @param {any} headers */
export function carried(headers) {
  const auth = String(headers.authorization || "");
  const m = /^Vyre ([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{16,128})$/.exec(auth);
  if (m) return { kind: "bearer", id: m[1], secret: m[2] };
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
  /** @param {{ db: import("node:sqlite").DatabaseSync, now?: () => number }} o */
  constructor({ db, now = Date.now }) {
    this.db = db;
    this.now = now;
    migrate(db, "presence", MIGRATIONS);
    /** Nonces seen on bearer proofs, with when each can be forgotten. @type {Map<string, number>} */
    this.nonces = new Map();
  }

  /**
   * A new session on this node. `cookie` for the Deck at the box's address; `bearer` only
   * through exchange(), which binds the app's key.
   * @param {{ node: string, kind?: "cookie"|"bearer", label?: string|null, key?: any }} o
   */
  start({ node, kind = "cookie", label = null, key = null }) {
    if (!node) throw Object.assign(new Error("a person session is made on a tailnet device, and this request has none"), { code: "denied" });
    const now = this.now();
    this.prune();
    const id = b64url(12), secret = b64url(32);
    this.db.prepare("INSERT INTO presence_people (id, hash, kind, node, label, key, created, last_used, max) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, hash(secret), kind, node, label ? String(label).slice(0, 80) : null, key ? JSON.stringify(key) : null, now, now, now + MAX);
    return { id, secret, token: `${id}.${secret}`, expires: Math.min(now + IDLE, now + MAX) };
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
   * @param {{ code: string, verifier: string, key: any, node: string, origin: string|null }} o
   */
  exchange({ code, verifier, key, node, origin }) {
    const row = /** @type {any} */ (this.db.prepare("SELECT * FROM presence_person_codes WHERE hash = ?").get(hash(code || "")));
    if (row) this.db.prepare("DELETE FROM presence_person_codes WHERE hash = ?").run(row.hash);
    if (!row || row.expires <= this.now()) return { error: { code: "denied", message: "that sign-in code is used or expired; sign in again" } };
    if (row.node !== node) return { error: { code: "denied", message: "that sign-in code was made on another device" } };
    if (!origin || row.origin !== origin) return { error: { code: "denied", message: "that sign-in code is for another app" } };
    const cc = crypto.createHash("sha256").update(String(verifier || "")).digest("base64url");
    if (!same(cc, row.cc)) return { error: { code: "denied", message: "the verifier does not match the sign-in" } };
    if (!key || key.kty !== "EC" || key.crv !== "P-256" || typeof key.x !== "string" || typeof key.y !== "string" || key.d) {
      return { error: { code: "bad_input", message: "key must be the public JWK of an ES256 key" } };
    }
    try { crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: key.x, y: key.y }, format: "jwk" }); }
    catch { return { error: { code: "bad_input", message: "key is not a P-256 public key" } }; }
    const s = this.start({ node, kind: "bearer", label: row.label, key: { kty: "EC", crv: "P-256", x: key.x, y: key.y } });
    return { data: { token: s.token, expires: s.expires, id: s.id } };
  }

  /**
   * Does this request carry a live session made on this node? For a bearer, the request must
   * also be signed by the session's key, fresh and never seen before.
   * @param {{ headers: any, node: string|null, method?: string, path?: string, raw?: string }} r
   * @returns {{ ok: true, id: string, kind: string } | { ok: false, why: string } | null} null when none is carried
   */
  check({ headers, node, method = "GET", path = "/", raw = "" }) {
    const c = carried(headers);
    if (!c) return null;
    const now = this.now();
    const row = /** @type {any} */ (this.db.prepare("SELECT * FROM presence_people WHERE id = ?").get(c.id));
    if (!row || !same(hash(c.secret), row.hash)) return { ok: false, why: "no such session; sign in again" };
    if (row.kind !== c.kind) return { ok: false, why: "that session is not carried that way" };
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
    if (now - row.last_used > TOUCH) this.db.prepare("UPDATE presence_people SET last_used = ? WHERE id = ?").run(now, row.id);
    return { ok: true, id: row.id, kind: row.kind };
  }

  /** Every live session, never a secret or a key. */
  list() {
    this.prune();
    return /** @type {any[]} */ (this.db.prepare("SELECT id, kind, node, label, created, last_used, max FROM presence_people ORDER BY last_used DESC").all())
      .map(r => ({ id: r.id, kind: r.kind, node: r.node, label: r.label, created: r.created, last_used: r.last_used, expires: Math.min(r.last_used + IDLE, r.max) }));
  }

  /** @param {string} id */
  revoke(id) {
    return Number(this.db.prepare("DELETE FROM presence_people WHERE id = ?").run(String(id)).changes) > 0;
  }

  prune() {
    const now = this.now();
    this.db.prepare("DELETE FROM presence_people WHERE max <= ? OR last_used <= ?").run(now, now - IDLE);
  }
}
