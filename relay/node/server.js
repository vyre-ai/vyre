// @ts-check
// The relay in plain Node (ADR 0026, section 2): the same protocol as the Cloudflare Worker in
// relay/worker/, for tests and for anyone who would rather run their own relay. No dependencies:
// node:http and the RFC 6455 framing in core/computers/ws.js.
//
//   GET /v1/box?route=<id>                  the box's control socket, after a signed challenge
//   GET /v1/box?route=<id>&c=<conn>&t=<ticket>   the box's data socket for one device connection
//   GET /v1/device?route=<id>               a device; the relay tells the box, then pipes frames
//   GET /health
//
// The relay never reads a device frame. It learns addresses, timing, sizes and route ids.

import http from "node:http";
import crypto from "node:crypto";
import { acceptKey, encodeFrame, FrameParser } from "../../core/computers/ws.js";
import { LIMITS, CLOSE, ROUTE_RE, routeId, authMessage, verifyRoute, TICKET_TTL } from "../../core/relay/wire.js";

/** A fixed window per key (an IP, or the constant "*" for the global cap): true while under it. */
function rateLimiter(max, windowMs) {
  /** @type {Map<string, { n: number, resetAt: number }>} */
  const hits = new Map();
  return key => {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.resetAt <= now) { h = { n: 0, resetAt: now + windowMs }; hits.set(key, h); }
    h.n++;
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    return h.n <= max;
  };
}

/** One accepted WebSocket on a raw socket. */
class Peer {
  /** @param {import("node:net").Socket} socket @param {number} maxFrame */
  constructor(socket, maxFrame) {
    this.socket = socket;
    this.closed = false;
    /** @type {(data: Buffer, binary: boolean) => void} */
    this.onmessage = () => {};
    /** @type {() => void} */
    this.onclose = () => {};
    const parser = new FrameParser();
    socket.on("data", chunk => {
      let frames;
      try { frames = parser.push(chunk); } catch { this.close(1002, "bad frame"); return; }
      for (const f of frames) {
        if ("control" in f) {
          if (f.control === "ping") this.write(f.payload, 0xa);
          else if (f.control === "close") this.close(1000, "");
          continue;
        }
        if (f.message.length > maxFrame) { this.close(CLOSE.tooBig, "frame too big"); return; }
        // A text "ping" is the keepalive a WebSocket API without protocol pings can send; the
        // Worker answers it at the edge with setWebSocketAutoResponse, so it is never forwarded.
        if (f.opcode === 1 && f.message.length === 4 && f.message.toString() === "ping") { this.write(Buffer.from("pong"), 1); continue; }
        this.onmessage(f.message, f.opcode === 2);
      }
    });
    const gone = () => { if (!this.closed) { this.closed = true; this.onclose(); } };
    socket.on("close", gone);
    socket.on("error", gone);
  }
  write(payload, opcode) { if (!this.closed && !this.socket.destroyed) this.socket.write(encodeFrame(payload, opcode)); }
  /** @param {Buffer|string} data */
  send(data) { typeof data === "string" ? this.write(Buffer.from(data), 1) : this.write(data, 2); }
  json(v) { this.send(JSON.stringify(v)); }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.write(body, 0x8);
    this.closed = true;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this.onclose();
  }
}

/**
 * @param {{ limits?: Partial<typeof LIMITS>, log?: (event: string, x?: any) => void }} [o]
 */
