// @ts-check
// The relay in plain Node (ADR 0026, section 2): the same protocol as the Cloudflare Worker in
// relay/worker/, for tests and for anyone who would rather run their own relay. No dependencies:
// node:http and the RFC 6455 framing in core/computers/ws.js.
//
//   GET /v1/box?route=<id>                  the box's control socket, after a signed challenge
//   GET /v1/box?route=<id>&c=<conn>&t=<ticket>   the box's data socket for one device connection
//   GET /v1/device?route=<id>               a device; the relay tells the box, then pipes frames
//   POST /v1/pair                           resolve a Wink ticket's or a setup offer's locator
//   POST /v1/setup/mbx                      append a line to a setup progress mailbox (the install script)
//   GET /v1/setup/mbx                       read it, long poll, signed by the setup page's key
//   GET /health
//
// The relay never reads a device frame. It learns addresses, timing, sizes and route ids.

import http from "node:http";
import crypto from "node:crypto";
import { acceptKey, encodeFrame, FrameParser } from "../../core/computers/ws.js";
import { LIMITS, CLOSE, ROUTE_RE, routeId, authMessage, verifyRoute, TICKET_TTL, SETUP_TTL, MBX_LINE_MAX, isP256Spki, setupFingerprint, verifyP256, mbxReadMessage } from "../../core/relay/wire.js";

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
    /** @type {{ code: number, reason: string } | null} */
    this.said = null;
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
          else if (f.control === "close") {
            // What the other side said in its close frame (code, reason), kept for a caller that may pass one on.
            if (f.payload && f.payload.length >= 2) this.said = { code: f.payload.readUInt16BE(0), reason: f.payload.subarray(2).toString().slice(0, 123) };
            this.close(1000, "");
          }
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
 * @param {{ limits?: Partial<typeof LIMITS>, setup?: { maxBoxes?: number, createPerIp?: number }, log?: (event: string, x?: any) => void }} [o]
 */
