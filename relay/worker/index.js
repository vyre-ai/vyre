// @ts-check
// The relay on Cloudflare (ADR 0026, section 2): a Worker in front and one Durable Object per route
// id. The same protocol as relay/node/server.js, message for message, so core/relay/link.js runs
// against either unchanged.
//
//   GET /v1/box?route=<id>                  the box's control socket, after a signed challenge
//   GET /v1/box?route=<id>&c=<conn>&t=<ticket>   the box's data socket for one device connection
//   GET /v1/device?route=<id>               a device; the relay tells the box, then pipes frames
//   POST /v1/pair                           resolve a Wink pairing ticket's or a setup offer's locator (ADR 0045)
//   POST /v1/setup/mbx                      append a line to a setup progress mailbox (the install script)
//   GET /v1/setup/mbx                       read it, long poll, signed by the setup page's key (tailnet plan 3.6b)
//   GET /health
//
// Hibernation: the DO holds no timers and no alarms, and keeps no state in instance fields. Every
// socket carries its role in a serialized attachment, frames buffered for a waiting device live in
// ctx.storage, and a text "ping" is answered at the edge without waking the object. An idle route
// costs nothing. No dependencies: WebCrypto only.
//
// Wink tickets (ADR 0045) get their own Durable Object, `PairTicket`, bound as `env.TICKETS`, one
// object per locator (`env.TICKETS.idFromName(loc)`) rather than living in `RouteRelay`: a
// resolve request carries only a locator, not a route id, so there is nothing to route it to a
// specific RouteRelay object by. `RouteRelay`'s control socket writes to it (`registerTicket`,
// below); `/v1/pair` reads it. Same contract as relay/node/server.js's `pairTickets` map: stores
// only what the box handed the relay (a sealed record, mac, exp), single-use (deleted on the one resolve
// that finds it, whether it answers or not), and never the pairing secret itself, which the relay
// never sees at all (core/relay/wire.js's ticketDerive).

/**
 * These repeat core/relay/wire.js, which uses node:crypto and so cannot load here.
 * relay/worker/worker.test.js checks that they match.
 */
export const BOX_AUTH_TAG = "vyre-relay-box-v1";
/** What this relay does that a box may rely on, told in `ready` (an older relay says nothing): `registered` answers every ticket registration with 200 or 409. */
export const FEATURES = Object.freeze(["registered"]);
export const LIMITS = Object.freeze({ waiting: 8, open: 32, buffered: 64, frame: 1 << 20 });
export const CLOSE = Object.freeze({ boxOffline: 4404, busy: 4429, refused: 4401, replaced: 4409, boxGone: 4410, deviceGone: 4411, tooBig: 1009 });
export const ROUTE_RE = /^[a-z2-7]{26}$/;

/**
 * A durable storage value holds at most 128 KiB, and a frame can be 1 MiB, so a buffered frame is
 * split into parts under keys `b/<conn>/<frame 3 digits>.<part 2 digits>`, which list in order.
 * The count cap (LIMITS.buffered frames per waiting connection, LIMITS.waiting connections) bounds
 * a route at 8 x 64 frames. Frames are only buffered between a device's first message and the
 * box's data socket, normally one round trip, and are deleted as soon as they are delivered or
 * the device leaves.
 */
const PART = 120 * 1024;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, no padding. @param {Uint8Array} buf */
export function base32(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** @param {Uint8Array} bytes */
export function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {string} s @returns {Uint8Array|null} */
export function unb64url(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(bin, ch => ch.charCodeAt(0));
  } catch { return null; }
}

const enc = new TextEncoder();
const random = n => crypto.getRandomValues(new Uint8Array(n));

/** The route id: the first 26 base32 characters of sha256 of the Ed25519 route key. @param {Uint8Array} pub */
export async function routeId(pub) {
  return base32(new Uint8Array(await crypto.subtle.digest("SHA-256", pub))).slice(0, 26);
}

/** @param {string} route @param {Uint8Array} challenge */
export function authMessage(route, challenge) {
  const head = enc.encode(`${BOX_AUTH_TAG}\n${route}\n`);
  const out = new Uint8Array(head.length + challenge.length);
  out.set(head);
  out.set(challenge, head.length);
  return out;
}

