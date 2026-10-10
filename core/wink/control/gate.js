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
//   tunnel address     a loopback peer (the tunnel end, lib/publish/tunnel.js) may begin with a PROXY v2 header (lib/publish/proxy.js) naming the visitor the relay saw. The gate then limits, blocks and
//                      forwards that address, not 127.0.0.1, so one stranger cannot spend every client's budget. From any other peer the bytes are never read as a header.
//   limits             header size, header and request time, a body on /key, idle time, the handshake
//                      deadline, per-address upgrades per window, concurrent upgrades, concurrent
//                      connections. Budgets are per address, never one global budget an outsider can spend.
//   reactive block     reportLog(line) takes Headscale's own log; an address that keeps failing is blocked.
//   no banner          no Server header, no version, no Node text; every refusal is the same bytes.
//   public ingress     with `ingress` set (the public gate only) two more things, by exact shape, reach two loopback listeners of this box and nothing else:
//                      POST /hooks/<route> (a signed webhook, 256 KB at most, its signature checked at the home by core/hooks) and GET|HEAD /s/<token> (a public
//                      share link, core/artifacts/share-server.js). No query, no upgrade, no other path or method: the same 404 bytes as everything else.
//                      The two MCP doors beside them are exactly POST /vault-mcp (the Vault's passes) and POST /agents-mcp (outside agents), JSON up to 64 KB, the Authorization header kept for that
//                      listener alone, each with its own per-source budget.
//   app hosts          with `ingress.apps` and `ingress.appsSuffix` (".<name>.vyre.run") a request whose Host is exactly one label under the box's name (and, over TLS, whose SNI is that same host) is an app
//                      module's own origin. The Host is matched against the list of installed RUNNING apps BEFORE anything of the request is read: an unknown label gets the same 404 bytes and its body is
//                      never read. A known one is carried to the apps' loopback front (core/appmods, which answers by Host) with the Host kept, any method and path, a body streamed up to 64 MB, under its own
//                      per-address budget. A WebSocket upgrade on an app host (GET, Upgrade: websocket) is carried the same way as bytes both ways to the front, under its own per-address budgets, counted apart from Headscale's; the front decides who may open one.
//
// It holds no secret except its own TLS key, runs under its own uid (gate-main.js drops privileges
// after binding), and talks to Headscale on a loopback port.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import { decodeProxyV2, PROXY_V2_MAX } from "../../../lib/publish/proxy.js";

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

