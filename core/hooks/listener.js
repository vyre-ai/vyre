// @ts-check
// listener: the one HTTP listener in Vyre that the public internet reaches, through the Wink public gate (core/wink/control/gate.js).
//
// It binds 127.0.0.1 and nothing else. Never a network address and never 0.0.0.0. Whatever carries public links to this home
// reaches loopback and proxies each published path here. What it accepts is narrow:
//   - POST /hooks/<name> for a route that is open right now; anything else is a bare 404. A Flow's own
//     address is /hooks/<route>-<token>: open() splits the token off, and it is never logged or kept here;
//   - a JSON or form body of at most 256 KB, read within 5 seconds of the connection opening;
//   - 30 requests a minute per route, a token bucket refilled from the clock, so no timer runs;
//   - one request per connection, so a slow client holds at most one connection's deadline.
// Then it hands the raw bytes to accept(), which verifies, stores and emits. It never calls a
// tool, and a response never says more than its status code. A refusal of an open route is logged
// with its reason and size (never its body or token), and told to note() for the route's last delivery.

import http from "node:http";

export const HOST = "127.0.0.1";
export const BODY_LIMIT = 256 * 1024;
export const READ_MS = 5_000;
export const PER_MINUTE = 30;
/** Across every route together, so many open routes cannot multiply the load. */
export const ALL_PER_MINUTE = 120;
const MAX_CONNECTIONS = 64;
/** The longest name after /hooks/: a route of up to 40 characters, a dash and a 64-character token, with room to spare. The public gate holds the same limit (core/wink/control/gate.js). */
export const NAME_MAX = 120;

const PATH = /^\/hooks\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;
const TYPES = new Set(["application/json", "application/x-www-form-urlencoded"]);

