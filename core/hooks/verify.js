// @ts-check
// verify: how a hook route tells a real delivery from anyone on the internet. Pure, so each is tested alone.
//
// Two kinds of check. A Flow's own address uses the token scheme: an unguessable token Vyre made
// (32 random bytes, in the Vault), carried in the address itself or in an Authorization: Bearer
// header. A route opened by hand, or a Flow's address under "verify a signature", also checks the
// sender's own signature over the raw body (hmac-sha256, github, stripe). A route with neither
// cannot be opened. Every comparison is constant time, and nothing here puts the secret, the token
// or the signature it expects into a return value: a refusal says which check failed, never what
// the right answer was.

import crypto from "node:crypto";

/** The schemes, and the header each reads when the route does not name one. */
export const SCHEMES = {
  // A hex HMAC-SHA256 of the raw body, in a header the route names (a form service, a shop).
  "hmac-sha256": { header: null },
  // GitHub: X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>.
  github: { header: "x-hub-signature-256" },
  // Stripe: Stripe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">[,v1=...].
  stripe: { header: "stripe-signature" },
};

/** The token scheme: what a Flow's own address carries. Not a signature, so not in SCHEMES (a route opened by hand names a signature). */
export const TOKEN = "token";
/** The shortest stored token the token scheme accepts: 32 bytes as hex. A shorter one is a route set up wrong, refused before anything is compared. */
export const TOKEN_MIN = 64;
/** The longest token a delivery may offer; anything longer is refused after the same comparison. */
const TOKEN_MAX = 512;

/** How far a Stripe timestamp may be from now, either way, before the delivery is a replay. */
export const TOLERANCE_S = 300;

const HEX64 = /^[0-9a-f]{64}$/i;

/** @param {string} secret @param {Buffer[]} parts */
const mac = (secret, ...parts) => {
  const h = crypto.createHmac("sha256", secret);
  for (const p of parts) h.update(p);
  return h.digest();
};

/** Does the hex string equal the digest? Constant time over the digest's length. */
function same(digest, hex) {
  if (typeof hex !== "string" || !HEX64.test(hex)) return false;
  return crypto.timingSafeEqual(digest, Buffer.from(hex, "hex"));
}

/** One header's value, as Node gives it (a string, or for a repeated header an array). */
const one = v => Array.isArray(v) ? v.join(",") : typeof v === "string" ? v : "";

/** The token of an Authorization: Bearer header, or "". @param {Record<string, string | string[] | undefined>} headers */
export function bearer(headers) {
  const m = /^Bearer[ \t]+([^\s,]+)[ \t]*$/i.exec(one(headers && headers.authorization).trim());
  return m ? m[1] : "";
}

/**
 * Does the offered token equal the stored one? Both are hashed to 32 bytes first and those are compared with timingSafeEqual, so the time taken does not depend on how much of the token is right, on
 * its length, or on whether one was offered at all: a wrong, a missing and a short token each take the same one comparison.
 * @param {string} stored @param {string} given
 */
export function sameToken(stored, given) {
  const g = typeof given === "string" && given.length <= TOKEN_MAX ? given : "";
  const a = crypto.createHash("sha256").update(String(stored)).digest(), b = crypto.createHash("sha256").update(g).digest();
  return crypto.timingSafeEqual(a, b) && g.length > 0;
}

/**
 * Check one delivery.
 * @param {{ scheme: string, header?: string }} route
 * @param {Record<string, string | string[] | undefined>} headers lowercased, as Node gives them
 * @param {Buffer} body the raw bytes, exactly as they arrived
 * @param {string} secret the signing secret, or for the token scheme the stored token
 * @param {number} nowMs
 * @param {string} [token] the token the address carried (the token scheme); without one, the Authorization: Bearer header is read
 * @returns {{ ok: true } | { ok: false, why: string }}
 */
export function verify(route, headers, body, secret, nowMs, token = "") {
  if (typeof secret !== "string" || !secret) return { ok: false, why: "the route's secret is empty" };
  if (route.scheme === TOKEN) {
    if (secret.length < TOKEN_MIN) return { ok: false, why: "the route's token is too short to be safe; get a new address" };
    const given = token || bearer(headers);
    // Compared whatever was offered, an empty token included, so a refusal takes the same time as an acceptance.
    const same = sameToken(secret, given);
    if (!given) return { ok: false, why: "no token, in the address or an Authorization: Bearer header" };
    return same ? { ok: true } : { ok: false, why: "the token does not match" };
  }
  const s = SCHEMES[/** @type {keyof typeof SCHEMES} */ (route.scheme)];
  if (!s) return { ok: false, why: "the route has no signature scheme" };
  const name = String(route.header || s.header || "").toLowerCase();
  const raw = one(headers[name]).trim();
  if (!raw) return { ok: false, why: `no ${name} header` };

  if (route.scheme === "hmac-sha256") {
    return same(mac(secret, body), raw.replace(/^sha256=/i, "")) ? { ok: true } : { ok: false, why: "the signature does not match" };
  }
  if (route.scheme === "github") {
    if (!raw.startsWith("sha256=")) return { ok: false, why: "the signature is not sha256=<hex>" };
    return same(mac(secret, body), raw.slice(7)) ? { ok: true } : { ok: false, why: "the signature does not match" };
  }
  // Stripe. Exactly one t=, any number of v1= (Stripe sends two while a secret is being rolled).
  const ts = [], v1 = [];
  for (const part of raw.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") ts.push(v);
    else if (k === "v1") v1.push(v);
  }
  if (ts.length !== 1 || !/^\d{1,12}$/.test(ts[0])) return { ok: false, why: "the signature has no single t= timestamp" };
  if (!v1.length) return { ok: false, why: "the signature has no v1=" };
  const t = Number(ts[0]);
  if (Math.abs(nowMs / 1000 - t) > TOLERANCE_S) return { ok: false, why: `the timestamp is more than ${TOLERANCE_S / 60} minutes from now` };
  const want = mac(secret, Buffer.from(`${ts[0]}.`), body);
  // Every candidate is compared, so how many there are and which matched does not show in the time.
  let ok = false;
  for (const v of v1) ok = same(want, v) || ok;
  return ok ? { ok: true } : { ok: false, why: "the signature does not match" };
}

/**
 * The header value a sender would put on this body: for tests, and for the user checking a route
 * by hand. Never called on a real delivery.
 * @param {string} scheme @param {string} secret @param {Buffer|string} body @param {number} [tSeconds]
 */
export function sign(scheme, secret, body, tSeconds = Math.floor(Date.now() / 1000)) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (scheme === "stripe") return `t=${tSeconds},v1=${mac(secret, Buffer.from(`${tSeconds}.`), b).toString("hex")}`;
  const hex = mac(secret, b).toString("hex");
  return scheme === "github" ? `sha256=${hex}` : hex;
}