/** @param {Uint8Array} pub @param {Uint8Array} message @param {Uint8Array} sig */
export async function verifyRoute(pub, message, sig) {
  if (pub.length !== 32 || sig.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, message);
  } catch { return false; }
}

/** Compares two strings in time that depends only on their length. @param {string} a @param {string} b */
export function sameTicket(a, b) {
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length || x.length === 0) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

/** @param {string|ArrayBuffer|ArrayBufferView} m */
const size = m => typeof m === "string" ? enc.encode(m).length : m.byteLength;

/** ADR 0045's own ticket TTL (core/relay/wire.js's TICKET_TTL); repeated here so a box that ever
 * sent a wildly long exp cannot make a PairTicket object outlive what the mechanism promises. */
const TICKET_TTL_MAX = 5 * 60_000;
/** A setup offer and its mailbox live for the setup code's hour (core/relay/wire.js SETUP_TTL). */
const SETUP_TTL_MAX = 60 * 60_000;
const LOC_RE = /^[A-Za-z0-9_-]{20,64}$/;
/** A Wink record is ciphertext the box sealed under a key only the ticket gives (core/relay/wire.js
 * ticketSeal); anything else, a plaintext JSON record included, is refused, so the relay never
 * holds a box's name, handle or key in the clear. Same rule as relay/node/server.js. */
const SEALED = /^[A-Za-z0-9_-]{22,2048}$/;
// /v1/pair alone answers any origin (ADR 0045): a phone's page may be phone.vyre.run, a
// <handle>.vyre.run or a self-hosted box's own address, and the endpoint's safety is the ticket
// (an opaque locator, a sealed and MAC'd record), never the caller's origin. No credentials: it
// reads no cookies and sets none. Every other route stays without CORS.
const PAIR_CORS = { "access-control-allow-origin": "*" };
const PAIR_PREFLIGHT = { ...PAIR_CORS, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" };
/** @param {Response} r */
const withPairCors = r => { const out = new Response(r.body, r); for (const [k, v] of Object.entries(PAIR_CORS)) out.headers.set(k, v); return out; };
/** The setup mailbox is read by the setup page from vyre.run, so it answers any origin too, and for the same reason: its safety is a signature and a MAC'd, sealed stream, never the origin. */
const MBX_CORS = { "access-control-allow-origin": "*" };
const MBX_PREFLIGHT = { ...MBX_CORS, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type, x-vyre-setup-key, x-vyre-setup-ts, x-vyre-setup-sig", "access-control-max-age": "600" };
const withMbxCors = r => { const out = new Response(r.body, r); for (const [k, v] of Object.entries(MBX_CORS)) out.headers.set(k, v); return out; };
/** Mailbox limits, repeated from core/relay/wire.js (worker.test.js checks the line size). */
const MBX = Object.freeze({ bytes: 64 * 1024, line: 2048, lines: 512, skew: 120_000, batch: 64, waitMax: 25 });
const SETUP_TAG_KEY = "vyre-setup-key", SETUP_TAG_READ = "vyre-setup-read";
const P256_HEAD = "3059301306072a8648ce3d020106082a8648ce3d030107034200";
/** @param {Uint8Array} spki */
const isP256Spki = spki => spki.length === 91 && spki[26] === 4 && P256_HEAD.match(/../g).every((h, i) => spki[i] === parseInt(h, 16));
/** sha256("vyre-setup-key\n" || spki)[0:16], base64url: the fingerprint a setup code carries. @param {Uint8Array} spki */
export async function setupFingerprint(spki) {
  const head = enc.encode(`${SETUP_TAG_KEY}\n`);
  const all = new Uint8Array(head.length + spki.length);
  all.set(head); all.set(spki, head.length);
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", all)).slice(0, 16));
}
/** @param {string} loc @param {number} ts @param {number} after */
const mbxReadMessage = (loc, ts, after) => enc.encode(`${SETUP_TAG_READ}\n${loc}\n${ts}\n${after}`);
/** ECDSA P-256 over SHA-256, r || s. @param {Uint8Array} spki @param {Uint8Array} message @param {Uint8Array} sig */
async function verifyP256(spki, message, sig) {
  if (!isP256Spki(spki) || sig.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, message);
  } catch { return false; }
}
const sha256b64 = async s => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * The Worker: health, request checks, per-address limiting, then the route's Durable Object.
 * Per-address rate limiting uses Cloudflare's rate limiting binding when DEVICE_LIMITER is bound
 * (see wrangler.toml); without it, the DO's per-route caps are the only limit, and a Cloudflare
 * rate limiting rule on /v1/device is configured at deploy.
 */
export default {
  /** @param {Request} request @param {any} env */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
    if (!url.pathname.startsWith("/v1/")) return new Response(null, { status: 404 });
    if (url.pathname === "/v1/pair" && request.method === "OPTIONS") return new Response(null, { status: 204, headers: PAIR_PREFLIGHT });
    if (url.pathname === "/v1/pair" && request.method === "POST") return withPairCors(await onPairResolve(request, env));
    if (url.pathname === "/v1/setup/mbx" && request.method === "OPTIONS") return new Response(null, { status: 204, headers: MBX_PREFLIGHT });
    if (url.pathname === "/v1/setup/mbx" && (request.method === "POST" || request.method === "GET")) return withMbxCors(await onSetupMbx(request, url, env));
    if (String(request.headers.get("upgrade")).toLowerCase() !== "websocket") return new Response(null, { status: 426 });
    const route = url.searchParams.get("route") || "";
    if ((url.pathname !== "/v1/box" && url.pathname !== "/v1/device") || !ROUTE_RE.test(route)) return new Response(null, { status: 400 });
    if (url.pathname === "/v1/device" && env.DEVICE_LIMITER) {
      const who = request.headers.get("cf-connecting-ip") || "unknown";
      const { success } = await env.DEVICE_LIMITER.limit({ key: who });
      if (!success) return new Response(null, { status: 429 });
    }
    return env.ROUTES.get(env.ROUTES.idFromName(route)).fetch(request);
  },
};

