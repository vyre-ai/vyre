// @ts-check
// The onboarding listener: plain HTTP on 127.0.0.1, before the box has an owner (ADR 0002).
//
// Anyone on the box can reach a loopback port, so no tool answers without either the one-time
// token from `vyre up` or the session it was exchanged for. The token is kept only as a hash,
// works once, and expires after an hour. The session is not a cookie: browsers share cookies
// across every port of 127.0.0.1, so any other local web server the person visits would get it.
// It travels in the redirect's fragment (never sent to a server), the page keeps it in memory
// and sends it as the x-vyre-onboard header, or as ?s= on the event stream, which cannot set
// headers. The page's own files, and the Deck's shared css, js and vendor files it loads, carry
// nothing secret and are served to anyone on loopback. The listener closes for good once the
// owner has been seen on the tailnet.
//
// The token's hash and the live sessions' hashes survive a restart of vyred (`keep`), because
// `vyre update` restarts it: the link the user was sent, or the page they have open, must still
// work afterwards. Only hashes are kept, as in memory.

import crypto from "node:crypto";
import http from "node:http";

const HOUR = 3_600_000;
const SESSION = 12 * HOUR;
const HEADER = "x-vyre-onboard";
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");

/** The tools the onboarding page may call. onboard.link is not one: only the socket mints links. */
export const TOOLS = new Set(["onboard.status", "onboard.you", "onboard.name", "onboard.claude", "onboard.tailscale", "onboard.history",
  "onboard.skip", "onboard.finish", "onboard.passkey", "projects.catalog", "projects.create", "projects.list", "recall.status"]);

const onboardPath = p => p === "/onboard" || p.startsWith("/onboard/");
/** The Deck's shared files the onboarding page loads, theme and fonts included: static, the same for everyone. */
const assetPath = p => /^\/(css|js|vendor|fonts)\/[\w./-]+$/.test(p) && !p.includes("..") || p === "/icon.svg" || p === "/theme.css";
const TAILNET4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

/**
 * Where the listener binds. On a host, 127.0.0.1. In the box's container the port is published
 * from the host's loopback by Docker, which forwards to the container's address on the `vyre`
 * network, never to its 127.0.0.1. So there VYRE_ONBOARD_HOST names that address by the
 * container's alias on the network (`vyred`), not 0.0.0.0, which would include the tailnet
 * interface; the person still reaches it as 127.0.0.1 through `ssh -L`.
 */
export function bindAddress(env = process.env) {
  return env.VYRE_ONBOARD_HOST || "127.0.0.1";
}

/**
 * @param {{ handler: (policy: any) => (req: any, res: any, caller: string) => Promise<void>, port?: number, now?: () => number, log?: (m: string) => void, host?: string, keep?: { load: () => any, save: (s: any) => void } }} deps
 */
