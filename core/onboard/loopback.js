// @ts-check
// The onboarding listener: plain HTTP on 127.0.0.1, before the box has an owner (ADR 0002).
//
// Anyone on the box can reach a loopback port, so no tool answers without either the one-time
// token from `vyre up` or the session it was exchanged for. The token is kept only as a hash,
// works once, and expires after an hour. The session is not a cookie: browsers share cookies
// across every port of 127.0.0.1, so any other local web server the person visits would get it.
// It travels in the redirect's fragment (never sent to a server), the page keeps it in memory
// and sends it as the x-vyre-onboard header, or as ?s= on the event stream, which cannot set
// headers. The page's own files carry nothing secret and are served to anyone on loopback. The
// listener closes for good once the owner has been seen on the tailnet.

import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";

const HOUR = 3_600_000;
const SESSION = 12 * HOUR;
const HEADER = "x-vyre-onboard";
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");

/** The tools the onboarding page may call. onboard.link is not one: only the socket mints links. */
export const TOOLS = new Set(["onboard.status", "onboard.name", "onboard.claude", "onboard.tailscale", "onboard.history",
  "onboard.skip", "onboard.finish", "projects.catalog", "projects.create", "recall.status"]);

const onboardPath = p => p === "/onboard" || p.startsWith("/onboard/");
const TAILNET4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

/**
 * Where the listener binds. On a host, 127.0.0.1. In the box's container the port is published
 * from the host's loopback by Docker, which forwards to the container's own network address,
 * never to its 127.0.0.1; so there it binds that address (not 0.0.0.0, which would include the
 * tailnet interface), and the person still reaches it as 127.0.0.1 through `ssh -L`.
 */
export function bindAddress(mode = process.env.VYRE_ONBOARD_HOST, ifaces = os.networkInterfaces()) {
  if (mode !== "container") return "127.0.0.1";
  for (const [name, list] of Object.entries(ifaces)) {
    if (name === "lo" || name.startsWith("tailscale")) continue;
    for (const a of list || []) if (a.family === "IPv4" && !a.internal && !TAILNET4.test(a.address)) return a.address;
  }
  throw new Error("no container network address to bind the onboarding listener to");
}

/**
 * @param {{ handler: (policy: any) => (req: any, res: any, caller: string) => Promise<void>, port?: number, now?: () => number, log?: (m: string) => void, host?: string }} deps
 */
export function loopback({ handler, port: wanted = 7300, now = Date.now, log = () => {}, host = bindAddress() }) {
  /** @type {http.Server | null} */
  let server = null;
  let port = 0;
  /** @type {{ hash: string, expires: number } | null} */
  let token = null;
  /** @type {Map<string, number>} session hash -> expiry */
  const sessions = new Map();
  const handle = handler({
    tool: n => TOOLS.has(n),
    path: (m, p) => (m === "GET" && onboardPath(p)) || (m === "POST" && p.startsWith("/v1/tools/")) || (m === "GET" && p === "/v1/events/stream"),
    eventType: "onboard.*",
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });

  const text = (res, status, body, headers = {}) => { res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers }); res.end(body + "\n"); };
  const json = (res, status, code, message) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code, message } })); };
  const loopbackHost = h => h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;

  function session(req, url) {
    const sid = String(req.headers[HEADER] || url.searchParams.get("s") || "");
    if (!sid) return false;
    const h = sha(sid), exp = sessions.get(h);
    if (!exp || exp < now()) { sessions.delete(h); return false; }
    sessions.set(h, now() + SESSION);
    return true;
  }

  async function onRequest(req, res) {
    // A page on another site can point its own name at 127.0.0.1 (DNS rebinding); its Host
    // header is still its own name, so only loopback names are answered.
    if (!loopbackHost(String(req.headers.host || ""))) return text(res, 421, "Not here.");
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/onboard" && url.searchParams.has("t")) {
      const t = url.searchParams.get("t") || "";
      if (!token || token.expires < now() || sha(t) !== token.hash) {
        return text(res, 403, "This onboarding link has already been used or has expired. Run `vyre up` on the box for a new one.");
      }
      token = null;
      const sid = crypto.randomBytes(32).toString("base64url");
      sessions.set(sha(sid), now() + SESSION);
      res.writeHead(302, { location: `/onboard#s=${sid}`, "cache-control": "no-store" });
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/") { res.writeHead(302, { location: "/onboard" }); return res.end(); }
    if (req.method === "GET" && onboardPath(url.pathname)) return handle(req, res, "onboard");
    if (!session(req, url)) return json(res, 403, "denied", "Open the link `vyre up` printed on the box.");
    if (req.method === "POST") {
      // Same-origin fetches send JSON and a loopback Origin; a form from another page cannot.
      if (!/^application\/json\b/.test(String(req.headers["content-type"] || ""))) return json(res, 415, "bad_input", "send JSON");
      const origin = req.headers.origin;
      if (origin && !loopbackHost(origin.replace(/^http:\/\//, ""))) return json(res, 403, "denied", "cross-origin request");
    }
    return handle(req, res, "onboard");
  }

  function listen(p) {
    return new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => { onRequest(req, res).catch(e => json(res, 500, "internal", e.message)); });
      s.once("error", reject);
      s.listen(p, host, () => { s.off("error", reject); resolve(s); });
    });
  }

  return {
    /** Open the listener (if needed) and mint a fresh token, voiding any unredeemed one. */
    async link() {
      if (!server) {
        // In a container the published port is fixed, so there is no next free one to try.
        const tries = host === "127.0.0.1" ? 20 : 1;
        for (let p = wanted; p < wanted + tries && !server; p++) {
          if (p === 0) { server = /** @type {http.Server} */ (await listen(0)); break; }
          try { server = /** @type {http.Server} */ (await listen(p)); }
          catch (e) { if (/** @type {any} */ (e).code !== "EADDRINUSE") throw e; }
        }
        if (!server && tries === 1) throw new Error(`port ${wanted} is taken inside the container`);
        if (!server) server = /** @type {http.Server} */ (await listen(0));
        port = /** @type {any} */ (server.address()).port;
        log(`onboard: listening on ${host}:${port}`);
      }
      const t = crypto.randomBytes(32).toString("base64url");
      token = { hash: sha(t), expires: now() + HOUR };
      return { url: `http://127.0.0.1:${port}/onboard?t=${t}`, port, expires: token.expires };
    },
    async close() {
      token = null;
      sessions.clear();
      if (!server) return;
      const s = server; server = null;
      s.closeAllConnections();
      await new Promise(r => s.close(() => r(undefined)));
      log("onboard: loopback closed");
    },
    open: () => Boolean(server),
    port: () => port,
  };
}