/**
 * Resolve a Wink pairing ticket's locator (ADR 0045): a POST body, never a URL, so it never lands
 * in an access log. Single-use either way -- found or not, the PairTicket object it named is gone
 * after this call. Rate-limited per address (env.PAIR_LIMITER) and, if bound, globally
 * (env.PAIR_LIMITER_GLOBAL), the same optional-binding pattern DEVICE_LIMITER already uses for
 * /v1/device; a zone rate limiting rule covers it otherwise.
 * @param {Request} request @param {any} env
 */
async function onPairResolve(request, env) {
  const who = request.headers.get("cf-connecting-ip") || "unknown";
  if (env.PAIR_LIMITER) { const { success } = await env.PAIR_LIMITER.limit({ key: who }); if (!success) return json(429, { error: "too many pairing attempts; wait a minute" }); }
  if (env.PAIR_LIMITER_GLOBAL) { const { success } = await env.PAIR_LIMITER_GLOBAL.limit({ key: "*" }); if (!success) return json(429, { error: "too many pairing attempts; wait a minute" }); }
  if (!env.TICKETS) return json(404, { error: "this relay does not support scan-to-pair" });
  let body;
  try { body = await request.json(); } catch { return json(400, { error: "bad request" }); }
  const loc = String((body && body.loc) || "");
  if (!LOC_RE.test(loc)) return json(400, { error: "bad request" });
  const res = await env.TICKETS.get(env.TICKETS.idFromName(loc)).fetch("https://ticket/resolve", { method: "POST" });
  if (res.status === 409) return json(409, { error: "contested" });
  if (res.status !== 200) return json(404, { error: "this pairing code has expired or was already used" });
  return json(200, await res.json());
}

