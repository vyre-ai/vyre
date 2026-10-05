// @ts-check
// The relay in plain Node (ADR 0026, section 2): the same protocol as the Cloudflare Worker in
// relay/worker/, for tests and for anyone who would rather run their own relay. No dependencies:
// node:http and the RFC 6455 framing in core/computers/ws.js.
//
//   GET /v1/box?route=<id>                  the box's control socket, after a signed challenge
//   GET /v1/box?route=<id>&c=<conn>&t=<ticket>   the box's data socket for one device connection
//   GET /v1/device?route=<id>               a device; the relay tells the box, then pipes frames
//   POST /v1/wink/code                      one step of a typed Wink code's PAKE, forwarded to the box that holds the rendezvous
//   POST /v1/pair                           resolve a Wink ticket's or a setup offer's locator
//   POST /v1/setup/mbx                      append a line to a setup progress mailbox (the install script)
//   GET /v1/setup/mbx                       read it, long poll, signed by the setup page's key
//   GET /health
//
// The relay never reads a device frame. It learns addresses, timing, sizes and route ids.

import http from "node:http";
import crypto from "node:crypto";
import net from "node:net";
import { acceptKey, encodeFrame, FrameParser } from "../../lib/ws.js";
import { createTunnelFront } from "./tunnel.js";
import { LIMITS, CLOSE, ROUTE_RE, routeId, authMessage, verifyRoute, TICKET_TTL, SETUP_TTL, MBX_LINE_MAX, isP256Spki, setupFingerprint, verifyP256, mbxReadMessage, CODE, CODE_ALPHABET, CODE_RV_RE, CODE_REFUSED } from "../../core/relay/wire.js";

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
 * @param {{ limits?: Partial<typeof LIMITS>, setup?: { maxBoxes?: number, createPerIp?: number }, code?: Partial<typeof CODE>, clientAddress?: (req: import("node:http").IncomingMessage) => string, log?: (event: string, x?: any) => void }} [o]
 */
