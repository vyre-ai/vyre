// @ts-check
// listener: the one HTTP listener in Vyre that the public internet reaches, through the Wink public gate (core/wink/control/gate.js).
//
// It binds 127.0.0.1 and nothing else. Never a network address and never 0.0.0.0. Whatever carries public links to this home
// reaches loopback and proxies each published path here. What it accepts is narrow:
//   - POST /hooks/<name> for a route that is open right now; anything else is a bare 404;
//   - a JSON or form body of at most 256 KB, read within 5 seconds of the connection opening;
//   - 30 requests a minute per route, a token bucket refilled from the clock, so no timer runs;
//   - one request per connection, so a slow client holds at most one connection's deadline.
// Then it hands the raw bytes to accept(), which verifies, stores and emits. It never calls a
// tool, and a response never says more than its status code.

import http from "node:http";

export const HOST = "127.0.0.1";
export const BODY_LIMIT = 256 * 1024;
export const READ_MS = 5_000;
export const PER_MINUTE = 30;
/** Across every route together, so many open routes cannot multiply the load. */
export const ALL_PER_MINUTE = 120;
const MAX_CONNECTIONS = 64;

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
 * @param {{ port: number, now: () => number, open: (name: string) => boolean,
 *   accept: (name: string, headers: http.IncomingHttpHeaders, body: Buffer) => Promise<number>,
 *   log: (msg: string) => void }} o
 * @returns {Promise<{ server: http.Server, port: number, close: () => Promise<void> }>}
 */
export function listen({ port, now, open, accept, log }) {
  /** @type {Map<string, Bucket>} */
  const buckets = new Map();
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
    if (req.method !== "POST" || !name || name.length > 40 || !open(name)) { req.resume(); return send(404); }
    let b = buckets.get(name);
    if (!b) { b = new Bucket(PER_MINUTE, PER_MINUTE, now); buckets.set(name, b); }
    if (!b.take() || !all.take()) { req.resume(); return send(429); }
    const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!TYPES.has(type)) { req.resume(); return send(415); }
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > BODY_LIMIT) { send(413); return req.destroy(); }
    const chunks = [];
    let size = 0, over = false;
    req.on("data", c => {
      if (over) return;
      size += c.length;
      if (size > BODY_LIMIT) { over = true; send(413); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("error", () => {});
    req.on("end", () => {
      if (over) return;
      // Read in time: the deadline was for the reading, not for the vault and the store.
      clearTimeout(cuts.get(req.socket));
      accept(name, req.headers, Buffer.concat(chunks, size)).then(send, e => { log(`internet:${name}: ${String(e && e.message || e).slice(0, 200)}`); send(500); });
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