/**
 * The setup mailbox's front door (tailnet plan 3.6, 3.6b). Two callers, two proofs, and the relay
 * checks the second itself:
 *   POST  the install script appends a line: { loc, fp, wtok, line? }. `wtok` is a token derived
 *         from the setup secret (setupDerive "mbxw"); the first POST for a locator fixes it and the
 *         page key's fingerprint `fp` (also in the setup code) and every later POST must repeat both,
 *         or the locator is marked contested (first writer wins, as for the offer). The relay never
 *         holds a key that can read or forge a line: each is AES-256-CTR sealed and HMAC'd under keys
 *         only the secret gives, with its sequence number inside the HMAC.
 *   GET   the page reads, a long poll: ?loc=&after=&wait= with x-vyre-setup-key (its SPKI), -ts and
 *         -sig, an ECDSA signature over "vyre-setup-read\nloc\nts\nafter" (core/relay/wire.js
 *         mbxReadMessage). This is the simplest thing that meets "only the page's key may read":
 *         the relay holds fp from the writer, checks the SPKI hashes to it, and checks a signature
 *         no more than two minutes old that names this locator and this read position. Whoever has
 *         only the code has fp but neither the SPKI (a hash of it is all the code carries) nor the
 *         private key. A request replayed inside the window returns ciphertext to whoever saw the
 *         request, which is only the relay operator, who holds that ciphertext anyway.
 * Per-address limits (env.SETUP_LIMITER, env.SETUP_READ_LIMITER) and a global one on appends
 * (env.SETUP_LIMITER_GLOBAL), the same optional bindings /v1/pair uses, with a zone rule behind them.
 * The long poll lives here, not in the object: it asks the object once a second (env.SETUP_POLL_MS).
 * @param {Request} request @param {URL} url @param {any} env
 */
async function onSetupMbx(request, url, env) {
  const who = request.headers.get("cf-connecting-ip") || "unknown";
  const busy = () => json(429, { error: "too many setup requests; wait a minute" });
  if (!env.TICKETS) return json(404, { error: "this relay does not support setup" });
  const stub = loc => env.TICKETS.get(env.TICKETS.idFromName(loc));
  if (request.method === "POST") {
    if (env.SETUP_LIMITER && !(await env.SETUP_LIMITER.limit({ key: who })).success) return busy();
    if (env.SETUP_LIMITER_GLOBAL && !(await env.SETUP_LIMITER_GLOBAL.limit({ key: "*" })).success) return busy();
    const text = await request.text();
    if (text.length > 8 * 1024) return json(413, { error: "too big" });
    let m;
    try { m = JSON.parse(text); } catch { return json(400, { error: "bad request" }); }
    const loc = String((m && m.loc) || "");
    if (!LOC_RE.test(loc) || !/^[A-Za-z0-9_-]{22}$/.test(String(m.fp || "")) || !/^[A-Za-z0-9_-]{43}$/.test(String(m.wtok || ""))) return json(400, { error: "bad request" });
    const res = await stub(loc).fetch("https://ticket/mbx/append", { method: "POST", body: JSON.stringify({ fp: m.fp, wtok: m.wtok, line: m.line === undefined ? null : String(m.line) }) });
    return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
  }
  if (env.SETUP_READ_LIMITER && !(await env.SETUP_READ_LIMITER.limit({ key: who })).success) return busy();
  const loc = url.searchParams.get("loc") || "";
  const after = Number(url.searchParams.get("after") || 0);
  const wait = Math.min(Math.max(Number(url.searchParams.get("wait") || 0), 0), MBX.waitMax);
  if (!LOC_RE.test(loc) || !Number.isInteger(after) || after < 0) return json(400, { error: "bad request" });
  const read = { key: request.headers.get("x-vyre-setup-key") || "", ts: Number(request.headers.get("x-vyre-setup-ts") || 0), sig: request.headers.get("x-vyre-setup-sig") || "", after, loc };
  const deadline = Date.now() + wait * 1000, tick = Number(env.SETUP_POLL_MS) || 1000;
  for (;;) {
    const res = await stub(loc).fetch("https://ticket/mbx/read", { method: "POST", body: JSON.stringify(read) });
    const body = /** @type {any} */ (await res.json());
    // Nothing yet (no mailbox, or no new line) is the only answer that waits.
    if (res.status !== 200 || (body.lines && body.lines.length > 0) || Date.now() + tick > deadline) return json(res.status, body);
    await new Promise(r => setTimeout(r, tick));
  }
}

/**
 * One Wink pairing ticket (ADR 0045) or one setup offer (tailnet plan 3.6), keyed by its locator:
 * what a box's control socket registered (record, mac, exp). A Wink ticket is single-use; a setup
 * offer lives its hour and is read as often as the page needs, and the same object holds the setup
 * mailbox. FIRST WRITER WINS for both: a second register with a different record (or a different
 * mac) leaves the first in place, marks the locator contested and answers 409; the identical record
 * and mac again (a reconnect re-sending) answers 200. Once contested, resolve, append and read all
 * answer 409 until the object's exp. No timers, no alarm needed for correctness: expiry is checked
 * lazily on reads, and the alarm set at register time sweeps what nobody ever read.
 */