/** What this relay does that a box may rely on, told in `ready` (an older relay says nothing): `registered` answers every ticket registration with 200 or 409. */
export const FEATURES = ["registered", "revoke", "code"];

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
  /** @type {Map<string, { record: string, mac: string, exp: number, route?: string, setup?: boolean, contested?: boolean, revoked?: boolean }>} */
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
    if (cur.contested || cur.revoked) return 409;
    if (cur.record === t.record && cur.mac === t.mac) return 200;
    cur.contested = true;
    return 409;
  };
  /** A box withdraws a ticket it registered (a renewal replaces the previous one): only the route that registered it may. @param {string} loc @param {string} route @returns {200|404} */
  const revokeLoc = (loc, route) => {
    const t = pairTickets.get(loc);
    if (!t || t.setup || t.revoked || t.exp <= Date.now() || !t.route || t.route !== route) return 404;
    // The owner's withdrawal leaves a tombstone until the ticket's own exp: nobody, an outsider least of all, may register that locator again, and it resolves to nothing.
    pairTickets.set(loc, { record: "", mac: "", exp: t.exp, revoked: true });
    return 200;
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
  // Charged to misses only, per address, and no global limit: a hit (or a contested ticket) is always served, so nothing an
  // outsider sends can stop a real pairing, and a shared address cannot block one (GHSA-25xh-w9j7-7v28).
  const pairResolveLimitByIp = rateLimiter(30, 60_000);

  // The typed Wink code's rendezvous (spec 6.5; relay/worker/index.js CodeSlot for the whole contract).
  // A box asks, over its own control socket, for a free two-symbol rendezvous (5 minutes, one live code
  // per box). A typing device POSTs a PAKE message under that rendezvous; the relay forwards it to the
  // control socket of the route that allocated it and returns the box's answer, and nowhere else. It
  // keeps no state for a rendezvous that is not live and nothing derived from a password: a message is
  // an opaque string it passes along. A hit also names the route (the typist needs it for the transcript, see relay/client/code.js). Limits are per address, never global: every session (step 1)
  // costs `sessionPerMin`, every later step `stepPerMin`, and a miss (no live rendezvous) `missPerMin`
  // more. An unknown, closed or expired rendezvous, a refusal and a silent box all give one answer.
  const codeCfg = { ...CODE, ...(o.code || {}) };
  /** @type {Map<string, { route: string, exp: number }>} */
  const codeSlots = new Map();
  /** @type {Map<string, string>} route -> rendezvous */
  const routeCode = new Map();
  /** @type {Map<string, { route: string, done: (m: string|null) => void, timer: any }>} */
  const codePending = new Map();
  const codeSessionLimit = rateLimiter(codeCfg.sessionPerMin, 60_000);
  const codeStepLimit = rateLimiter(codeCfg.stepPerMin, 60_000);
  const codeMissLimit = rateLimiter(codeCfg.missPerMin, 60_000);
  const codeAllocLimit = rateLimiter(codeCfg.allocPerMin, 60_000);
  const addressOf = req => o.clientAddress ? o.clientAddress(req) : String(req.socket.remoteAddress || "");
  const sweepCodes = () => { const now = Date.now(); for (const [rv, c] of codeSlots) if (c.exp <= now) { codeSlots.delete(rv); if (routeCode.get(c.route) === rv) routeCode.delete(c.route); } };
  /** Frees a route's code and refuses what is waiting on it. @param {string} route */
  const releaseCode = route => {
    const rv = routeCode.get(route);
    if (rv && codeSlots.get(rv)?.route === route) codeSlots.delete(rv);
    routeCode.delete(route);
    for (const [q, p] of codePending) if (p.route === route) { clearTimeout(p.timer); codePending.delete(q); p.done(null); }
  };
  /** Refuses what is waiting on a route's code but keeps the code itself (the box's control socket changed; the code did not). @param {string} route */
  const refusePending = route => { for (const [q, p] of codePending) if (p.route === route) { clearTimeout(p.timer); codePending.delete(q); p.done(null); } };
  /** A box whose control socket drops keeps its code for a short grace so a reconnect (a flapping link, a relay behind a proxy that cuts idle sockets) does not silently kill the code
   * its screen still shows; the code's own expiry still applies. A different box never gets the slot: only the same route key can authenticate as the route. @type {Map<string, any>} */
  const codeGrace = new Map();
  const keepCode = route => {
    if (!routeCode.has(route)) return;
    clearTimeout(codeGrace.get(route));
    const t = setTimeout(() => { codeGrace.delete(route); if (!routes.get(route)?.control) releaseCode(route); }, codeCfg.graceMs);
    t.unref?.();
    codeGrace.set(route, t);
  };
  const resumeCode = route => { clearTimeout(codeGrace.get(route)); codeGrace.delete(route); };
  /** A free rendezvous, random among the free ones, or null. @param {string} route */
  const allocCode = route => {
    sweepCodes();
    releaseCode(route);
    const free = [];
    for (let i = 0; i < 1024; i++) { const rv = CODE_ALPHABET[i >> 5] + CODE_ALPHABET[i & 31]; if (!codeSlots.has(rv)) free.push(rv); }
    if (!free.length) return null;
    const rv = free[crypto.randomInt(free.length)];
    const exp = Date.now() + codeCfg.ttl;
    codeSlots.set(rv, { route, exp });
    routeCode.set(route, rv);
    return { rv, exp };
  };
  /** The box side of a code: allocate, release, and answer a forwarded message. */
  function onCodeControl(route, peer, t) {
    if (t.t === "code.alloc") {
      if (!codeAllocLimit(route)) { peer.json({ t: "code.allocated", error: "busy" }); return; }
      const a = allocCode(route);
      peer.json(a ? { t: "code.allocated", rv: a.rv, exp: a.exp } : { t: "code.allocated", error: "busy" });
    } else if (t.t === "code.release") releaseCode(route);
    else if (t.t === "code.reply") {
      const p = codePending.get(String(t.q));
      // Only the route the message was forwarded to may answer it.
      if (!p || p.route !== route) return;
      clearTimeout(p.timer);
      codePending.delete(String(t.q));
      const m = typeof t.m === "string" && t.m.length > 0 && t.m.length <= codeCfg.msg && /^[A-Za-z0-9_-]+$/.test(t.m) ? t.m : null;
      p.done(m);
    }
  }
  const refused = res => { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify(CODE_REFUSED)); };
  function onCodeStep(req, res) {
    const ip = addressOf(req);
    let body = "";
    let over = false;
    req.on("data", c => { body += c; if (body.length > 1024) { over = true; req.destroy(); } });
    req.on("end", () => {
      if (over) return;
      let m;
      try { m = JSON.parse(body); } catch { reply(res, 400, { error: "bad request" }); return; }
      const rv = String(m?.rv || ""), s = String(m?.s || ""), n = Number(m?.n), msg = String(m?.m || "");
      if (!CODE_RV_RE.test(rv) || !/^[A-Za-z0-9_-]{22}$/.test(s) || (n !== 1 && n !== 3) || !/^[A-Za-z0-9_-]+$/.test(msg) || msg.length > codeCfg.msg) { reply(res, 400, { error: "bad request" }); return; }
      // Charged to the address that asked, before anything is looked up, whether or not the code is live.
      if (!(n === 1 ? codeSessionLimit(ip) : codeStepLimit(ip))) { reply(res, 429, { error: "too many tries; wait a minute" }); return; }
      sweepCodes();
      const slot = codeSlots.get(rv);
      const control = slot && routes.get(slot.route)?.control;
      if (!slot || !control) {
        // A miss: charged again, to this address only. Nothing is created for it.
        if (!codeMissLimit(ip)) { reply(res, 429, { error: "too many tries; wait a minute" }); return; }
        refused(res); return;
      }
      if (codePending.size >= codeCfg.pending * 16 || [...codePending.values()].filter(p => p.route === slot.route).length >= codeCfg.pending) { refused(res); return; }
      const q = crypto.randomBytes(9).toString("base64url");
      const timer = setTimeout(() => { codePending.delete(q); refused(res); }, codeCfg.waitMs);
      timer.unref?.();
      codePending.set(q, { route: slot.route, timer, done: out => { if (out) reply(res, 200, { m: out, route: slot.route }); else refused(res); } });
      control.json({ t: "code.msg", q, rv, s, n, m: msg });
    });
    req.on("error", () => {});
  }

  // Reach check (core/wink/reach.js): a box that asked its own router for a port asks, from outside, whether the port answers. This is a remote-connect endpoint, so it dials ONLY the
  // caller's own observed address (a body `addr` that differs is refused), only a public one (unless a test allows a private one), only a port from 1024, one TCP connect with a
  // short timeout, and a few tries a minute per address. It sends nothing and reads nothing: a connect either completes or it does not.
  const reachLimit = rateLimiter(o.reach?.perMin ?? 6, 60_000);
  const reachDial = o.reach?.dial || ((addr, port) => new Promise(resolve => {
    const s = net.connect({ host: addr, port, timeout: 3000 });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("timeout", () => { s.destroy(); resolve(false); });
    s.once("error", () => resolve(false));
  }));
  const publicAddress = a => { const v = String(a).replace(/^::ffff:/, ""); return !(net.isIP(v) === 0 || /^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1$|fe80:|f[cd][0-9a-f]{2}:)/i.test(v) || /^172\.(1[6-9]|2\d|3[01])\./.test(v) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v)); };
  function onReachCheck(req, res) {
    const reply = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const ip = addressOf(req).replace(/^::ffff:/, "");
    if (!reachLimit(ip)) return reply(429, { error: { code: "rate_limited", message: "a few checks a minute" } });
    let body = "";
    req.on("data", c => { body += c; if (body.length > 512) req.destroy(); });
    req.on("end", async () => {
      let j; try { j = JSON.parse(body); } catch { return reply(400, { error: { code: "bad_input", message: "JSON with a port" } }); }
      const port = Number(j && j.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return reply(400, { error: { code: "bad_input", message: "a port from 1024 to 65535" } });
      if (j.addr && String(j.addr).replace(/^::ffff:/, "") !== ip) return reply(400, { error: { code: "not_your_address", message: "the relay only checks the address it sees you at" } });
      if (!o.reach?.allowPrivate && !publicAddress(ip)) return reply(200, { reachable: false, why: "your address is not a public one" });
      reply(200, { reachable: Boolean(await reachDial(ip, port)), addr: ip, port });
    });
    req.on("error", () => {});
  }

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
    if (url.pathname === "/v1/wink/code" && req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" });
      res.end();
      return;
    }
    if (url.pathname === "/v1/wink/code" && req.method === "POST") { res.setHeader("access-control-allow-origin", "*"); onCodeStep(req, res); return; }
    if (url.pathname === "/v1/pair" && req.method === "POST") { res.setHeader("access-control-allow-origin", "*"); onPairResolve(req, res); return; }
    if (url.pathname === "/v1/reach/check" && req.method === "POST") { onReachCheck(req, res); return; }
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
      if (t && !t.setup && !t.revoked) pairTickets.delete(loc);
      if (!t || t.exp <= Date.now() || !t.record) {
        // A miss is charged to this address only.
        if (!pairResolveLimitByIp(ip)) { res.writeHead(429, { "content-type": "application/json" }); res.end('{"error":"too many pairing attempts; wait a minute"}'); return; }
        res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"this pairing code has expired or was already used"}'); return;
      }
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
      // The same box reconnecting keeps the code its screen shows (until it expires); only what was in flight on the old socket is refused.
      resumeCode(route);
      refusePending(route);
      r.control = peer;
      r.ticket = crypto.randomBytes(18).toString("base64url");
      peer.json({ t: "ready", ticket: r.ticket, waiting: [...r.conns].filter(([, x]) => !x.box && !x.tunnel).map(([c]) => c), ...(o.legacyNoAck ? {} : { features: o.tunnel ? [...FEATURES, "tunnel"] : FEATURES }) });
      log("box.connected", { route });
      // The only thing a control socket sends after auth: registering a pairing ticket's locator
      // (ADR 0045). Everything here is the box's own word about its own route, so this is not a
      // trust boundary the way the HTTP resolve side is; the size caps and the register-side
      // rate limit are just hygiene against a runaway or compromised box, not the real defence.
      peer.onmessage = (d2, bin2) => {
        if (bin2) return;
        let t;
        try { t = JSON.parse(d2.toString()); } catch { return; }
        if (typeof t?.t === "string" && t.t.startsWith("code.")) { onCodeControl(route, peer, t); return; }
        if (!pairRegisterLimit(route)) return;
        if (t?.t === "revoke") {
          const rloc = String(t.loc || "");
          if (!/^[A-Za-z0-9_-]{20,64}$/.test(rloc)) return;
          if (!o.legacyNoAck && !o.dropAck) peer.json({ t: "revoked", loc: rloc, status: revokeLoc(rloc, route) });
          return;
        }
        if (t?.t !== "ticket" && t?.t !== "setup") return;
        const setup = t.t === "setup";
        const loc = String(t.loc || ""), record = String(t.record || ""), mac = String(t.mac || "");
        if (!/^[A-Za-z0-9_-]{20,64}$/.test(loc) || !/^[A-Za-z0-9_-]{20,64}$/.test(mac) || !SEALED.test(record)) return;
        const exp = Math.min(Number(t.exp) || 0, Date.now() + (setup ? SETUP_TTL : TICKET_TTL));
        if (exp <= Date.now()) return;
        // The box hears the outcome: 200, or 409 when another server registered this locator first.
        const status = registerLoc(loc, { record, mac, exp, route, ...(setup ? { setup: true } : {}) });
        // `legacyNoAck` (tests only) behaves as the relay deployed before 30 Sep did: it stores the ticket and says nothing back.
        if (!o.legacyNoAck && !o.dropAck) peer.json({ t: "registered", loc, status });
      };
    };
    peer.onclose = () => {
      const r = routes.get(route);
      if (r && r.control === peer) { r.control = null; r.ticket = null; refusePending(route); keepCode(route); log("box.disconnected", { route }); }
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
    if (conn.onbox) conn.onbox(true);
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

  // The Publish tunnel (relay/node/tunnel.js): a public visitor is a connection like a device's, except that the far end is a TCP socket and the open message is `tunnel`, which carries the
  // name and the visitor's address on this authenticated channel (never in the bytes). An old box ignores the message and the visitor times out.
  /** @type {ReturnType<typeof createTunnelFront> | null} */
  const tunnelFront = o.tunnel ? createTunnelFront({
    resolve: o.tunnel.resolve, log, ...(o.tunnel.limits ? { limits: o.tunnel.limits } : {}),
    open: async (route, visitor, sink) => {
      const r = routes.get(route);
      if (!r || !r.control || !r.control.socket || r.conns.size >= limits.open) return null;
      const c = crypto.randomBytes(12).toString("base64url");
      const conn = /** @type {any} */ ({ tunnel: true, buffer: [], box: null,
        // the "device" end of a connection is the visitor's socket here: what the box sends comes out as bytes, and closing it closes the visitor
        device: /** @type {any} */ ({
          send: (/** @type {Buffer} */ data) => { if (sink.data(Buffer.from(data)) === false && conn.box) { conn.box.socket.pause(); sink.whenDrained(() => conn.box && conn.box.socket.resume()); } },
          close: () => sink.end(),
        }) });
      r.conns.set(c, conn);
      const answered = new Promise(resolve => { conn.onbox = resolve; });
      r.control.json({ t: "tunnel", c, host: visitor.host, ip: visitor.ip, port: visitor.port });
      const timer = setTimeout(() => conn.onbox(false), Math.max(200, ((o.tunnel.limits && o.tunnel.limits.openMs) || 8000) - 500));
      timer.unref?.();
      const ok = await answered;
      clearTimeout(timer);
      if (!ok || !conn.box) { r.conns.delete(c); tidy(route); return null; }
      const box = conn.box;
      return {
        write: b => { box.send(b); if (box.socket.writableNeedDrain) { box.socket.once("drain", sink.resume); return false; } return true; },
        close: () => { if (r.conns.get(c) === conn) { r.conns.delete(c); tidy(route); } box.close(CLOSE.deviceGone, "visitor left"); },
      };
    },
  }) : null;
  /** @type {import("node:net").Server[]} */
  const tunnelServers = [];

  return {
    server,
    /** The public listeners of the Publish tunnel: TLS passthrough on `tlsPort` (443) and the fixed redirect on `httpPort` (80). Only with the `tunnel` option. @param {{ tlsPort?: number, httpPort?: number, host?: string }} [a] @returns {Promise<{ tls: number, http: number }>} */
    listenTunnel(a = {}) {
      if (!tunnelFront) return Promise.reject(new Error("this relay was made without the tunnel option"));
      const host = a.host || "127.0.0.1";
      const front = tunnelFront;
      const t = net.createServer(s => front.tls(s)), h = net.createServer(s => front.http(s));
      tunnelServers.push(t, h);
      const on = (/** @type {import("node:net").Server} */ srv, /** @type {number|undefined} */ port) => new Promise(resolve => srv.listen(port ?? 0, host, () => resolve(/** @type {import("node:net").AddressInfo} */ (srv.address()).port)));
      return Promise.all([on(t, a.tlsPort), on(h, a.httpPort)]).then(([tls, http]) => ({ tls, http }));
    },
    tunnel: tunnelFront,
    /** @param {number} [port] @param {string} [host] @returns {Promise<string>} the relay's ws:// base */
    listen(port = 0, host = "127.0.0.1") {
      return new Promise(resolve => server.listen(port, host, () => {
        const a = /** @type {import("node:net").AddressInfo} */ (server.address());
        resolve(`ws://${host}:${a.port}`);
      }));
    },
    /** For tests: how many routes and connections the relay holds, and live codes and requests waiting on a box. */
    stats() { return { routes: routes.size, conns: [...routes.values()].reduce((n, r) => n + r.conns.size, 0), codes: codeSlots.size, codeRequests: codePending.size }; },
    close() {
      tunnelFront && tunnelFront.close();
      for (const srv of tunnelServers) srv.close();
      for (const r of routes.values()) { r.control?.close(1001, "relay stopping"); for (const x of r.conns.values()) { x.device.close(1001); x.box?.close(1001); } }
      routes.clear();
      return new Promise(resolve => { server.close(() => resolve(undefined)); server.closeAllConnections?.(); });
    },
  };
}
