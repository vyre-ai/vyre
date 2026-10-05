// @ts-check
// The runner's egress proxy: credentials at the point of use (DESIGN-local-runner section 5).
//
// The sandboxed session cannot reach any network but this proxy. It speaks plain HTTP to the proxy (the base URL
// the sandbox gives it), and the proxy makes the real TLS request to the one upstream a route names. For each
// request it asks the space's vault for the credential, puts it in the outgoing header, and forwards. So:
//   - the secret is never in the session's environment, files or prompt: the "key" the session holds is a
//     per-session token that only works against this proxy and is worthless anywhere else;
//   - nothing is cached or written: the vault is asked once per request and the value lives in one header;
//   - only the routes the space granted exist; any other path, host or method gets a plain refusal.
//
// A route is { prefix: "/provider", upstream: "https://models.example", credential?: { header, prefix? }, headers?: { name: value }, allow: [{ method, path }] }.
// A route with a credential MUST list what the session may do with it: each entry names a method and a path ("/v1/messages",
// or "/v1/files/*" for a prefix). Anything else is refused here, before the vault is asked (reviewer-2 R4: a read-only grant must
// never become a refund or a delete). The vault is then asked per request with the method and path, and it classifies them the
// way the kernel does: a read is allowed, anything that changes state is an outward act held for approval (kernel/seal/uses.js
// leasedUse). vault.credential({ session, route, lease, method, path }) (the Space maps the request to a credential; the runner never names one) returns the secret as a string, or throws.

import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import net from "node:net";
import { resolvePublic, isPublicAddress } from "./netguard.js";
import fs from "node:fs";

/** Headers the proxy owns: the session's token and the real credential never pass through from the client. */
const STRIP_IN = new Set(["host", "connection", "proxy-connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization", "x-vyre-token"]);
export const MAX_TUNNELS = 16, TUNNEL_IDLE_MS = 120_000;
const MAX_BODY = 64 * 1024 * 1024;

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/**
 * @param {{ routes: { prefix: string, upstream: string, credential?: { header: string, prefix?: string }, headers?: Record<string, string>, allow?: { method: string, path: string }[] }[],
 *   vault: { credential(o: { session: string, route: string, lease?: string, method: string, path: string }): Promise<string> },
 *   session: string, token: string, connect?: string[], internet?: boolean, lookup?: any, dial?: (ip: string, port: number) => any, lease?: () => string, onEvent?: (e: { route: string, status: number, ms: number, error?: string }) => void,
 *   request?: typeof http.request }} o
 */