/** What this relay does that a box may rely on, told in `ready` (an older relay says nothing): `registered` answers every ticket registration with 200 or 409. */
export const FEATURES = ["registered"];

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

  // Pairing tickets (ADR 0045): a box's control socket registers a locator -> a signed-by-the-
  // box's-own-ticket record, never the pairing secret itself (core/relay/wire.js ticketDerive).
  // Single-use (deleted on the one resolve that finds it) and short-lived; a sweep on insert
  // keeps the map from growing on tickets nobody ever resolves. Resolve is rate-limited per IP
  // and globally: unlike a device connection, this endpoint answers with no proof at all, so it
  // is the one place worth defending against a plain guessing loop even though 64 random bits in
  // 5 minutes is already out of reach.
  // The record is ciphertext the box sealed under a key only the ticket gives (wire.js
  // ticketSeal): anything that isn't opaque base64url, a plaintext JSON record included, is
  // refused, so this relay never holds a box's name, handle or key in the clear.
  const SEALED = /^[A-Za-z0-9_-]{22,2048}$/;
  /** @type {Map<string, { record: string, mac: string, exp: number, setup?: boolean, contested?: boolean }>} */
  const pairTickets = new Map();
  const sweepTickets = () => { const now = Date.now(); for (const [loc, t] of pairTickets) if (t.exp <= now) pairTickets.delete(loc); };
  // First writer wins, for a Wink ticket and a setup offer alike (tailnet plan 3.6): a second
  // register of a live locator with a different record or mac leaves the first in place, marks the
  // locator contested and answers 409; the same record and mac again answers 200 (a reconnect
  // re-sending). A contested locator answers 409 to resolve, append and read until it expires. A
  // Wink ticket is single-use; a setup offer (`setup: true`) lives its hour and the same locator
  // carries the setup mailbox.
  /** @param {string} loc @param {{ record: string, mac: string, exp: number, setup?: boolean }} t @returns {200|409} */
  const registerLoc = (loc, t) => {
    sweepTickets();
    const cur = pairTickets.get(loc);
    if (!cur) { pairTickets.set(loc, t); return 200; }
    if (cur.contested) return 409;
    if (cur.record === t.record && cur.mac === t.mac) return 200;
    cur.contested = true;
    return 409;
  };
  const isContested = loc => { const t = pairTickets.get(loc); return Boolean(t && t.exp > Date.now() && t.contested); };
  const contest = (loc, exp) => { const t = pairTickets.get(loc); if (t) t.contested = true; else pairTickets.set(loc, { record: "", mac: "", exp, contested: true }); };

  // The setup mailbox (see relay/worker/index.js onSetupMbx for the whole contract).
  /** @type {Map<string, { fp: string, wh: string, exp: number, lines: string[], bytes: number }>} */
  const mailboxes = new Map();
  const sweepMailboxes = () => { const now = Date.now(); for (const [k, m] of mailboxes) if (m.exp <= now) mailboxes.delete(k); };
  const MBX_MAX_BOXES = o.setup?.maxBoxes ?? 1000, MBX_BYTES = 64 * 1024, MBX_BATCH = 64, MBX_SKEW = 120_000;
  const mbxAppendLimit = rateLimiter(120, 60_000);
  const mbxCreateLimit = rateLimiter(o.setup?.createPerIp ?? 10, 60 * 60_000);
  const mbxReadLimit = rateLimiter(60, 60_000);
  const sha256b64 = v => crypto.createHash("sha256").update(String(v)).digest("base64url");
  const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
  const pairRegisterLimit = rateLimiter(60, 60_000);
  const pairResolveLimitByIp = rateLimiter(30, 60_000);
  const pairResolveLimitGlobal = rateLimiter(600, 60_000);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://relay");
    if (url.pathname === "/health") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); return; }
    // /v1/pair alone answers any origin, with no credentials (ADR 0045; relay/worker/index.js
    // does the same): its safety is the ticket, never the caller's origin.
    if (url.pathname === "/v1/pair" && req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" });
      res.end();
      return;
    }
    if (url.pathname === "/v1/pair" && req.method === "POST") { res.setHeader("access-control-allow-origin", "*"); onPairResolve(req, res); return; }
    // The setup mailbox answers any origin too: the page reads it from vyre.run, and its safety is a signature and a sealed stream.
    if (url.pathname === "/v1/setup/mbx" && req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type, x-vyre-setup-key, x-vyre-setup-ts, x-vyre-setup-sig", "access-control-max-age": "600" });
      res.end();
      return;
    }
    if (url.pathname === "/v1/setup/mbx" && (req.method === "POST" || req.method === "GET")) { res.setHeader("access-control-allow-origin", "*"); (req.method === "POST" ? onMbxAppend : onMbxRead)(req, res, url); return; }
    res.writeHead(url.pathname.startsWith("/v1/") ? 426 : 404);
    res.end();
  });

  /** GET-by-POST on purpose (ADR 0045): the locator never sits in a URL, so it never lands in an
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
      if (t && t.contested) { res.writeHead(409, { "content-type": "application/json" }); res.end('{"error":"contested"}'); return; }
      if (t && !t.setup) pairTickets.delete(loc);
      if (!t || t.exp <= Date.now() || !t.record) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"this pairing code has expired or was already used"}'); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ record: t.record, mac: t.mac }));
    });
    req.on("error", () => {});
  }

  const reply = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const LOC = /^[A-Za-z0-9_-]{20,64}$/;

  /** The install script's append: { loc, fp, wtok, line? }. First writer fixes fp and wtok. */
  function onMbxAppend(req, res) {
    const ip = String(req.socket.remoteAddress || "");
    if (!mbxAppendLimit(ip)) return reply(res, 429, { error: "too many setup requests; wait a minute" });
    let body = "";
    let over = false;
    req.on("data", c => { body += c; if (body.length > 8 * 1024) { over = true; reply(res, 413, { error: "too big" }); req.destroy(); } });
    req.on("end", () => {
      if (over) return;
      let m;
      try { m = JSON.parse(body); } catch { return reply(res, 400, { error: "bad request" }); }
      const loc = String(m?.loc || "");
      if (!LOC.test(loc) || !/^[A-Za-z0-9_-]{22}$/.test(String(m.fp || "")) || !/^[A-Za-z0-9_-]{43}$/.test(String(m.wtok || ""))) return reply(res, 400, { error: "bad request" });
      sweepTickets();
      sweepMailboxes();
      if (isContested(loc)) return reply(res, 409, { error: "contested" });
      const wh = sha256b64(m.wtok);
      let box = mailboxes.get(loc);
      if (box && !(same(box.fp, m.fp) && same(box.wh, wh))) { contest(loc, box.exp); return reply(res, 409, { error: "contested" }); }
      const line = m.line === undefined || m.line === null ? null : String(m.line);
      if (line !== null && !(/^[A-Za-z0-9_-]{64,}$/.test(line) && line.length <= Math.ceil(MBX_LINE_MAX * 4 / 3) + 100)) return reply(res, 400, { error: "bad line" });
      if (!box) {
        // Creating one is what costs: a per-address hourly cap and a global cap on live mailboxes.
        if (!mbxCreateLimit(ip) || mailboxes.size >= MBX_MAX_BOXES) return reply(res, 429, { error: "too many setup requests; wait a minute" });
        box = { fp: m.fp, wh, exp: Date.now() + SETUP_TTL, lines: [], bytes: 0 };
        mailboxes.set(loc, box);
      }
      if (line !== null) {
        if (box.bytes + line.length > MBX_BYTES) return reply(res, 413, { error: "mailbox full" });
        box.lines.push(line);
        box.bytes += line.length;
      }
      reply(res, 200, { n: box.lines.length });
    });
    req.on("error", () => {});
  }

  /** The page's read, a long poll signed with its key; see relay/worker/index.js onSetupMbx. The wait is a 250 ms look at memory, which costs nothing here. */
  function onMbxRead(req, res, url) {
    const ip = String(req.socket.remoteAddress || "");
    if (!mbxReadLimit(ip)) return reply(res, 429, { error: "too many setup requests; wait a minute" });
    const loc = url.searchParams.get("loc") || "";
    const after = Number(url.searchParams.get("after") || 0);
    const wait = Math.min(Math.max(Number(url.searchParams.get("wait") || 0), 0), 25);
    if (!LOC.test(loc) || !Number.isInteger(after) || after < 0) return reply(res, 400, { error: "bad request" });
    const key = String(req.headers["x-vyre-setup-key"] || ""), sig = String(req.headers["x-vyre-setup-sig"] || ""), ts = Number(req.headers["x-vyre-setup-ts"] || 0);
    const deadline = Date.now() + wait * 1000;
    let gone = false;
    req.on("close", () => { gone = true; });
    /** Answer now if there is something to say, or the wait is over: true when answered. */
    const look = () => {
      sweepTickets();
      sweepMailboxes();
      if (isContested(loc)) { reply(res, 409, { error: "contested" }); return true; }
      const box = mailboxes.get(loc);
      const last = Date.now() >= deadline;
      if (!box) { if (last) reply(res, 200, { n: 0, lines: [], absent: true }); return last; }
      const spki = Buffer.from(key, "base64url");
      const ok = isP256Spki(spki) && same(setupFingerprint(spki).toString("base64url"), box.fp) && Number.isFinite(ts) && Math.abs(Date.now() - ts) <= MBX_SKEW
        && verifyP256(spki, mbxReadMessage(loc, ts, after), Buffer.from(sig, "base64url"));
      if (!ok) { reply(res, 401, { error: "not the setup page's key" }); return true; }
      if (box.lines.length > after || last) {
        reply(res, 200, { n: box.lines.length, lines: box.lines.slice(after, after + MBX_BATCH).map((line, k) => ({ i: after + k, line })) });
        return true;
      }
      return false;
    };
    const poll = () => { if (gone || look()) return; setTimeout(poll, 250).unref(); };
    poll();
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
      peer.json({ t: "ready", ticket: r.ticket, waiting: [...r.conns].filter(([, x]) => !x.box).map(([c]) => c), ...(o.legacyNoAck ? {} : { features: FEATURES }) });
      log("box.connected", { route });
      // The only thing a control socket sends after auth: registering a pairing ticket's locator
      // (ADR 0045). Everything here is the box's own word about its own route, so this is not a
      // trust boundary the way the HTTP resolve side is; the size caps and the register-side
      // rate limit are just hygiene against a runaway or compromised box, not the real defence.
      peer.onmessage = (d2, bin2) => {
        if (bin2 || !pairRegisterLimit(route)) return;
        let t;
        try { t = JSON.parse(d2.toString()); } catch { return; }
        if (t?.t !== "ticket" && t?.t !== "setup") return;
        const setup = t.t === "setup";
        const loc = String(t.loc || ""), record = String(t.record || ""), mac = String(t.mac || "");
        if (!/^[A-Za-z0-9_-]{20,64}$/.test(loc) || !/^[A-Za-z0-9_-]{20,64}$/.test(mac) || !SEALED.test(record)) return;
        const exp = Math.min(Number(t.exp) || 0, Date.now() + (setup ? SETUP_TTL : TICKET_TTL));
        if (exp <= Date.now()) return;
        // The box hears the outcome: 200, or 409 when another server registered this locator first.
        const status = registerLoc(loc, { record, mac, exp, ...(setup ? { setup: true } : {}) });
        // `legacyNoAck` (tests only) behaves as the relay deployed before 30 Sep did: it stores the ticket and says nothing back.
        if (!o.legacyNoAck && !o.dropAck) peer.json({ t: "registered", loc, status });
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
      // Only "device removed" (4401) is passed on to the device; everything else the box says is not.
      const said = peer.said;
      if (said && said.code === CLOSE.refused && said.reason === "device removed") conn.device.close(CLOSE.refused, "device removed");
      else conn.device.close(CLOSE.boxGone, "box closed the connection");
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