/** A token bucket: `size` tokens, refilled at `perMinute`, computed from the clock when asked. */
export class Bucket {
  /** @param {number} size @param {number} perMinute @param {() => number} now */
  constructor(size, perMinute, now) { this.size = size; this.rate = perMinute / 60_000; this.now = now; this.tokens = size; this.at = now(); }
  take() {
    const t = this.now();
    this.tokens = Math.min(this.size, this.tokens + (t - this.at) * this.rate);
    this.at = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * Start listening. Resolves once bound, or rejects (a port in use, say).
 * `open(name)` says which open route a path name is: true (the name itself), `{ key, token }` (a route and the token its address carried), or nothing (a 404).
 * @param {{ port: number, now: () => number, open: (name: string) => boolean | { key: string, token?: string } | null | undefined,
 *   accept: (key: string, headers: http.IncomingHttpHeaders, body: Buffer, token: string) => Promise<number>,
 *   note?: (key: string, what: { ok: boolean, why: string, bytes: number }) => void,
 *   log: (msg: string) => void }} o
 * @returns {Promise<{ server: http.Server, port: number, close: () => Promise<void> }>}
 */
export function listen({ port, now, open, accept, note, log }) {
  /** @type {Map<string, Bucket>} */
  const buckets = new Map();
  /** When each route last logged a rate-limit refusal: once a minute at most, so a flood cannot fill the log. @type {Map<string, number>} */
  const limitedAt = new Map();
  /** A refusal of an open route: its reason and size in the log and in the route's last delivery, never its body or token. @param {string} key @param {string} why @param {number} bytes */
  const refused = (key, why, bytes) => {
    if (note) { try { note(key, { ok: false, why, bytes }); } catch { /* a note, never a stop */ } }
    log(`internet:${key}: refused, ${why} (${bytes} bytes)`);
  };
  const all = new Bucket(ALL_PER_MINUTE, ALL_PER_MINUTE, now);
  /** @type {WeakMap<import("node:net").Socket, NodeJS.Timeout>} */
  const cuts = new WeakMap();
  const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: READ_MS, headersTimeout: READ_MS }, (req, res) => {
    const send = code => {
      if (res.headersSent) return;
      res.writeHead(code, { "content-length": "0", "cache-control": "no-store", connection: "close" });
      res.end();
    };
    const path = String(req.url || "").split("?")[0];
    const m = PATH.exec(path);
    const name = m ? m[1] : null;
    const found = req.method === "POST" && name && name.length <= NAME_MAX ? open(name) : null;
    if (!found) { req.resume(); return send(404); }
    // The route's own name, never the token: the bucket, the log and accept() all use it.
    const key = found === true ? /** @type {string} */ (name) : String(found.key);
    const token = found === true ? "" : String(found.token || "");
    const declared = Number(req.headers["content-length"]);
    const size0 = Number.isFinite(declared) && declared >= 0 ? declared : 0;
    let b = buckets.get(key);
    if (!b) { b = new Bucket(PER_MINUTE, PER_MINUTE, now); buckets.set(key, b); }
    if (!b.take() || !all.take()) {
      req.resume();
      const t = now();
      if (t - (limitedAt.get(key) ?? -Infinity) >= 60_000) { limitedAt.set(key, t); refused(key, `over the limit of ${PER_MINUTE} a minute (said once a minute)`, size0); }
      return send(429);
    }
    const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!TYPES.has(type)) { req.resume(); refused(key, "not JSON or a form", size0); return send(415); }
    if (Number.isFinite(declared) && declared > BODY_LIMIT) { refused(key, `bigger than ${BODY_LIMIT / 1024} KB`, size0); send(413); return req.destroy(); }
    const chunks = [];
    let size = 0, over = false;
    req.on("data", c => {
      if (over) return;
      size += c.length;
      if (size > BODY_LIMIT) { over = true; refused(key, `bigger than ${BODY_LIMIT / 1024} KB`, size); send(413); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("error", () => {});
    req.on("end", () => {
      if (over) return;
      // Read in time: the deadline was for the reading, not for the vault and the store.
      clearTimeout(cuts.get(req.socket));
      accept(key, req.headers, Buffer.concat(chunks, size), token).then(send, e => { log(`internet:${key}: ${String(e && e.message || e).slice(0, 200)}`); send(500); });
    });
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.keepAliveTimeout = 1;
  // One deadline per connection, from its first byte: headers and body within READ_MS, or it is
  // cut. requestTimeout alone is checked only every 30 seconds, and a socket timeout is an idle
  // timeout, which a client sending a byte every few seconds would never trip.
  server.on("connection", socket => {
    const cut = setTimeout(() => socket.destroy(), READ_MS);
    cut.unref?.();
    cuts.set(socket, cut);
    socket.on("close", () => clearTimeout(cut));
  });
  server.on("clientError", (_e, socket) => { try { socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n"); } catch {} });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      server.on("error", e => log(`listener: ${e.message}`));
      const bound = /** @type {import("node:net").AddressInfo} */ (server.address());
      resolve({
        server, port: bound.port,
        close: () => new Promise(r => { server.close(() => r(undefined)); server.closeAllConnections?.(); }),
      });
    });
  });
}

/**
 * "Send a test" from the Flow editor: one POST to this server's own loopback listener, on the Flow's address, marked with a nonce the hooks module made a moment before so it is checked like any
 * delivery and then starts nothing. Loopback only; it never leaves the machine. Resolves to the status code.
 * @param {number} port @param {string} path @param {string} nonce
 * @returns {Promise<number>}
 */
export function sendTest(port, path, nonce) {
  const body = JSON.stringify({ test: true, from: "Vyre", note: "A test of this address. It starts nothing." });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port, method: "POST", path, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-vyre-test": nonce }, timeout: READ_MS },
      res => { res.resume(); resolve(res.statusCode || 0); });
    req.on("timeout", () => req.destroy(new Error("the listener did not answer")));
    req.on("error", reject);
    req.end(body);
  });
}