export class PairTicket {
  /** @param {any} ctx */
  constructor(ctx) { this.ctx = ctx; }

  /** Set an alarm no earlier than the one already there. @param {number} at */
  async alarmAtLeast(at) {
    const cur = await this.ctx.storage.getAlarm();
    if (!cur || cur < at) await this.ctx.storage.setAlarm(at);
  }

  /** @param {number} exp */
  async contest(exp) {
    const t = await this.ctx.storage.get("t");
    await this.ctx.storage.put("t", { ...(t || { exp }), contested: true });
    await this.alarmAtLeast(t ? t.exp : exp);
  }

  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    if (request.method === "PUT" && url.pathname === "/register") {
      let body;
      try { body = await request.json(); } catch { return new Response(null, { status: 400 }); }
      const record = String((body && body.record) || ""), mac = String((body && body.mac) || "");
      const setup = Boolean(body && body.setup);
      const exp = Math.min(Number(body && body.exp) || 0, now + (setup ? SETUP_TTL_MAX : TICKET_TTL_MAX));
      if (!SEALED.test(record) || !LOC_RE.test(mac) || exp <= now) return new Response(null, { status: 400 });
      const cur = await this.ctx.storage.get("t");
      if (cur && cur.exp > now) {
        if (cur.contested) return json(200, { status: 409 });
        if (cur.record === record && cur.mac === mac) return json(200, { status: 200 });
        await this.ctx.storage.put("t", { ...cur, contested: true });
        return json(200, { status: 409 });
      }
      await this.ctx.storage.put("t", { record, mac, exp, ...(setup ? { setup: true } : {}) });
      // A locator nobody ever resolves would otherwise sit in storage forever (reviewer's LOW,
      // 28 Sep): clean it up at its own exp either way, resolved or not.
      await this.alarmAtLeast(exp);
      return json(200, { status: 200 });
    }
    if (request.method === "POST" && url.pathname === "/resolve") {
      const t = await this.ctx.storage.get("t");
      if (t && t.exp > now && t.contested) return new Response(null, { status: 409 });
      if (t && !t.setup) { await this.ctx.storage.deleteAll(); await this.ctx.storage.deleteAlarm(); }
      if (!t || t.exp <= now || !t.record) return new Response(null, { status: 404 });
      return json(200, { record: t.record, mac: t.mac });
    }
    if (request.method === "POST" && url.pathname === "/mbx/append") {
      let body;
      try { body = await request.json(); } catch { return json(400, { error: "bad request" }); }
      const t = await this.ctx.storage.get("t");
      if (t && t.exp > now && t.contested) return json(409, { error: "contested" });
      const wh = await sha256b64(String(body.wtok));
      let m = await this.ctx.storage.get("m");
      if (m && m.exp <= now) { await this.ctx.storage.deleteAll(); m = undefined; }
      if (m && !(sameTicket(m.fp, String(body.fp)) && sameTicket(m.wh, wh))) { await this.contest(m.exp); return json(409, { error: "contested" }); }
      const line = body.line;
      if (line !== null && line !== undefined && !(/^[A-Za-z0-9_-]{64,}$/.test(line) && line.length <= MBX.line)) return json(400, { error: "bad line" });
      if (!m) { m = { fp: String(body.fp), wh, exp: now + SETUP_TTL_MAX, n: 0, bytes: 0 }; await this.alarmAtLeast(m.exp); }
      if (line !== null && line !== undefined) {
        if (m.bytes + line.length > MBX.bytes || m.n >= MBX.lines) return json(413, { error: "mailbox full" });
        await this.ctx.storage.put(`m/${String(m.n).padStart(5, "0")}`, line);
        m = { ...m, n: m.n + 1, bytes: m.bytes + line.length };
      }
      await this.ctx.storage.put("m", m);
      return json(200, { n: m.n });
    }
    if (request.method === "POST" && url.pathname === "/mbx/read") {
      let q;
      try { q = await request.json(); } catch { return json(400, { error: "bad request" }); }
      const t = await this.ctx.storage.get("t");
      if (t && t.exp > now && t.contested) return json(409, { error: "contested" });
      const m = await this.ctx.storage.get("m");
      if (!m || m.exp <= now) return json(200, { n: 0, lines: [], absent: true });
      const spki = unb64url(String(q.key || "")) || new Uint8Array(0);
      const sig = unb64url(String(q.sig || "")) || new Uint8Array(0);
      const ts = Number(q.ts), after = Number(q.after);
      const good = isP256Spki(spki) && sameTicket(await setupFingerprint(spki), m.fp) && Number.isFinite(ts) && Math.abs(now - ts) <= MBX.skew
        && await verifyP256(spki, mbxReadMessage(String(q.loc), ts, after), sig);
      if (!good) return json(401, { error: "not the setup page's key" });
      const lines = [];
      for (let i = after; i < Math.min(m.n, after + MBX.batch); i++) lines.push({ i, line: await this.ctx.storage.get(`m/${String(i).padStart(5, "0")}`) });
      return json(200, { n: m.n, lines });
    }
    return new Response(null, { status: 404 });
  }

  /** The alarm set at register time: gone by its own exp either way (reviewer's LOW, 28 Sep). */
  async alarm() { await this.ctx.storage.deleteAll(); }
}

