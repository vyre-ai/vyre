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
// A route is { prefix: "/provider", upstream: "https://api.anthropic.com", credential?: { ref, header, prefix? } }.
// vault.credential({ ref, session, route }) returns the secret as a string, or throws.

import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";

/** Headers the proxy owns: the session's token and the real credential never pass through from the client. */
const STRIP_IN = new Set(["host", "connection", "proxy-connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization", "x-vyre-token"]);
const MAX_BODY = 64 * 1024 * 1024;

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/**
 * @param {{ routes: { prefix: string, upstream: string, credential?: { ref: string, header: string, prefix?: string } }[],
 *   vault: { credential(o: { ref: string, session: string, route: string }): Promise<string> },
 *   session: string, token: string, onEvent?: (e: { route: string, status: number, ms: number, error?: string }) => void,
 *   request?: typeof http.request }} o
 */
export function createEgress(o) {
  const routes = o.routes.map(r => ({ ...r, url: new URL(r.upstream) }));
  for (const r of routes) {
    if (!/^\/[a-z0-9-]+$/.test(r.prefix)) throw new Error("a route prefix is one lowercase segment");
    if (r.url.protocol !== "https:" && !isLoopback(r.url.hostname)) throw new Error("an upstream must be https");
  }
  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    const refuse = (code, why, route = "-") => { if (!res.headersSent) { res.writeHead(code, { "content-type": "text/plain" }); } res.end(why + "\n"); o.onEvent?.({ route, status: code, ms: Date.now() - t0, error: why }); };
    try {
      if (req.method === "CONNECT" || !req.url || !req.url.startsWith("/")) return refuse(403, "only the granted routes are reachable");
      const u = new URL(req.url, "http://proxy");
      const route = routes.find(r => u.pathname === r.prefix || u.pathname.startsWith(r.prefix + "/"));
      if (!route) return refuse(403, "that address is not one this space allows");
      const presented = firstToken(req.headers);
      if (!presented || !same(presented, o.token)) return refuse(401, "unknown session");
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const key = k.toLowerCase();
        if (STRIP_IN.has(key) || key === "x-api-key" || key === "authorization" || (route.credential && key === route.credential.header.toLowerCase())) continue;
        headers[k] = v;
      }
      if (route.credential) {
        let secret;
        try { secret = await o.vault.credential({ ref: route.credential.ref, session: o.session, route: route.prefix }); } catch { return refuse(502, "the space's vault did not give the credential", route.prefix); }
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
        ur.on("end", () => o.onEvent?.({ route: route.prefix, status: ur.statusCode || 0, ms: Date.now() - t0 }));
      });
      up.on("error", () => refuse(502, "the upstream did not answer", route.prefix));
      res.on("close", () => up.destroy());
      req.pipe(up);
    } catch (e) { refuse(500, "the proxy failed"); }
  });
  server.on("connect", (_req, sock) => { sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); });
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
