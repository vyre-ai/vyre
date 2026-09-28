// @ts-check
// The relay on Cloudflare (ADR 0026, section 2): a Worker in front and one Durable Object per route
// id. The same protocol as relay/node/server.js, message for message, so core/relay/link.js runs
// against either unchanged.
//
//   GET /v1/box?route=<id>                  the box's control socket, after a signed challenge
//   GET /v1/box?route=<id>&c=<conn>&t=<ticket>   the box's data socket for one device connection
//   GET /v1/device?route=<id>               a device; the relay tells the box, then pipes frames
//   POST /v1/pair                           resolve a Wink pairing ticket's locator (ADR 0045)
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
// only what the box handed the relay (record, mac, exp), single-use (deleted on the one resolve
// that finds it, whether it answers or not), and never the pairing secret itself, which the relay
// never sees at all (core/relay/wire.js's ticketDerive).

/**
 * These repeat core/relay/wire.js, which uses node:crypto and so cannot load here.
 * relay/worker/worker.test.js checks that they match.
 */
export const BOX_AUTH_TAG = "vyre-relay-box-v1";
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
const LOC_RE = /^[A-Za-z0-9_-]{20,64}$/;
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
    if (url.pathname === "/v1/pair" && request.method === "POST") return onPairResolve(request, env);
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
  if (res.status !== 200) return json(404, { error: "this pairing code has expired or was already used" });
  return json(200, await res.json());
}

/**
 * One Wink pairing ticket (ADR 0045), keyed by its locator: what a box's control socket
 * registered (record, mac, exp), single-use. No timers, no alarm: expiry is checked lazily on the
 * one read that matters, and an unread, expired object simply sits in cheap Durable Object
 * storage until Cloudflare reclaims it -- a locator is an unguessable 256-bit hash, so there is
 * nothing worth actively sweeping.
 */
export class PairTicket {
  /** @param {any} ctx */
  constructor(ctx) { this.ctx = ctx; }
  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "PUT" && url.pathname === "/register") {
      let body;
      try { body = await request.json(); } catch { return new Response(null, { status: 400 }); }
      const record = String((body && body.record) || ""), mac = String((body && body.mac) || "");
      const exp = Math.min(Number(body && body.exp) || 0, Date.now() + TICKET_TTL_MAX);
      if (!record || !mac || record.length > 2048 || exp <= Date.now()) return new Response(null, { status: 400 });
      await this.ctx.storage.put("t", { record, mac, exp });
      // A locator nobody ever resolves would otherwise sit in storage forever (reviewer's LOW,
      // 28 Sep): clean it up at its own exp either way, resolved or not.
      await this.ctx.storage.setAlarm(exp);
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && url.pathname === "/resolve") {
      const t = await this.ctx.storage.get("t");
      if (t) { await this.ctx.storage.deleteAll(); await this.ctx.storage.deleteAlarm(); }
      if (!t || t.exp <= Date.now()) return new Response(null, { status: 404 });
      return json(200, { record: t.record, mac: t.mac });
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
    if (r.k === "control") return this.onTicket(message);
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
    this.json(ws, { t: "ready", ticket, waiting });
  }

  /**
   * The only thing a control socket sends after auth: registering a Wink pairing ticket's locator
   * (ADR 0045) with its own PairTicket object. Everything here is the box's own word about its
   * own route, so this is not a trust boundary the way /v1/pair's resolve side is (that's where
   * the MAC matters); the size caps and the per-route cap are hygiene against a runaway or
   * compromised box, not the real defence. Not "ticket" as in the per-connection auth ticket
   * above -- ADR 0045's pairing ticket, a different thing with the same English word.
   * @param {string|ArrayBuffer} message
   */
  async onTicket(message) {
    if (typeof message !== "string" || !this.ticketRegAllowed()) return;
    let m;
    try { m = JSON.parse(message); } catch { return; }
    if (m?.t !== "ticket") return;
    const loc = String(m.loc || ""), record = String(m.record || ""), mac = String(m.mac || "");
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(loc) || !/^[A-Za-z0-9_-]{20,64}$/.test(mac) || record.length > 2048) return;
    const exp = Math.min(Number(m.exp) || 0, Date.now() + TICKET_TTL_MAX);
    if (exp <= Date.now() || !this.env.TICKETS) return;
    try {
      await this.env.TICKETS.get(this.env.TICKETS.idFromName(loc)).fetch("https://ticket/register", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ record, mac, exp }),
      });
    } catch {}
  }

  /** @param {any} ws */
  async webSocketClose(ws, code, reason) {
    await this.gone(ws);
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
  async gone(ws) {
    const r = this.role(ws);
    if (r.k === "gone") return;
    ws.serializeAttachment({ k: "gone" });
    await this.after(r);
  }

  /** What a socket leaving means for the others. @param {Role} r */
  async after(r) {
    if (r.k === "data") {
      const device = this.live(`dev:${r.c}`)[0];
      if (device) this.end(device, CLOSE.boxGone, "box closed the connection");
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