/**
 * @typedef {{ k: "pending", n: string, route: string } | { k: "control", ticket: string } | { k: "device", c: string, piped: boolean, n: number }
 *   | { k: "data", c: string } | { k: "gone" }} Role
 * The attachment on every socket. Tags: "box" (control sockets, pending or authed), "device" and
 * "dev:<c>", "data" and "data:<c>". Tags cannot change after accept, so the role lives here.
 */

/** One route: the box's control socket, its device connections and their data sockets. */
export class RouteRelay {
  /** @param {any} ctx @param {any} env */
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.limits = { ...LIMITS, ...(env && env.RELAY_LIMITS ? JSON.parse(env.RELAY_LIMITS) : {}) };
    // The keepalive answered by the edge; it never wakes the object (link.js sends it every 60 s).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    // A per-route cap on ticket registrations (ADR 0045), hygiene against a runaway or
    // compromised box, not the real defence (the MAC is). In-memory only: resets on hibernation,
    // which only weakens the cap, never the pairing security it sits in front of.
    this.ticketRegs = 0;
    this.ticketRegWindow = 0;
  }

  /** @returns {boolean} under the 60/route/minute registration cap */
  ticketRegAllowed() {
    const now = Date.now(), minute = Math.floor(now / 60_000);
    if (minute !== this.ticketRegWindow) { this.ticketRegWindow = minute; this.ticketRegs = 0; }
    this.ticketRegs++;
    return this.ticketRegs <= 60;
  }

  /** @param {any} ws @returns {Role} */
  role(ws) { return ws.deserializeAttachment() || { k: "gone" }; }

  /** @param {string} tag @param {(r: Role) => boolean} [pred] */
  live(tag, pred = () => true) { return this.ctx.getWebSockets(tag).filter(ws => { const r = this.role(ws); return r.k !== "gone" && pred(r); }); }

  /** The authed control socket, if any. */
  control() { return this.live("box", r => r.k === "control")[0] || null; }

  /** @param {any} ws @param {any} v */
  json(ws, v) { try { ws.send(JSON.stringify(v)); } catch {} }

  /** Marks a socket gone (so its later close event is ignored) and closes it. */
  end(ws, code, reason) {
    ws.serializeAttachment({ k: "gone" });
    try { ws.close(code, reason); } catch {}
  }

  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const done = () => new Response(null, { status: 101, webSocket: client });
    const c = url.searchParams.get("c");
    if (url.pathname === "/v1/device") await this.onDevice(server);
    else if (c) await this.onBoxData(c, url.searchParams.get("t") || "", server);
    else {
      const challenge = random(32);
      this.ctx.acceptWebSocket(server, ["box"]);
      server.serializeAttachment({ k: "pending", n: b64url(challenge), route: url.searchParams.get("route") || "" });
      this.json(server, { t: "challenge", n: b64url(challenge) });
    }
    return done();
  }

  /** Accepts a socket only to close it with a code, as the Node relay does. */
  refuse(server, code, reason) {
    this.ctx.acceptWebSocket(server, ["refused"]);
    this.end(server, code, reason);
  }

  async onDevice(server) {
    if (!this.control()) return this.refuse(server, CLOSE.boxOffline, "box offline");
    const devices = this.live("device").map(ws => /** @type {any} */ (this.role(ws)));
    const waiting = devices.filter(r => !r.piped).length;
    if (devices.length >= this.limits.open || waiting >= this.limits.waiting) return this.refuse(server, CLOSE.busy, "too many connections");
    const c = b64url(random(12));
    this.ctx.acceptWebSocket(server, ["device", `dev:${c}`]);
    server.serializeAttachment({ k: "device", c, piped: false, n: 0 });
    const control = this.control();
    if (control) this.json(control, { t: "open", c });
  }

  async onBoxData(c, ticket, server) {
    const control = this.control();
    const r = control && /** @type {any} */ (this.role(control));
    const device = this.live(`dev:${c}`)[0];
    const d = device && /** @type {any} */ (this.role(device));
    if (!r || !sameTicket(ticket, r.ticket) || !d || d.piped) return this.refuse(server, CLOSE.refused, "unknown connection");
    this.ctx.acceptWebSocket(server, ["data", `data:${c}`]);
    server.serializeAttachment({ k: "data", c });
    device.serializeAttachment({ ...d, piped: true, n: 0 });
    for (const frame of await this.takeBuffer(c)) { try { server.send(frame); } catch {} }
  }

  /** @param {any} ws @param {string|ArrayBuffer} message */
  async webSocketMessage(ws, message) {
    const r = this.role(ws);
    if (r.k === "gone") return;
    if (size(message) > this.limits.frame) return this.drop(ws, CLOSE.tooBig, "frame too big");
    const binary = typeof message !== "string";
    // The edge answers "ping"; this covers a runtime that delivers it anyway.
    if (message === "ping") { try { ws.send("pong"); } catch {} return; }
    if (r.k === "pending") return this.onAuth(ws, r, message);
    if (r.k === "control") return this.onTicket(ws, message);
    if (!binary) return;
    if (r.k === "data") {
      const device = this.live(`dev:${r.c}`)[0];
      if (device) { try { device.send(message); } catch {} }
      return;
    }
    if (r.k === "device") {
      if (r.piped) {
        const data = this.live(`data:${r.c}`)[0];
        if (data) { try { data.send(message); } catch {} }
        return;
      }
      if (r.n >= this.limits.buffered) return this.drop(ws, CLOSE.busy, "box is not answering");
      await this.putFrame(r.c, r.n, new Uint8Array(/** @type {ArrayBuffer} */ (message)));
      ws.serializeAttachment({ ...r, n: r.n + 1 });
    }
  }

  /** @param {any} ws @param {{ n: string, route: string }} r @param {string|ArrayBuffer} message */
  async onAuth(ws, r, message) {
    let m;
    try { if (typeof message !== "string") throw 0; m = JSON.parse(message); } catch { return this.end(ws, CLOSE.refused, "expected auth"); }
    const pub = unb64url(String(m?.pub || "")) || new Uint8Array(0);
    const sig = unb64url(String(m?.sig || "")) || new Uint8Array(0);
    const challenge = /** @type {Uint8Array} */ (unb64url(r.n));
    if (m?.t !== "auth" || (await routeId(pub)) !== r.route || !(await verifyRoute(pub, authMessage(r.route, challenge), sig))) {
      return this.end(ws, CLOSE.refused, "bad signature");
    }
    const old = this.control();
    if (old) this.end(old, CLOSE.replaced, "replaced by a newer box connection");
    const ticket = b64url(random(18));
    ws.serializeAttachment({ k: "control", ticket });
    const waiting = this.live("device", x => !(/** @type {any} */ (x).piped)).map(d => /** @type {any} */ (this.role(d)).c);
    this.json(ws, { t: "ready", ticket, waiting, features: [...FEATURES] });
  }

  /**
   * What a control socket sends after auth: registering a Wink pairing ticket's locator
   * (ADR 0045, `t: "ticket"`) or a setup offer's (tailnet plan 3.6, `t: "setup"`, same fields) with
   * its own PairTicket object. Either way the box hears back `{ t: "registered", loc, status }`,
   * 200 or, when another server got there first with a different record, 409 (first writer wins).
   * Everything here is the box's own word about its own route, so this is not a trust boundary the
   * way /v1/pair's resolve side is (that's where the MAC matters); the size caps and the per-route
   * cap are hygiene against a runaway or compromised box, not the real defence. Not "ticket" as in
   * the per-connection auth ticket above -- ADR 0045's pairing ticket, a different thing with the
   * same English word.
   * @param {any} ws @param {string|ArrayBuffer} message
   */
  async onTicket(ws, message) {
    if (typeof message !== "string" || !this.ticketRegAllowed()) return;
    let m;
    try { m = JSON.parse(message); } catch { return; }
    if (m?.t !== "ticket" && m?.t !== "setup") return;
    const setup = m.t === "setup";
    const loc = String(m.loc || ""), record = String(m.record || ""), mac = String(m.mac || "");
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(loc) || !/^[A-Za-z0-9_-]{20,64}$/.test(mac) || !SEALED.test(record)) return;
    const exp = Math.min(Number(m.exp) || 0, Date.now() + (setup ? SETUP_TTL_MAX : TICKET_TTL_MAX));
    if (exp <= Date.now() || !this.env.TICKETS) return;
    try {
      const res = await this.env.TICKETS.get(this.env.TICKETS.idFromName(loc)).fetch("https://ticket/register", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ record, mac, exp, setup }),
      });
      const out = res.status === 200 ? /** @type {any} */ (await res.json()) : null;
      if (out) this.json(ws, { t: "registered", loc, status: out.status });
    } catch {}
  }

  /** @param {any} ws */
  async webSocketClose(ws, code, reason) {
    // The one thing a box may tell the device it was serving through its own close: "device removed"
    // (4401). Nothing else the box writes is forwarded, so a box cannot put words in a device's ear.
    await this.gone(ws, code === CLOSE.refused && reason === "device removed" ? { code, reason } : null);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch {}
  }

  /** @param {any} ws */
  async webSocketError(ws) { await this.gone(ws); }

  /** Closes a socket from this side and runs what its close would. */
  async drop(ws, code, reason) {
    const r = this.role(ws);
    this.end(ws, code, reason);
    await this.after(r);
  }

  /** A socket went away on its own. */
  async gone(ws, told = null) {
    const r = this.role(ws);
    if (r.k === "gone") return;
    ws.serializeAttachment({ k: "gone" });
    await this.after(r, told);
  }

  /** What a socket leaving means for the others. @param {Role} r */
  async after(r, told = null) {
    if (r.k === "data") {
      const device = this.live(`dev:${r.c}`)[0];
      if (device) this.end(device, told ? told.code : CLOSE.boxGone, told ? told.reason : "box closed the connection");
    } else if (r.k === "device") {
      const data = this.live(`data:${r.c}`)[0];
      if (data) this.end(data, CLOSE.deviceGone, "device left");
      if (!r.piped && r.n > 0) await this.takeBuffer(r.c);
      const control = this.control();
      if (control) this.json(control, { t: "close", c: r.c });
    }
  }

  /** @param {string} c @param {number} i @param {Uint8Array} frame */
  async putFrame(c, i, frame) {
    /** @type {Record<string, Uint8Array>} */
    const parts = {};
    const n = Math.max(1, Math.ceil(frame.length / PART));
    for (let j = 0; j < n; j++) parts[`b/${c}/${String(i).padStart(3, "0")}.${String(j).padStart(2, "0")}`] = frame.slice(j * PART, (j + 1) * PART);
    await this.ctx.storage.put(parts);
  }

  /** Reads and deletes a connection's buffered frames, in order. @param {string} c @returns {Promise<Uint8Array[]>} */
  async takeBuffer(c) {
    const stored = /** @type {Map<string, Uint8Array>} */ (await this.ctx.storage.list({ prefix: `b/${c}/` }));
    if (stored.size === 0) return [];
    /** @type {Map<string, Uint8Array[]>} */
    const frames = new Map();
    for (const [key, part] of stored) {
      const i = key.slice(key.lastIndexOf("/") + 1, key.lastIndexOf("."));
      if (!frames.has(i)) frames.set(i, []);
      /** @type {Uint8Array[]} */ (frames.get(i)).push(new Uint8Array(part));
    }
    const keys = [...stored.keys()];
    for (let k = 0; k < keys.length; k += 128) await this.ctx.storage.delete(keys.slice(k, k + 128));
    return [...frames.values()].map(parts => {
      const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
      let at = 0;
      for (const p of parts) { out.set(p, at); at += p.length; }
      return out;
    });
  }
}