export function loopback({ handler, port: wanted = 7300, now = Date.now, log = () => {}, host = bindAddress(), keep = { load: () => null, save: () => {} } }) {
  /** @type {http.Server | null} */
  let server = null;
  let port = 0;
  /** @type {{ hash: string, expires: number } | null} */
  let token = null;
  /** @type {Map<string, number>} session hash -> expiry */
  const sessions = new Map();
  // What the last vyred left: an unredeemed token and open sessions, if they have not expired.
  let keptPort = 0;
  try {
    const k = keep.load();
    if (k && k.token && k.token.expires > now()) { token = { hash: String(k.token.hash), expires: Number(k.token.expires) }; keptPort = Number(k.port) || 0; }
    for (const [h, exp] of (k && Array.isArray(k.sessions) ? k.sessions : [])) if (exp > now()) sessions.set(String(h), Number(exp));
  } catch { /* nothing kept is the ordinary case */ }
  const persist = () => {
    try { keep.save(token || sessions.size ? { token, port, sessions: [...sessions] } : null); }
    catch (e) { log(`onboard: could not keep the link across a restart: ${/** @type {Error} */ (e).message}`); }
  };
  const handle = handler({
    tool: n => TOOLS.has(n),
    path: (m, p) => (m === "GET" && (onboardPath(p) || assetPath(p))) || (m === "POST" && p.startsWith("/v1/tools/")) || (m === "GET" && p === "/v1/events/stream"),
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
      persist();
      res.writeHead(302, { location: `/onboard#s=${sid}`, "cache-control": "no-store" });
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/") { res.writeHead(302, { location: "/onboard" }); return res.end(); }
    if (req.method === "GET" && (onboardPath(url.pathname) || assetPath(url.pathname))) return handle(req, res, "onboard");
    if (!session(req, url)) return json(res, 403, "denied", "Open the link `vyre up` printed on the box.");
    if (req.method === "POST") {
      // Same-origin fetches send JSON and a loopback Origin; a form from another page cannot.
      if (!/^application\/json\b/.test(String(req.headers["content-type"] || ""))) return json(res, 415, "bad_input", "send JSON");
      const origin = req.headers.origin;
      if (origin && !loopbackHost(origin.replace(/^http:\/\//, ""))) return json(res, 403, "denied", "cross-origin request");
    }
    return handle(req, res, "onboard");
  }

  // A WebSocket gets the same Host rule as a request (DNS rebinding), then a session. The
  // onboarding page opens no streams, so past both it is still refused: the terminal and Glass
  // are the owner's over the tailnet, never the onboarding link's.
  function onUpgrade(req, socket) {
    socket.on("error", () => {});
    const end = (status, text) => { try { socket.end(`HTTP/1.1 ${status} ${text}\r\nconnection: close\r\n\r\n`); } catch {} };
    if (!loopbackHost(String(req.headers.host || ""))) return end(421, "Misdirected Request");
    if (!session(req, new URL(req.url || "/", "http://127.0.0.1"))) return end(403, "Forbidden");
    end(404, "Not Found");
  }

  function listen(p) {
    return new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => { onRequest(req, res).catch(e => json(res, 500, "internal", e.message)); });
      s.on("upgrade", onUpgrade);
      s.once("error", reject);
      s.listen(p, host, () => {
        s.off("error", reject);
        // A name that resolved to the tailnet would open onboarding to every device on it.
        const a = /** @type {any} */ (s.address()).address;
        if (TAILNET4.test(a) || /^fd7a:115c:a1e0:/i.test(a)) { s.close(); return reject(new Error(`${host} is a tailnet address (${a}); onboarding stays off the tailnet`)); }
        resolve(s);
      });
    });
  }

  return {
    /** Open the listener (if needed) and mint a fresh token, voiding any unredeemed one. */
    async link() {
      await ensure();
      const t = crypto.randomBytes(32).toString("base64url");
      token = { hash: sha(t), expires: now() + HOUR };
      persist();
      return { url: `http://127.0.0.1:${port}/onboard?t=${t}`, port, expires: token.expires };
    },
    /**
     * After a restart: reopen the listener when the last vyred left a link or a session that is
     * still good. A link names its port, so one kept for another port is dropped. True when open.
     */
    async resume() {
      if (!token && !sessions.size) return false;
      await ensure();
      if (token && keptPort && keptPort !== port) { token = null; persist(); }
      log(`onboard: kept ${token ? "the unused link" : "no link"} and ${sessions.size} session${sessions.size === 1 ? "" : "s"} across the restart`);
      return true;
    },
    /** When the unredeemed link expires, or null when there is none. Mints nothing. */
    pending() {
      return server && token && token.expires > now() ? { port, expires: token.expires } : null;
    },
    /**
     * Close the listener. `forget` (the default) also voids the link and the sessions, for good;
     * vyred stopping passes false, so the next vyred can take them up again.
     */
    async close({ forget = true } = {}) {
      if (forget) { token = null; sessions.clear(); persist(); }
      if (!server) return;
      const s = server; server = null;
      s.closeAllConnections();
      await new Promise(r => s.close(() => r(undefined)));
      log("onboard: loopback closed");
    },
    open: () => Boolean(server),
    port: () => port,
  };

  async function ensure() {
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
  }
}