/** The two public ingress shapes. Exact: no decoding, no query, no normalisation. */
const HOOK_PATH = /^\/hooks\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHARE_PATH = /^\/s\/[A-Za-z0-9_-]{22,64}\/?$/;
const HOOK_TYPES = new Set(["application/json", "application/x-www-form-urlencoded"]);
export const INGRESS_BODY_LIMIT = 256 * 1024;
/** Per address, per window: a public link or a webhook sender never needs more. */
const INGRESS_PER_WINDOW = 120;
/** The Vault MCP (core/vault/passmcp.js): exactly POST /vault-mcp, a JSON body of at most 64 KB, its own per-source limit in front of the vault's own. The Authorization header goes through to that listener and nowhere else. */
const VAULTMCP_PATH = "/vault-mcp", VAULTMCP_BODY_LIMIT = 64 * 1024, VAULTMCP_PER_WINDOW = 60;
/** The outside agents' MCP (core/outside, team/contracts/ext-agents.md): exactly `POST /agents-mcp`, the same body limit and per-source budget as the Vault MCP, each counted on its own. */
const AGENTSMCP_PATH = "/agents-mcp";
const MCP_SHAPES = /** @type {Record<string, "vaultmcp" | "agentsmcp">} */ ({ [VAULTMCP_PATH]: "vaultmcp", [AGENTSMCP_PATH]: "agentsmcp" });
/** An app's screens load dozens of files per page, so an app host has its own, larger per-address budget in the same window (override with limits.appsPerWindow). */
const APPS_PER_WINDOW = 600;
export const APPS_BODY_LIMIT = 64 * 1024 * 1024;
const APP_LABEL = /^[a-z][a-z0-9-]{1,30}$/;
const TOO_LARGE = Buffer.from("HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
const HOP = /^(connection|keep-alive|upgrade|te|trailer|transfer-encoding|proxy-.*|host)$/i;

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
 *   proxy?: { trust?: string[] },   the peers whose connections may begin with a PROXY v2 header (default: loopback, where the tunnel end connects from)
 *   ingress?: { vaultmcp?: () => number | null | Promise<number | null>, agentsmcp?: () => number | null | Promise<number | null>, hooks: () => number | null | Promise<number | null>, share: () => number | null | Promise<number | null>, apps?: () => ({ port: number, hosts: string[] } | null) | Promise<{ port: number, hosts: string[] } | null>, appsSuffix?: string },   loopback ports of the hooks listener and the share server, asked per request (null: not listening, answered as 404); `apps` answers the apps' front port and the hosts of the installed RUNNING apps
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
    appsUpgradesPerWindow: 60, appsConcurrentUpgrades: 16,
    appsPerWindow: APPS_PER_WINDOW, appsBodyBytes: APPS_BODY_LIMIT, appsRequestMs: 10 * 60_000, appsIdleMs: 120_000,
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

  const proxyTrust = (o.proxy && o.proxy.trust) || ["127.0.0.0/8", "::1"];
  /** The visitor a trusted peer named in its PROXY v2 header, by the raw socket. @type {WeakMap<import("node:net").Socket, string>} */
  const named = new WeakMap();
  /** The address of a connection: the one its PROXY header named, else the socket's own. A TLS socket is looked up by the raw socket under it. @param {any} sock */
  const peerOf = sock => {
    const hit = named.get(sock) || (sock && sock._parent ? named.get(sock._parent) : undefined);
    return hit !== undefined ? hit : norm(sock && sock.remoteAddress);
  };

  /** The address the limits and Headscale see. @param {import("node:http").IncomingMessage} req */
  function realAddr(req) {
    const peer = peerOf(req.socket);
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

  /** Which public ingress shape a plain request is, or null. Exact match on the raw path; a hook needs a declared body of the right size and type, a share link has none. @param {import("node:http").IncomingMessage} req @returns {"hooks"|"share"|null} */
  function ingressKind(req) {
    if (!o.ingress) return null;
    const url = String(req.url || "");
    if (url.includes("?") || req.headers.upgrade || req.headers["transfer-encoding"] || req.headers.expect) return null;
    const m = req.method, cl = req.headers["content-length"];
    if (HOOK_PATH.test(url) && url.length <= 7 + 40 && m === "POST") {
      const n = /^\d{1,7}$/.test(String(cl)) ? Number(cl) : -1;
      const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      return n >= 0 && n <= INGRESS_BODY_LIMIT && HOOK_TYPES.has(type) ? "hooks" : null;
    }
    if (SHARE_PATH.test(url) && (m === "GET" || m === "HEAD")) return cl === undefined || cl === "0" ? "share" : null;
    const mcp = Object.hasOwn(MCP_SHAPES, url) ? MCP_SHAPES[url] : null;
    if (mcp && m === "POST" && o.ingress[mcp]) {
      const n = /^\d{1,6}$/.test(String(cl)) ? Number(cl) : -1;
      return n >= 0 && n <= VAULTMCP_BODY_LIMIT && String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() === "application/json" ? mcp : null;
    }
    return null;
  }

  /**
   * Is this request for an app module's own host? null when it is not one (it goes on as before); a host (lowercase, no port) when Host is exactly one label under the suffix; "" when it
   * ends with the suffix but is not one valid label or the SNI differs from the Host (answered 404 like an unknown app, never handed to Headscale's paths).
   * @param {import("node:http").IncomingMessage} req @returns {string | null}
   */
  function appsHost(req) {
    const ing = o.ingress;
    if (!ing || !ing.apps) return null;
    const h = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "");
    // An own host (sign.firm.com) is an app host when its certificate is held here; like the others it must be the SNI the visitor sent.
    if (hostCtx.has(h)) {
      const sni = /** @type {any} */ (req.socket).servername;
      return String(sni || "").toLowerCase() === h ? h : "";
    }
    if (!ing.appsSuffix || !h.endsWith(ing.appsSuffix)) return null;
    if (!APP_LABEL.test(h.slice(0, h.length - ing.appsSuffix.length))) return "";
    const sni = /** @type {any} */ (req.socket).servername;
    if (/** @type {any} */ (req.socket).encrypted && String(sni || "").toLowerCase() !== h) return "";
    return h;
  }

  /** Carry one request for an app module's own host to the apps' loopback front. Host is matched against the running apps before any of the request is read. */
  async function apps(/** @type {import("node:http").IncomingMessage} */ req, /** @type {import("node:http").ServerResponse} */ res, /** @type {string} */ host, /** @type {string} */ addr) {
    const sock = req.socket, k = addrKey(addr), t = now();
    const w = (windows.get("a:" + k) || []).filter(x => x > t - L.windowMs);
    if (w.length >= L.appsPerWindow) { stats.limited++; emit({ type: "limit", addr: k, what: "apps" }); refuse(sock, TOO_MANY); return; }
    w.push(t); windows.set("a:" + k, w);
    /** @type {{ port: number, hosts: string[] } | null} */ let cur = null;
    try { cur = /** @type {any} */ (o.ingress).apps ? await /** @type {any} */ (o.ingress).apps() : null; } catch { cur = null; }
    if (!host || !cur || !Number.isInteger(cur.port) || cur.port < 1 || !Array.isArray(cur.hosts) || !cur.hosts.includes(host)) { stats.notFound++; emit({ type: "notfound", addr: k }); refuse(sock, NOT_FOUND); return; }
    const declared = req.headers["content-length"];
    if (declared !== undefined && (!/^\d{1,12}$/.test(String(declared)) || Number(declared) > L.appsBodyBytes)) { refuse(sock, TOO_LARGE); return; }
    sock.setTimeout(L.appsIdleMs);
    /** @type {Record<string, string>} */ const head = {};
    const raw = req.rawHeaders;
    for (let i = 0; i < raw.length; i += 2) {
      const n = raw[i], low = n.toLowerCase();
      if (SPOOF.test(low) || (HOP.test(low) && low !== "host") || (fwd && low === fwd.header)) continue;
      head[n] = head[n] === undefined ? raw[i + 1] : head[n] + ", " + raw[i + 1];
    }
    head["X-Forwarded-For"] = addr; head["X-Real-IP"] = addr; head["X-Forwarded-Proto"] = "https"; head["Connection"] = "close";
    stats.forwarded++;
    const up = http.request({ host: "127.0.0.1", port: cur.port, method: req.method, path: req.url, headers: head, agent: false, timeout: L.appsIdleMs }, ures => {
      const h = { ...ures.headers };
      for (const n of Object.keys(h)) if (HOP.test(n)) delete h[n];
      delete h.date; delete h.server;
      res.writeHead(ures.statusCode || 502, ures.statusMessage, h);
      ures.pipe(res);
      ures.on("error", () => res.destroy());
      res.on("close", () => ures.destroy());
    });
    up.on("timeout", () => up.destroy());
    up.on("error", () => { stats.timeouts++; if (!res.headersSent) refuse(sock, UNAVAILABLE); else sock.destroy(); });
    req.on("aborted", () => up.destroy());
    let n = 0;
    req.on("data", d => { n += d.length; if (n > L.appsBodyBytes) { up.destroy(); refuse(sock, TOO_LARGE); } });
    req.pipe(up);
  }

  /** Carry one ingress request to its loopback listener and the answer back. The head is the client's minus every spoofable and hop-by-hop header, plus the real address. */
  async function ingress(/** @type {import("node:http").IncomingMessage} */ req, /** @type {import("node:http").ServerResponse} */ res, /** @type {"hooks"|"share"|"vaultmcp"|"agentsmcp"} */ kind, /** @type {string} */ addr) {
    const sock = req.socket, k = addrKey(addr), t = now();
    const mcp = kind === "vaultmcp" || kind === "agentsmcp";
    const wk = (kind === "vaultmcp" ? "m:" : kind === "agentsmcp" ? "a:" : "i:") + k;
    const w = (windows.get(wk) || []).filter(x => x > t - L.windowMs);
    if (w.length >= (mcp ? VAULTMCP_PER_WINDOW : INGRESS_PER_WINDOW)) { stats.limited++; emit({ type: "limit", addr: k, what: "ingress" }); req.resume(); refuse(sock, TOO_MANY); return; }
    w.push(t); windows.set(wk, w);
    let port = null;
    try { port = await o.ingress[kind](); } catch { port = null; }
    if (!Number.isInteger(port) || /** @type {number} */ (port) < 1) { stats.notFound++; emit({ type: "notfound", addr: k }); req.resume(); refuse(sock, NOT_FOUND); return; }
    /** @type {Record<string, string>} */ const head = {};
    const raw = req.rawHeaders;
    for (let i = 0; i < raw.length; i += 2) {
      const n = raw[i], low = n.toLowerCase();
      if (SPOOF.test(low) || HOP.test(low) || (fwd && low === fwd.header)) continue;
      head[n] = head[n] === undefined ? raw[i + 1] : head[n] + ", " + raw[i + 1];
    }
    head["X-Forwarded-For"] = addr; head["X-Real-IP"] = addr; head["Connection"] = "close";
    stats.forwarded++;
    const up = http.request({ host: "127.0.0.1", port: /** @type {number} */ (port), method: req.method, path: req.url, headers: head, agent: false, timeout: 20_000 }, ures => {
      const h = { ...ures.headers };
      for (const n of Object.keys(h)) if (HOP.test(n)) delete h[n];
      delete h.date; delete h.server;
      res.writeHead(ures.statusCode || 502, h);
      ures.pipe(res);
      ures.on("error", () => res.destroy());
      res.on("close", () => ures.destroy());
    });
    up.on("timeout", () => up.destroy());
    up.on("error", () => { stats.timeouts++; if (!res.headersSent) refuse(sock, UNAVAILABLE); else sock.destroy(); });
    req.on("aborted", () => up.destroy());
    if (kind === "hooks" || mcp) req.pipe(up); else up.end();
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

  /** The certificates of own hosts the person pointed here, by host (lower case): picked by the SNI of the handshake, the Space's own certificate for every other name. @type {Map<string, import("node:tls").SecureContext>} */
  const hostCtx = new Map();
  /** @type {import("node:http").Server} */
  const server = o.tls
    ? https.createServer({ cert: o.tls.cert, key: o.tls.key, SNICallback: (/** @type {string} */ name, /** @type {Function} */ cb) => cb(null, hostCtx.get(String(name || "").toLowerCase()) || undefined), minVersion: "TLSv1.2", ALPNProtocols: ["http/1.1"], handshakeTimeout: L.handshakeMs, maxHeaderSize: L.maxHeaderBytes })
    : http.createServer({ maxHeaderSize: L.maxHeaderBytes });
  server.headersTimeout = L.headersMs;
  // With app hosts an upload may take minutes: the request timer is longer and the plain paths get their short one back per request (below).
  server.requestTimeout = o.ingress && o.ingress.apps ? L.appsRequestMs : L.requestMs;
  server.keepAliveTimeout = 1000;
  // The HTTP server never listens (the front below does); its connection tracking, which enforces the header and request timers, starts on this event.
  server.emit("listening");

  // The listening socket is a plain TCP server in front of the HTTP(S) one, so a trusted peer's PROXY header is read and taken off before any TLS or HTTP byte is parsed.
  const front = net.createServer(sock => {
    if (!inList(norm(sock.remoteAddress), proxyTrust)) { server.emit("connection", sock); return; }
    // Until the header names a visitor the connection is counted under the loopback address it came from, so a peer that sends nothing still spends its own share.
    const pre = addrKey(norm(sock.remoteAddress));
    if (bump(conns, pre, 1) > L.maxConnsPerAddr) { stats.limited++; bump(conns, pre, -1); sock.destroy(); emit({ type: "limit", addr: pre, what: "connections" }); return; }
    let counted = true;
    const release = () => { if (counted) { counted = false; bump(conns, pre, -1); } };
    sock.once("close", release);
    /** @type {Buffer} */ let got = Buffer.alloc(0);
    const timer = setTimeout(() => { stats.timeouts++; sock.destroy(); }, L.handshakeMs);
    timer.unref();
    const pump = () => {
      for (let c; (c = sock.read()) !== null;) {
        got = Buffer.concat([got, c]);
        const h = decodeProxyV2(got);
        if (h.state === "more" && got.length < PROXY_V2_MAX) continue;
        sock.removeListener("readable", pump); clearTimeout(timer);
        if (h.state === "bad" || h.state === "more") { stats.notFound++; sock.destroy(); return; }
        const rest = h.state === "ok" ? got.subarray(h.length) : got;
        if (h.state === "ok" && h.addr !== null) named.set(sock, norm(h.addr));
        if (rest.length) sock.unshift(rest);
        release();
        server.emit("connection", sock);
        if (!o.tls) sock.resume();
        return;
      }
    };
    sock.on("error", () => { clearTimeout(timer); });
    sock.on("readable", pump);
    sock.once("close", () => clearTimeout(timer));
  });
  front.maxConnections = L.maxConns;

  server.on("connection", raw => {
    stats.accepted++;
    const a = peerOf(raw), k = addrKey(a);
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
    const ah = appsHost(req);
    if (ah !== null) { apps(req, res, ah, addr).catch(() => { try { sock.destroy(); } catch { /* gone */ } }); return; }
    if (o.ingress && o.ingress.apps) { const rt = setTimeout(() => { try { sock.destroy(); } catch { /* gone */ } }, L.requestMs); rt.unref(); res.on("close", () => clearTimeout(rt)); }
    const ing = kind ? null : ingressKind(req);
    if (ing) { ingress(req, res, ing, addr).catch(() => { try { sock.destroy(); } catch { /* gone */ } }); return; }
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
  /**
   * A WebSocket on an app host (a published server's live dashboard, a chat widget): the same checks as a request, the same budgets per address (counted apart from Headscale's own upgrades, so a busy app
   * cannot starve the control channel), and then bytes both ways to the apps' loopback front, which does the rest (its own cookies only, never Vyre's session). The head is the visitor's minus every
   * spoofable header, plus the real address.
   * @param {import("node:http").IncomingMessage} req @param {import("node:stream").Duplex} socket @param {Buffer} head @param {string} host @param {string} addr
   */
  async function appsUpgrade(req, socket, head, host, addr) {
    const k = addrKey(addr), wk = "w:" + k, t = now();
    const no = () => { stats.notFound++; emit({ type: "notfound", addr: k }); refuse(/** @type {any} */ (socket), NOT_FOUND); };
    if (!host || req.method !== "GET" || String(req.headers.upgrade || "").toLowerCase() !== "websocket") return no();
    const w = (windows.get(wk) || []).filter(x => x > t - L.windowMs);
    const live = bump(ups, wk, 1);
    if (w.length >= L.appsUpgradesPerWindow || live > L.appsConcurrentUpgrades) { bump(ups, wk, -1); stats.limited++; emit({ type: "limit", addr: k, what: "apps-upgrade" }); refuse(/** @type {any} */ (socket), TOO_MANY); return; }
    w.push(t); windows.set(wk, w);
    /** @type {{ port: number, hosts: string[] } | null} */ let cur = null;
    try { cur = o.ingress && o.ingress.apps ? await o.ingress.apps() : null; } catch { cur = null; }
    if (!cur || !Number.isInteger(cur.port) || cur.port < 1 || !Array.isArray(cur.hosts) || !cur.hosts.includes(host)) { bump(ups, wk, -1); return no(); }
    let done = false;
    const upc = net.connect({ host: "127.0.0.1", port: cur.port });
    const finish = () => { if (done) return; done = true; bump(ups, wk, -1); try { socket.destroy(); } catch { /* gone */ } upc.destroy(); };
    upc.on("error", () => { if (!done && !socket.destroyed) { try { socket.write(UNAVAILABLE); } catch { /* gone */ } } finish(); });
    upc.on("close", finish); socket.on("close", finish);
    upc.on("connect", () => {
      if (done) return;
      /** @type {string[]} */ const lines = [`${req.method} ${req.url} HTTP/1.1`];
      const raw = req.rawHeaders;
      for (let i = 0; i + 1 < raw.length; i += 2) { const low = raw[i].toLowerCase(); if (SPOOF.test(low) || (fwd && low === fwd.header)) continue; lines.push(`${raw[i]}: ${raw[i + 1]}`); }
      lines.push(`X-Forwarded-For: ${addr}`, `X-Real-IP: ${addr}`, "X-Forwarded-Proto: https");
      upc.write(lines.join("\r\n") + "\r\n\r\n");
      if (head && head.length) upc.write(head);
      socket.setTimeout(L.upgradedIdleMs, () => { stats.timeouts++; finish(); });
      upc.setTimeout(L.upgradedIdleMs, () => finish());
      socket.pipe(upc); upc.pipe(/** @type {any} */ (socket));
      stats.forwarded++;
    });
  }

  server.on("upgrade", (req, socket, head) => {
    const addr = realAddr(req), k = addrKey(addr);
    socket.on("error", () => { /* a reset is not news */ });
    if (isBlocked(addr)) { stats.blocked++; socket.destroy(); return; }
    const ah = appsHost(req);
    if (ah !== null) { appsUpgrade(req, socket, head, ah, addr).catch(() => { try { socket.destroy(); } catch { /* gone */ } }); return; }
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
    /** Serve an own host with its own certificate (a new or renewed one replaces the last). @param {string} host @param {{ cert: string, key: string }} t */
    setHostTls(host, t) {
      if (!o.tls) throw new Error("this gate does not serve TLS");
      hostCtx.set(String(host).toLowerCase(), tls.createSecureContext({ cert: t.cert, key: t.key }));
    },
    /** Stop serving an own host: its next handshake gets the Space's certificate and its requests the plain 404. @param {string} host */
    dropHostTls(host) { hostCtx.delete(String(host).toLowerCase()); },
    hosts: () => [...hostCtx.keys()],
    stats: () => ({ ...stats, open: open.size, blockedAddrs: blocked.size }),
    block, isBlocked, reportLog,
    unblock(/** @type {string} */ addr) { blocked.delete(addrKey(addr)); },
    listen() {
      const l = o.listen || {};
      return new Promise((resolve, reject) => {
        front.once("error", reject);
        front.listen(l.port || 0, l.host || "127.0.0.1", () => {
          const a = /** @type {net.AddressInfo} */ (front.address());
          resolve({ host: a.address, port: a.port });
        });
      });
    },
    address() { const a = /** @type {net.AddressInfo|null} */ (front.address()); return a ? { host: a.address, port: a.port } : null; },
    close() {
      return new Promise(resolve => {
        front.close(() => resolve(undefined));
        server.close(() => {}); // never listened itself: this ends its connection tracking
        for (const s of open) s.destroy();
      });
    },
  };
}