export function createEgress(o) {
  const routes = o.routes.map(r => ({ ...r, url: new URL(r.upstream) }));
  for (const r of routes) {
    if (!/^\/[a-z0-9-]+$/.test(r.prefix)) throw new Error("a route prefix is one lowercase segment");
    if (r.credential && !(Array.isArray(r.allow) && r.allow.length && r.allow.every(a => /^[A-Z]+$/.test(a.method) && /^\/[^\s]*$/.test(a.path)))) throw new Error("a route with a credential must list its allowed methods and paths");
    if (r.url.protocol !== "https:" && !isLoopback(r.url.hostname)) throw new Error("an upstream must be https");
    // static headers the Space adds to every request on this route (for a provider's sign-in token: the beta flag that makes it valid); names and values are plain, never a credential
    if (r.headers !== undefined && !(r.headers && typeof r.headers === "object" && Object.entries(r.headers).every(([k, v]) => /^[a-z][a-z0-9-]{0,40}$/.test(k) && !["authorization", "x-api-key", "host", "content-length"].includes(k) && typeof v === "string" && /^[\x20-\x7e]{1,200}$/.test(v)))) throw new Error("a route's own headers are lowercase names with plain values");
  }
  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    const refuse = (code, why, route = "-") => { if (!res.headersSent) { res.writeHead(code, { "content-type": "text/plain" }); } res.end(why + "\n"); o.onEvent?.({ route, status: code, ms: Date.now() - t0, error: why }); };
    try {
      // Internet mode, plain HTTP: a proxy request carries an absolute URL (pip's index, apt, a git http remote). Same rules as CONNECT.
      if (o.internet && req.url && /^http:\/\//i.test(req.url) && req.method !== "CONNECT") {
        const pm = /^Basic\s+(.+)$/i.exec(String(req.headers["proxy-authorization"] || ""));
        const ppass = pm ? Buffer.from(pm[1], "base64").toString().split(":").slice(1).join(":") : "";
        if (!same(ppass, o.token)) { res.writeHead(407, { "proxy-authenticate": 'Basic realm="vyre"' }); return res.end("unknown session\n"); }
        const pu = new URL(req.url); const pport = Number(pu.port || 80);
        if (pport === 25) return refuse(403, "not allowed");
        let ip; try { ip = await resolvePublic(pu.hostname.replace(/^\[|\]$/g, ""), { lookup: o.lookup }); } catch { return refuse(403, "that address is not public"); }
        const hdrs = {}; for (const [k, v] of Object.entries(req.headers)) if (!STRIP_IN.has(k.toLowerCase())) hdrs[k] = v;
        hdrs.host = pu.host;
        const up2 = http.request({ hostname: ip, port: pport, method: req.method, path: pu.pathname + pu.search, headers: hdrs });
        up2.on("socket", s => s.once("connect", () => { if (!o.dial && !isPublicAddress(String(s.remoteAddress))) s.destroy(); }));
        up2.on("response", ur => { res.writeHead(ur.statusCode || 502, Object.fromEntries(Object.entries(ur.headers).filter(([k]) => !STRIP_IN.has(k)))); ur.pipe(res); });
        up2.on("error", () => refuse(502, "the host did not answer"));
        res.on("close", () => up2.destroy()); req.pipe(up2);
        return;
      }
      if (req.method === "CONNECT" || !req.url || !req.url.startsWith("/")) return refuse(403, "only the granted routes are reachable");
      const u = new URL(req.url, "http://proxy");
      const route = routes.find(r => u.pathname === r.prefix || u.pathname.startsWith(r.prefix + "/"));
      if (!route) return refuse(403, "that address is not one this space allows");
      if (/%2e|%2f|%5c|%00/i.test(u.pathname)) return refuse(400, "that path is not allowed", route.prefix);
      const rest0 = u.pathname.slice(route.prefix.length) || "/";
      const presented = firstToken(req.headers);
      if (!presented || !same(presented, o.token)) return refuse(401, "unknown session");
      if (route.credential && !route.allow.some(a => a.method === req.method && (a.path.endsWith("*") ? rest0.startsWith(a.path.slice(0, -1)) : rest0 === a.path))) return refuse(403, "this space does not allow that request with this credential", route.prefix);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const key = k.toLowerCase();
        if (STRIP_IN.has(key) || key === "x-api-key" || key === "authorization" || (route.credential && key === route.credential.header.toLowerCase())) continue;
        headers[k] = v;
      }
      // The Space's static headers win over the session's, except a comma list the session also sends (anthropic-beta): the Space's flags are added to the program's own, never in place of them.
      if (route.headers) for (const [k, v] of Object.entries(route.headers)) {
        const had = Object.keys(headers).find(h => h.toLowerCase() === k);
        if (had && k === "anthropic-beta") { const set = new Set(String(headers[had]).split(",").map(x => x.trim()).filter(Boolean)); for (const f of v.split(",")) set.add(f.trim()); headers[had] = [...set].join(","); }
        else { if (had) delete headers[had]; headers[k] = v; }
      }
      if (route.credential) {
        let secret;
        try { secret = await o.vault.credential({ session: o.session, route: route.prefix, lease: o.lease?.(), method: req.method, path: rest0 }); } catch { return refuse(502, "the space's vault did not give the credential", route.prefix); }
        if (typeof secret !== "string" || !secret) return refuse(502, "the space's vault did not give the credential", route.prefix);
        headers[route.credential.header] = (route.credential.prefix || "") + secret;
        secret = "";
      }
      const rest = u.pathname.slice(route.prefix.length) || "/";
      const mod = route.url.protocol === "https:" ? https : http;
      const basePath = route.url.pathname.replace(/\/$/, "");
      const up = (o.request ? o.request : mod.request)({ hostname: route.url.hostname, port: route.url.port || undefined, protocol: route.url.protocol, method: req.method, path: basePath + rest + u.search, headers: { ...headers, host: route.url.host } });
      let size = 0;
      req.on("data", c => { size += c.length; if (size > MAX_BODY) { up.destroy(); req.destroy(); } });
      up.on("response", ur => {
        const out = {};
        for (const [k, v] of Object.entries(ur.headers)) if (!STRIP_IN.has(k)) out[k] = v;
        res.writeHead(ur.statusCode || 502, out);
        ur.pipe(res);
        // a development build says why the upstream refused (its own error text, never a credential): the first 160 bytes of a 4xx body
        let why = ""; if (process.env.VYRE_DEBUG_LENT && (ur.statusCode || 0) >= 400) ur.on("data", c => { if (why.length < 160) why += String(c).slice(0, 160 - why.length).replace(/\s+/g, " "); });
        ur.on("end", () => o.onEvent?.({ route: route.prefix, method: req.method, path: rest0, status: ur.statusCode || 0, ms: Date.now() - t0, ...(why ? { error: why } : {}) }));
      });
      up.on("error", () => refuse(502, "the upstream did not answer", route.prefix));
      res.on("close", () => up.destroy());
      req.pipe(up);
    } catch (e) { refuse(500, "the proxy failed"); }
  });
  // CONNECT is refused, except for a person's own session whose provider agent speaks HTTPS itself: then exactly the hosts listed in
  // `connect` ("host:443") are tunnelled (no TLS termination, no credential injected), and the proxy token is required as the proxy password.
  let tunnels = 0;
  const tunnel = new Set((o.connect || []).map(h => String(h).toLowerCase()));
  server.on("connect", (req, sock, head) => {
    const deny = () => sock.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    sock.on("error", () => {});
    const m = /^Basic\s+(.+)$/i.exec(String(req.headers["proxy-authorization"] || ""));
    const pass = m ? Buffer.from(m[1], "base64").toString().split(":").slice(1).join(":") : "";
    const target = String(req.url || "").toLowerCase();
    const [host, port] = [target.slice(0, target.lastIndexOf(":")), Number(target.slice(target.lastIndexOf(":") + 1))];
    // Clients such as libcurl (git, npm) send the proxy password only after a 407: ask for it.
    if (!same(pass, o.token)) return sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="vyre"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    if (!(port > 0 && port < 65536)) return deny();
    if (!o.internet && !tunnel.has(target)) return deny();
    if (o.internet && (port === 25 || port === 465 || port === 587)) return deny();   // no mail relay
    if (tunnels >= MAX_TUNNELS) return deny();
    tunnels++;
    let done = false; const end = () => { if (!done) { done = true; tunnels--; } };
    sock.on("close", end);
    // Internet mode: resolve the name HERE, refuse anything that is not a public address, and connect to the address that was checked.
    const opened = o.internet ? resolvePublic(host.replace(/^\[|\]$/g, ""), { lookup: o.lookup }).then(ip => (o.dial ? o.dial(ip, port) : net.connect(port, ip))) : Promise.resolve(net.connect(port, host));
    opened.then(up => {
      up.once("connect", () => {
        // Re-test the address the socket actually connected to (internet mode): what was checked is what is connected.
        if (o.internet && !o.dial && !isPublicAddress(String(up.remoteAddress))) { up.destroy(); sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
        sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head && head.length) up.write(head); up.pipe(sock); sock.pipe(up); });
      // An allowed host cannot be used to hold sockets open for ever: idle tunnels are closed, and there is a cap per session.
      sock.setTimeout(TUNNEL_IDLE_MS, () => sock.destroy()); up.setTimeout(TUNNEL_IDLE_MS, () => up.destroy());
      let bin = 0, bout = 0; up.on("data", d => { bin += d.length; }); sock.on("data", d => { bout += d.length; });
      // The destination and the byte counts per tunnel, never contents.
      const logged = () => { if (!logged.done) { logged.done = true; o.onEvent?.({ route: "tunnel", host, port, bytesIn: bin, bytesOut: bout, status: 200, ms: 0 }); } };
      up.on("error", () => sock.destroy()); sock.on("close", () => { logged(); up.destroy(); }); up.on("close", () => { logged(); end(); sock.destroy(); });
    }, () => { end(); deny(); });
  });
  return {
    /** Listen on a loopback port (macOS) or a unix socket (Linux). @param {{ socket?: string }} [where] */
    listen(where = {}) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        if (where.socket) {
          try { fs.unlinkSync(where.socket); } catch {}
          server.listen(where.socket, () => { fs.chmodSync(/** @type {string} */ (where.socket), 0o600); resolve({ socket: where.socket }); });
        } else server.listen(0, "127.0.0.1", () => resolve({ port: /** @type {any} */ (server.address()).port }));
      });
    },
    close() { return new Promise(r => { server.closeAllConnections?.(); server.close(() => r(undefined)); }); },
  };
}

const isLoopback = h => h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";

/** The token can ride in x-api-key (Anthropic style), Authorization: Bearer, or x-vyre-token. */
function firstToken(h) {
  const a = h["x-api-key"], b = h["authorization"], c = h["x-vyre-token"];
  if (typeof a === "string") return a;
  if (typeof b === "string") return b.replace(/^Bearer\s+/i, "");
  if (typeof c === "string") return c;
  return "";
}
