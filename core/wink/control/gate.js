// @ts-check
// gate: the front door of a space's Headscale, as its own process (SPEC-wink-network 4.3 items 2, 10, 11; EC-3, EC-4, EC-5).
//
// Headscale's public listener also serves its REST API, its web paths and its debug paths, so the
// only thing between them and the internet is this allow-list. The gate is a small HTTP-aware
// reverse proxy and nothing else:
//
//   exact allow-list   /key, /ts2021 and, only with DERP on, /derp and /derp/probe. Matched by exact
//                      string on the path (no decoding, no normalisation, no prefix). Anything else,
//                      any other method, anything odd, gets the same 404 bytes and never reaches Headscale.
//   upgrades           /ts2021 (Upgrade: tailscale-control-protocol) and /derp (Upgrade: DERP) pass as
//                      raw bytes both ways once the upstream has been asked.
//   real address       the connecting address is the socket's, or, when the socket is a forwarder
//                      we trust, the one it names in one header. The gate DROPS every client-supplied
//                      X-Forwarded-*, Forwarded, True-Client-IP, X-Real-IP and the like and writes
//                      its own, so Headscale (trusted_proxies = the gate) logs and limits by the real address.
//   limits             header size, header and request time, a body on /key, idle time, the handshake
//                      deadline, per-address upgrades per window, concurrent upgrades, concurrent
//                      connections. Budgets are per address, never one global budget an outsider can spend.
//   reactive block     reportLog(line) takes Headscale's own log; an address that keeps failing is blocked.
//   no banner          no Server header, no version, no Node text; every refusal is the same bytes.
//
// It holds no secret except its own TLS key, runs under its own uid (gate-main.js drops privileges
// after binding), and talks to Headscale on a loopback port.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

