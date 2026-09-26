// @ts-check
// The onboarding listener: plain HTTP on 127.0.0.1, before the box has an owner (ADR 0002).
//
// Anyone on the box can reach a loopback port, so nothing here is served without either the
// one-time token from `vyre up` or the cookie it was exchanged for. The token is kept only as a
// hash, works once, and expires after an hour. The listener serves the onboarding page's files
// and a short list of tools, and closes for good once the owner has been seen on the tailnet.

import crypto from "node:crypto";
import http from "node:http";

const HOUR = 3_600_000;
const SESSION = 12 * HOUR;
const COOKIE = "vyre_onboard";
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");

/** The tools the onboarding page may call. onboard.link is not one: only the socket mints links. */
export const TOOLS = new Set(["onboard.status", "onboard.name", "onboard.claude", "onboard.tailscale", "onboard.history",
  "onboard.skip", "onboard.finish", "projects.catalog", "projects.create", "recall.status"]);

const onboardPath = p => p === "/onboard" || p.startsWith("/onboard/");

/**
 * @param {{ handler: (policy: any) => (req: any, res: any, caller: string) => Promise<void>, port?: number, now?: () => number, log?: (m: string) => void }} deps
 */
export function loopback({ handler, port: wanted = 7300, now = Date.now, log = () => {} }) {
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

  function cookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }

  function session(req) {
    const sid = cookies(req)[COOKIE];
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
      res.writeHead(302, { location: "/onboard", "set-cookie": `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION / 1000}`, "cache-control": "no-store" });
      return res.end();
    }
    if (!session(req)) return text(res, 403, "Open the link `vyre up` printed on the box.");
    if (req.method === "GET" && url.pathname === "/") { res.writeHead(302, { location: "/onboard" }); return res.end(); }
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
      s.listen(p, "127.0.0.1", () => { s.off("error", reject); resolve(s); });
    });
  }

  return {
    /** Open the listener (if needed) and mint a fresh token, voiding any unredeemed one. */
    async link() {
      if (!server) {
        for (let p = wanted; p < wanted + 20 && !server; p++) {
          if (p === 0) { server = /** @type {http.Server} */ (await listen(0)); break; }
          try { server = /** @type {http.Server} */ (await listen(p)); }
          catch (e) { if (/** @type {any} */ (e).code !== "EADDRINUSE") throw e; }
        }
        if (!server) server = /** @type {http.Server} */ (await listen(0));
        port = /** @type {any} */ (server.address()).port;
        log(`onboard: listening on 127.0.0.1:${port}`);
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