export function createRelay(o = {}) {
  const limits = { ...LIMITS, ...(o.limits || {}) };
  const log = o.log || (() => {});
  /** @type {Map<string, { control: Peer|null, ticket: string|null, conns: Map<string, { device: Peer, box: Peer|null, buffer: Buffer[] }> }>} */
  const routes = new Map();
  const routeOf = id => {
    let r = routes.get(id);
    if (!r) { r = { control: null, ticket: null, conns: new Map() }; routes.set(id, r); }
    return r;
  };
  const tidy = id => {
    const r = routes.get(id);
    if (r && !r.control && r.conns.size === 0) routes.delete(id);
  };

  // Pairing tickets (ADR 0037): a box's control socket registers a locator -> a signed-by-the-
  // box's-own-ticket record, never the pairing secret itself (core/relay/wire.js ticketDerive).
  // Single-use (deleted on the one resolve that finds it) and short-lived; a sweep on insert
  // keeps the map from growing on tickets nobody ever resolves. Resolve is rate-limited per IP
  // and globally: unlike a device connection, this endpoint answers with no proof at all, so it
  // is the one place worth defending against a plain guessing loop even though 64 random bits in
  // 5 minutes is already out of reach.
  /** @type {Map<string, { record: string, mac: string, exp: number }>} */
  const pairTickets = new Map();
  const sweepTickets = () => { const now = Date.now(); for (const [loc, t] of pairTickets) if (t.exp <= now) pairTickets.delete(loc); };
  const pairRegisterLimit = rateLimiter(60, 60_000);
  const pairResolveLimitByIp = rateLimiter(30, 60_000);
  const pairResolveLimitGlobal = rateLimiter(600, 60_000);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://relay");
    if (url.pathname === "/health") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); return; }
    if (url.pathname === "/v1/pair" && req.method === "POST") { onPairResolve(req, res); return; }
    res.writeHead(url.pathname.startsWith("/v1/") ? 426 : 404);
    res.end();
  });

  /** GET-by-POST on purpose (ADR 0037): the locator never sits in a URL, so it never lands in an
   * access log. Single-use: found or not, the entry is gone either way after this call. */
  function onPairResolve(req, res) {
    const ip = String(req.socket.remoteAddress || "");
    if (!pairResolveLimitByIp(ip) || !pairResolveLimitGlobal("*")) { res.writeHead(429, { "content-type": "application/json" }); res.end('{"error":"too many pairing attempts; wait a minute"}'); return; }
    let body = "";
    let over = false;
    req.on("data", c => { body += c; if (body.length > 1024) { over = true; req.destroy(); } });
    req.on("end", () => {
      if (over) return;
      let m;
      try { m = JSON.parse(body); } catch { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"bad request"}'); return; }
      const loc = String(m?.loc || "");
      sweepTickets();
      const t = pairTickets.get(loc);
      if (t) pairTickets.delete(loc);
      if (!t || t.exp <= Date.now()) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"this pairing code has expired or was already used"}'); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ record: t.record, mac: t.mac }));
    });
    req.on("error", () => {});
  }

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://relay");
    const route = url.searchParams.get("route") || "";
    const key = req.headers["sec-websocket-key"];
    const kind = url.pathname === "/v1/box" ? "box" : url.pathname === "/v1/device" ? "device" : null;
    if (!kind || !ROUTE_RE.test(route) || typeof key !== "string" || String(req.headers.upgrade).toLowerCase() !== "websocket") {
      socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
      return;
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${acceptKey(key)}\r\n\r\n`);
    socket.setNoDelay(true);
    const peer = new Peer(/** @type {any} */ (socket), limits.frame);
    if (head && head.length) socket.unshift(head);
    if (kind === "device") return onDevice(route, peer);
    const c = url.searchParams.get("c");
    if (c) return onBoxData(route, c, url.searchParams.get("t") || "", peer);
    onBoxControl(route, peer);
  });

  function onBoxControl(route, peer) {
    const challenge = crypto.randomBytes(32);
    peer.json({ t: "challenge", n: challenge.toString("base64url") });
    let authed = false;
    peer.onmessage = (data, binary) => {
      if (authed || binary) { if (!authed) peer.close(CLOSE.refused, "expected auth"); return; }
      let m;
      try { m = JSON.parse(data.toString()); } catch { peer.close(CLOSE.refused, "expected auth"); return; }
      const pub = Buffer.from(String(m?.pub || ""), "base64url"), sig = Buffer.from(String(m?.sig || ""), "base64url");
      if (m?.t !== "auth" || routeId(pub) !== route || !verifyRoute(pub, authMessage(route, challenge), sig)) {
        log("box.refused", { route });
        peer.close(CLOSE.refused, "bad signature");
        return;
      }
      authed = true;
      const r = routeOf(route);
      if (r.control) r.control.close(CLOSE.replaced, "replaced by a newer box connection");
      r.control = peer;
      r.ticket = crypto.randomBytes(18).toString("base64url");
      peer.json({ t: "ready", ticket: r.ticket, waiting: [...r.conns].filter(([, x]) => !x.box).map(([c]) => c) });
      log("box.connected", { route });
      // The only thing a control socket sends after auth: registering a pairing ticket's locator
      // (ADR 0037). Everything here is the box's own word about its own route, so this is not a
      // trust boundary the way the HTTP resolve side is; the size caps and the register-side
      // rate limit are just hygiene against a runaway or compromised box, not the real defence.
      peer.onmessage = (d2, bin2) => {
        if (bin2 || !pairRegisterLimit(route)) return;
        let t;
        try { t = JSON.parse(d2.toString()); } catch { return; }
        if (t?.t !== "ticket") return;
        const loc = String(t.loc || ""), record = String(t.record || ""), mac = String(t.mac || "");
        if (!/^[A-Za-z0-9_-]{20,64}$/.test(loc) || !/^[A-Za-z0-9_-]{20,64}$/.test(mac) || record.length > 2048) return;
        sweepTickets();
        const exp = Math.min(Number(t.exp) || 0, Date.now() + TICKET_TTL);
        if (exp <= Date.now()) return;
        pairTickets.set(loc, { record, mac, exp });
      };
    };
    peer.onclose = () => {
      const r = routes.get(route);
      if (r && r.control === peer) { r.control = null; r.ticket = null; log("box.disconnected", { route }); }
      tidy(route);
    };
  }

  function onBoxData(route, c, ticket, peer) {
    const r = routes.get(route);
    const conn = r?.conns.get(c);
    const good = r?.ticket && ticket.length === r.ticket.length && crypto.timingSafeEqual(Buffer.from(ticket), Buffer.from(r.ticket));
    if (!r || !good || !conn || conn.box) { peer.close(CLOSE.refused, "unknown connection"); return; }
    conn.box = peer;
    for (const f of conn.buffer) peer.send(f);
    conn.buffer = [];
    peer.onmessage = (data, binary) => { if (binary) conn.device.send(data); };
    peer.onclose = () => {
      if (r.conns.get(c) !== conn) return;
      r.conns.delete(c);
      conn.device.close(CLOSE.boxGone, "box closed the connection");
      tidy(route);
    };
  }

  function onDevice(route, peer) {
    const r = routes.get(route);
    if (!r?.control) { peer.close(CLOSE.boxOffline, "box offline"); return; }
    const waiting = [...r.conns.values()].filter(x => !x.box).length;
    if (r.conns.size >= limits.open || waiting >= limits.waiting) { peer.close(CLOSE.busy, "too many connections"); return; }
    const c = crypto.randomBytes(12).toString("base64url");
    const conn = { device: peer, box: /** @type {Peer|null} */ (null), buffer: /** @type {Buffer[]} */ ([]) };
    r.conns.set(c, conn);
    r.control.json({ t: "open", c });
    peer.onmessage = (data, binary) => {
      if (!binary) return;
      if (conn.box) { conn.box.send(data); return; }
      if (conn.buffer.length >= limits.buffered) { peer.close(CLOSE.busy, "box is not answering"); return; }
      conn.buffer.push(data);
    };
    peer.onclose = () => {
      if (r.conns.get(c) !== conn) return;
      r.conns.delete(c);
      conn.box?.close(CLOSE.deviceGone, "device left");
      r.control?.json({ t: "close", c });
      tidy(route);
    };
  }

  return {
    server,
    /** @param {number} [port] @param {string} [host] @returns {Promise<string>} the relay's ws:// base */
    listen(port = 0, host = "127.0.0.1") {
      return new Promise(resolve => server.listen(port, host, () => {
        const a = /** @type {import("node:net").AddressInfo} */ (server.address());
        resolve(`ws://${host}:${a.port}`);
      }));
    },
    /** For tests: how many routes and connections the relay holds. */
    stats() { return { routes: routes.size, conns: [...routes.values()].reduce((n, r) => n + r.conns.size, 0) }; },
    close() {
      for (const r of routes.values()) { r.control?.close(1001, "relay stopping"); for (const x of r.conns.values()) { x.device.close(1001); x.box?.close(1001); } }
      routes.clear();
      return new Promise(resolve => { server.close(() => resolve(undefined)); server.closeAllConnections?.(); });
    },
  };
}