/** The one refusal. Byte for byte the same whatever was asked. */
export const NOT_FOUND = Buffer.from("HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 10\r\nConnection: close\r\n\r\nnot found\n");
const TOO_MANY = Buffer.from("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
const UNAVAILABLE = Buffer.from("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");

/** sha256 pin of a certificate's public key (SPKI), "sha256/<base64>": what the sealed pairing record pins. @param {string|Buffer} pemOrDer */
export function certPin(pemOrDer) {
  const x = new crypto.X509Certificate(pemOrDer);
  return "sha256/" + crypto.createHash("sha256").update(x.publicKey.export({ type: "spki", format: "der" })).digest("base64");
}

/** Strip an IPv4-mapped prefix. @param {string|undefined} a */
function norm(a) { return String(a || "").replace(/^::ffff:/i, ""); }

/** The budget key of an address: IPv6 counts per /64, so a host cannot hop addresses inside its own prefix. @param {string} a */
export function addrKey(a) {
  a = norm(a);
  if (!net.isIPv6(a)) return a;
  const [head, tail = ""] = a.split("::");
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const full = a.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return full.slice(0, 4).map(x => x.toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/** @param {string} ip @param {string[]} list exact addresses or IPv4 CIDRs */
function inList(ip, list) {
  ip = norm(ip);
  const n = (/** @type {string} */ a) => a.split(".").reduce((x, y) => x * 256 + Number(y), 0);
  for (const e of list) {
    if (!e.includes("/")) { if (norm(e) === ip) return true; continue; }
    const [b, bits] = e.split("/");
    if (!net.isIPv4(ip) || !net.isIPv4(b)) continue;
    const size = 2 ** (32 - Number(bits));
    if (Math.floor(n(ip) / size) === Math.floor(n(b) / size)) return true;
  }
  return false;
}

const SPOOF = /^(x-forwarded-.*|forwarded|true-client-ip|x-real-ip|cf-connecting-ip|x-client-ip|x-cluster-client-ip|fastly-client-ip|via|proxy-.*|x-original-.*)$/i;

/**
 * Parse one line of Headscale's log ("http request ... path=/machine/register remote=1.2.3.4:5 status=401").
 * @param {string} line
 * @returns {{ addr: string, path: string, status: number }|null}
 */
export function parseHeadscaleLog(line) {
  const m = /\bpath=(\S+).*?\bremote=(\[[0-9a-f:]+\]|[0-9.]+|[0-9a-f:]+?)(?::\d+)?\b.*?\bstatus=(\d{3})\b/i.exec(String(line))
    || /\bremote=(\[[0-9a-f:]+\]|[0-9.]+)(?::\d+)?\b.*?\bpath=(\S+).*?\bstatus=(\d{3})\b/i.exec(String(line));
  if (!m) return null;
  const swap = /^\//.test(m[1]);
  const path = swap ? m[1] : m[2], addr = (swap ? m[2] : m[1]).replace(/^\[|\]$/g, "");
  return net.isIP(addr) ? { addr, path, status: Number(m[3]) } : null;
}

/**
 * @typedef {{
 *   listen?: { host?: string, port?: number },
 *   tls?: { cert: string, key: string } | null,
 *   upstream: { host?: string, port: number, tls?: boolean, pin?: string },
 *   derp?: boolean,
 *   forwarder?: { trust: string[], header: string },
 *   limits?: Partial<{ maxHeaderBytes: number, headersMs: number, requestMs: number, idleMs: number, upgradedIdleMs: number,
 *     handshakeMs: number, maxBodyBytes: number, windowMs: number, upgradesPerWindow: number, maxConcurrentUpgrades: number,
 *     maxConcurrentDerp: number, maxConnsPerAddr: number, maxConns: number, failThreshold: number, failWindowMs: number, blockMs: number }>,
 *   onEvent?: (e: { type: string, addr?: string, [k: string]: any }) => void,
 *   now?: () => number,
 * }} GateOptions
 */

/** @param {GateOptions} o */
export function createGate(o) {
  const L = {
    maxHeaderBytes: 8192, headersMs: 10_000, requestMs: 15_000, idleMs: 30_000, upgradedIdleMs: 10 * 60_000,
    handshakeMs: 10_000, maxBodyBytes: 0, windowMs: 60_000, upgradesPerWindow: 30, maxConcurrentUpgrades: 8,
    maxConcurrentDerp: 16, maxConnsPerAddr: 128, maxConns: 4096, failThreshold: 5, failWindowMs: 60_000, blockMs: 10 * 60_000,
    ...(o.limits || {}),
  };
  const now = o.now || Date.now;
  const emit = (/** @type {any} */ e) => { try { o.onEvent && o.onEvent(e); } catch { /* a listener never breaks the gate */ } };
  const fwd = o.forwarder ? { trust: o.forwarder.trust, header: o.forwarder.header.toLowerCase() } : null;
  const derpOn = !!o.derp;

  const stats = { accepted: 0, forwarded: 0, notFound: 0, upgrades: 0, derp: 0, limited: 0, blocked: 0, timeouts: 0 };
  /** @type {Map<string, number>} */ const blocked = new Map();
  /** @type {Map<string, number[]>} */ const windows = new Map();
  /** @type {Map<string, number>} */ const conns = new Map();
  /** @type {Map<string, number>} */ const ups = new Map();
  /** @type {Map<string, number>} */ const derps = new Map();
  /** @type {Map<string, number[]>} */ const fails = new Map();
  /** @type {Set<import("node:net").Socket>} */ const open = new Set();

  const bump = (/** @type {Map<string, number>} */ m, /** @type {string} */ k, /** @type {number} */ d) => { const v = (m.get(k) || 0) + d; if (v <= 0) m.delete(k); else m.set(k, v); return v; };

  function isBlocked(/** @type {string} */ addr) {
    const k = addrKey(addr), until = blocked.get(k);
    if (until === undefined) return false;
    if (until <= now()) { blocked.delete(k); return false; }
    return true;
  }
  /** @param {string} addr @param {number} [ms] */
  function block(addr, ms = L.blockMs) {
    blocked.set(addrKey(addr), now() + ms);
    emit({ type: "block", addr: addrKey(addr), ms });
  }

  /** The address the limits and Headscale see. @param {import("node:http").IncomingMessage} req */
  function realAddr(req) {
    const peer = norm(req.socket.remoteAddress);
    if (fwd && inList(peer, fwd.trust)) {
      const v = req.headers[fwd.header];
      const s = Array.isArray(v) ? "" : String(v || "").trim();
      if (s && net.isIP(s)) return norm(s);
    }
    return peer;
  }

  /** What a request is, or null. Exact string match; nothing is decoded or normalised. @param {import("node:http").IncomingMessage} req @param {boolean} upgrade */
  function classify(req, upgrade) {
    const url = String(req.url || "");
    const qi = url.indexOf("?");
    const p = qi < 0 ? url : url.slice(0, qi), query = qi < 0 ? "" : url.slice(qi + 1);
    if (query && !/^[A-Za-z0-9=&._-]{0,64}$/.test(query)) return null;
    const up = String(req.headers.upgrade || "").toLowerCase();
    const m = req.method;
    if (p === "/key" && !upgrade && m === "GET") return "key";
    if (p === "/ts2021" && upgrade && (m === "POST" || m === "GET") && up === "tailscale-control-protocol") return query ? null : "control";
    if (derpOn && p === "/derp" && upgrade && m === "GET" && up === "derp" && !query) return "derp";
    if (derpOn && p === "/derp/probe" && !upgrade && (m === "GET" || m === "HEAD") && !query) return "probe";
    return null;
  }

  /** The request head for the upstream: the client's headers minus every spoofable one, plus ours. */
  function headFor(/** @type {import("node:http").IncomingMessage} */ req, /** @type {string} */ addr, /** @type {boolean} */ upgrade) {
    /** @type {[string, string][]} */ const out = [];
    const raw = req.rawHeaders;
    for (let i = 0; i < raw.length; i += 2) {
      const n = raw[i], low = n.toLowerCase();
      if (SPOOF.test(low) || (fwd && low === fwd.header)) continue;
      if (!upgrade && (low === "connection" || low === "keep-alive" || low === "upgrade" || low === "te" || low === "transfer-encoding" || low === "content-length")) continue;
      out.push([n, raw[i + 1]]);
    }
    out.push(["X-Forwarded-For", addr], ["True-Client-IP", addr], ["X-Real-IP", addr]);
    if (!upgrade) out.push(["Connection", "close"]);
    return out;
  }

  /**
   * A connected socket to Headscale. With a TLS upstream it resolves only after the handshake and the
   * pin check, so nothing is ever written to a server that is not the pinned one.
   * @returns {Promise<import("node:net").Socket>}
   */
  function connectUpstream() {
    const u = o.upstream;
    return new Promise((resolve, reject) => {
      if (!u.tls) {
        const s = net.connect({ host: u.host || "127.0.0.1", port: u.port });
        s.once("connect", () => { s.removeListener("error", reject); resolve(s); });
        s.once("error", reject);
        return;
      }
      const s = tls.connect({ host: u.host || "127.0.0.1", port: u.port, servername: "localhost", rejectUnauthorized: false });
      s.once("secureConnect", () => {
        const peer = s.getPeerCertificate();
        if (u.pin && !(peer && peer.raw && certPin(peer.raw) === u.pin)) { s.destroy(); reject(new Error("upstream certificate does not match the pin")); return; }
        s.removeListener("error", reject); resolve(s);
      });
      s.once("error", reject);
    });
  }

  /** @param {import("node:net").Socket} s @param {Buffer} bytes */
  function refuse(s, bytes) { try { s.end(bytes); } catch { /* gone */ } setTimeout(() => s.destroy(), 1000).unref(); }

  /** @type {import("node:http").Server} */
  const server = o.tls
    ? https.createServer({ cert: o.tls.cert, key: o.tls.key, minVersion: "TLSv1.2", ALPNProtocols: ["http/1.1"], handshakeTimeout: L.handshakeMs, maxHeaderSize: L.maxHeaderBytes })
    : http.createServer({ maxHeaderSize: L.maxHeaderBytes });
  server.headersTimeout = L.headersMs;
  server.requestTimeout = L.requestMs;
  server.keepAliveTimeout = 1000;
  server.maxConnections = L.maxConns;

  server.on("connection", raw => {
    stats.accepted++;
    const a = norm(raw.remoteAddress), k = addrKey(a);
    if (isBlocked(a)) { stats.blocked++; raw.destroy(); return; }
    if (bump(conns, k, 1) > L.maxConnsPerAddr) { stats.limited++; bump(conns, k, -1); raw.destroy(); emit({ type: "limit", addr: k, what: "connections" }); return; }
    open.add(raw);
    raw.on("close", () => { bump(conns, k, -1); open.delete(raw); });
    raw.on("error", () => { /* a reset is not news */ });
  });
  /** @param {import("node:net").Socket} s */
  const idle = s => { s.setTimeout(L.idleMs, () => { stats.timeouts++; s.destroy(); }); };
  if (o.tls) server.on("secureConnection", idle); else server.on("connection", idle);
  server.on("tlsClientError", (_e, s) => { try { s.destroy(); } catch { /* gone */ } });
  server.on("clientError", (_e, s) => { stats.notFound++; if (s.writable) refuse(s, NOT_FOUND); else s.destroy(); });

  // Plain requests: only GET /key reaches Headscale.
  server.on("request", (req, res) => {
    const sock = req.socket;
    const addr = realAddr(req);
    const kind = classify(req, false);
    const cl = Number(req.headers["content-length"] || 0);
    if (isBlocked(addr)) { stats.blocked++; sock.destroy(); return; }
    if (!kind || req.headers["transfer-encoding"] || cl > L.maxBodyBytes || req.headers.upgrade) {
      stats.notFound++; emit({ type: "notfound", addr: addrKey(addr) });
      refuse(sock, NOT_FOUND); return;
    }
    stats.forwarded++;
    connectUpstream().then(conn => {
      const agent = new http.Agent({ keepAlive: false });
      /** @type {any} */ (agent).createConnection = () => conn;
      const up = http.request({ method: req.method, path: req.url, agent, timeout: 10_000, headers: Object.fromEntries(headFor(req, addr, false)) }, ures => {
        const h = { ...ures.headers };
        delete h.server; delete h.date;
        res.writeHead(ures.statusCode || 502, h);
        let n = 0;
        ures.on("data", d => { n += d.length; if (n > 262_144) { ures.destroy(); res.destroy(); } else res.write(d); });
        ures.on("end", () => res.end());
      });
      up.on("timeout", () => up.destroy());
      up.on("error", () => { stats.timeouts++; if (!res.headersSent) refuse(sock, UNAVAILABLE); else sock.destroy(); });
      up.end();
    }, () => { stats.timeouts++; refuse(sock, UNAVAILABLE); });
  });

  // Upgrades: /ts2021 and /derp pass as bytes.
  server.on("upgrade", (req, socket, head) => {
    const addr = realAddr(req), k = addrKey(addr);
    socket.on("error", () => { /* a reset is not news */ });
    if (isBlocked(addr)) { stats.blocked++; socket.destroy(); return; }
    const kind = classify(req, true);
    if (!kind) { stats.notFound++; emit({ type: "notfound", addr: k }); refuse(/** @type {any} */ (socket), NOT_FOUND); return; }
    const isDerp = kind === "derp";
    const t = now();
    const w = (windows.get(k) || []).filter(x => x > t - L.windowMs);
    const live = bump(isDerp ? derps : ups, k, 1);
    if (w.length >= L.upgradesPerWindow || live > (isDerp ? L.maxConcurrentDerp : L.maxConcurrentUpgrades)) {
      bump(isDerp ? derps : ups, k, -1);
      stats.limited++; emit({ type: "limit", addr: k, what: w.length >= L.upgradesPerWindow ? "rate" : "concurrent" });
      refuse(/** @type {any} */ (socket), TOO_MANY); return;
    }
    w.push(t); windows.set(k, w);
    if (windows.size > 20_000) for (const [a, v] of windows) if (!v.some(x => x > t - L.windowMs)) windows.delete(a);
    stats[isDerp ? "derp" : "upgrades"]++;

    let done = false, upstream = /** @type {import("node:net").Socket|null} */ (null), linger = /** @type {any} */ (null);
    const finish = () => { if (done) return; done = true; clearTimeout(dl); clearTimeout(linger); bump(isDerp ? derps : ups, k, -1); socket.destroy(); if (upstream) upstream.destroy(); };
    // Handshake deadline: from the request to the first byte back.
    const dl = setTimeout(() => { stats.timeouts++; emit({ type: "timeout", addr: k, what: "handshake" }); finish(); }, L.handshakeMs);
    dl.unref();
    socket.on("close", finish);
    // Either side ending ends the session: after a short grace for bytes in flight, so no slot is held by a half-open pipe.
    const lingerThenClose = () => { if (!linger) { linger = setTimeout(finish, 1500); linger.unref(); } };
    socket.on("end", lingerThenClose);
    connectUpstream().then(up => {
      if (done) { up.destroy(); return; }
      upstream = up;
      up.once("data", () => clearTimeout(dl));
      up.on("error", () => { if (!done && !socket.destroyed) { try { socket.write(UNAVAILABLE); } catch { /* gone */ } } finish(); });
      up.on("close", finish); up.on("end", lingerThenClose);
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...headFor(req, addr, true).map(([n, v]) => `${n}: ${v}`)];
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head && head.length) up.write(head);
      socket.setTimeout(L.upgradedIdleMs, () => { stats.timeouts++; finish(); });
      up.setTimeout(L.upgradedIdleMs, () => finish());
      socket.pipe(up); up.pipe(socket);
      stats.forwarded++;
    }, () => { if (!done && !socket.destroyed) { try { socket.write(UNAVAILABLE); } catch { /* gone */ } } finish(); });
  });

  /** Fed Headscale's own log, line by line: an address that keeps failing is blocked. @param {string} line */
  function reportLog(line) {
    const r = parseHeadscaleLog(line);
    if (!r || r.status < 400) return;
    if (!/^\/(machine\/|ts2021|key)/.test(r.path)) return;
    const k = addrKey(r.addr), t = now();
    const list = (fails.get(k) || []).filter(x => x > t - L.failWindowMs);
    list.push(t); fails.set(k, list);
    if (list.length >= L.failThreshold && !isBlocked(r.addr)) { fails.delete(k); block(r.addr); }
  }

  /** @type {string|null} */
  let pin = o.tls ? certPin(o.tls.cert) : null;

  return {
    get pin() { return pin; },
    /** A renewed certificate takes effect for the next handshake; open connections keep theirs. Only a TLS gate has one. @param {{ cert: string, key: string }} t */
    setTls(t) {
      if (!o.tls) throw new Error("this gate does not serve TLS");
      const next = certPin(t.cert);
      /** @type {import("node:https").Server} */ (server).setSecureContext({ cert: t.cert, key: t.key });
      pin = next;
    },
    stats: () => ({ ...stats, open: open.size, blockedAddrs: blocked.size }),
    block, isBlocked, reportLog,
    unblock(/** @type {string} */ addr) { blocked.delete(addrKey(addr)); },
    listen() {
      const l = o.listen || {};
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(l.port || 0, l.host || "127.0.0.1", () => {
          const a = /** @type {net.AddressInfo} */ (server.address());
          resolve({ host: a.address, port: a.port });
        });
      });
    },
    address() { const a = /** @type {net.AddressInfo|null} */ (server.address()); return a ? { host: a.address, port: a.port } : null; },
    close() {
      return new Promise(resolve => {
        server.close(() => resolve(undefined));
        for (const s of open) s.destroy();
      });
    },
  };
}
