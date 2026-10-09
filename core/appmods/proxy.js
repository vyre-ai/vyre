// @ts-check
// The app's own screens, on the app's OWN origin: <module>.<the host Vyre is served at> (documents.acme.vyre.run). Not under a path of Vyre's origin: the app's JavaScript would then run beside Vyre's and
// could call Vyre as the person. On its own origin the browser keeps them apart (Vyre's cookie is for Vyre's host only), and nothing of the app is rewritten.
//   - A request whose Host is <installed running app>.<anything> is answered here and nowhere else, whatever its path: this origin has no Vyre on it.
//   - Vyre's sign-in reaches it by a one-time ticket (`appmods.open`, for the Space's owner and admins): the browser opens /__vyre/enter?t=..., the proxy trades the ticket for a session cookie scoped to
//     that host only (HttpOnly, SameSite=Lax; Secure on https), and sends the person to the screen. No cookie, no ticket, no word: a plain 404.
//   - The app's own sign-in is done here with the credentials the install kept in the Vault; the app's cookies live in the proxy and never reach a browser.
//   - Nothing but the app's origin is ever fetched, and the app's `Location` redirects to its own address are put back on this origin.
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";

export const ENTER = "/__vyre/enter";
export const COOKIE = "vyre_app";
const MAX_BODY = 64 * 1024 * 1024;
const TICKET_MS = 60_000;
const SESSION_MS = 8 * 3_600_000;
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "cookie", "authorization"]);

/** `documents.acme.vyre.run:8443` -> { name: "documents", base: "acme.vyre.run:8443" }, or null. @param {string} host */
export function moduleHost(host) {
  const m = /^([a-z][a-z0-9-]{1,30})\.([a-z0-9.-]+(?::\d{1,5})?)$/.exec(String(host || "").toLowerCase());
  return m ? { name: m[1], base: m[2] } : null;
}

/** The origin an app is reached at: https for a real host, http for localhost (browsers treat it as secure). @param {string} name @param {string} base */
export function originFor(name, base) {
  const b = base.replace(/^https?:\/\//, "");
  return `${/^localhost(?::\d+)?$/.test(b) ? "http" : "https"}://${name}.${b}`;
}

/** A redirect the app sent to its own address is put back on the origin the person is on. @param {string} loc @param {string[]} appOrigins @param {string} here */
export function rewriteLocation(loc, appOrigins, here) {
  for (const o of appOrigins) if (loc === o || loc.startsWith(o + "/") || loc.startsWith(o + "?")) return here + loc.slice(o.length);
  return loc;
}

/** Cookies a response set -> the jar (name -> value). A Max-Age of 0 or an expiry in the past removes one. @param {Map<string, string>} jar @param {string[] | string | undefined} setCookie */
export function keepCookies(jar, setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const c of list) {
    const [pair, ...attrs] = c.split(";");
    const i = pair.indexOf("=");
    if (i < 1) continue;
    const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
    const gone = attrs.some(a => /^\s*max-age\s*=\s*0*\s*$/i.test(a)) || attrs.some(a => { const m = /^\s*expires\s*=\s*(.+)$/i.exec(a); return m && Date.parse(m[1]) < Date.now(); });
    if (gone || value === "") jar.delete(name); else jar.set(name, value);
  }
}
export const cookieHeader = (/** @type {Map<string, string>} */ jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

/**
 * What a preview's page is told about who is looking: `<base64url json {w, r, t}>.<hmac>`, made here with a key the previews module gave for that preview and checked there with the same key. A local process that
 * reaches the preview's loopback address cannot forge it. @param {string} key @param {{ w: string, r: string }} who @param {number} [at]
 */
export function viewerHeader(key, who, at = Date.now()) {
  const body = Buffer.from(JSON.stringify({ w: who.w, r: who.r, t: at })).toString("base64url");
  return `${body}.${crypto.createHmac("sha256", key).update(body).digest("base64url")}`;
}

/** One-time tickets and the sessions they are traded for. In memory: a restart means opening the app again from Vyre. @param {{ now?: () => number }} [o] */
export function createTickets(o = {}) {
  const now = o.now || Date.now;
  /** @type {Map<string, { name: string, host: string, next: string, exp: number, who: { w: string, r: string } | null }>} */ const tickets = new Map();
  /** @type {Map<string, { name: string, host: string, exp: number, who: { w: string, r: string } | null }>} */ const sessions = new Map();
  const sweep = () => { const t = now(); for (const [k, v] of tickets) if (v.exp < t) tickets.delete(k); for (const [k, v] of sessions) if (v.exp < t) sessions.delete(k); };
  return {
    /** A ticket for this app at this exact host; good once, for a minute. `who` is the person it was made for (their id and their role), which a preview's page is told on every request. @param {string} name @param {string} host @param {string} next @param {{ w: string, r: string } | null} [who] */
    issue(name, host, next, who = null) { sweep(); const t = crypto.randomBytes(24).toString("base64url"); tickets.set(t, { name, host, next, exp: now() + TICKET_MS, who }); return t; },
    /** Trade a ticket for a session id, once, only at the host it was made for. @param {string} t @param {string} host */
    trade(t, host) {
      sweep();
      const v = tickets.get(String(t));
      tickets.delete(String(t));
      if (!v || v.host !== host) return null;
      const sid = crypto.randomBytes(32).toString("base64url");
      sessions.set(sid, { name: v.name, host, exp: now() + SESSION_MS, who: v.who });
      return { sid, next: v.next, maxAge: Math.floor(SESSION_MS / 1000) };
    },
    /** @param {string | undefined} sid @param {string} name @param {string} host */
    valid(sid, name, host) { const v = sid ? sessions.get(sid) : null; return Boolean(v && v.name === name && v.host === host && v.exp > now()); },
    /** Who a live session is for, or null. @param {string | undefined} sid */
    whoOf(sid) { const v = sid ? sessions.get(sid) : null; return v && v.exp > now() ? v.who : null; },
    drop(/** @type {string} */ name) { for (const [k, v] of sessions) if (v.name === name) sessions.delete(k); for (const [k, v] of tickets) if (v.name === name) tickets.delete(k); },
  };
}

/** @param {string} origin @param {string} method @param {string} path @param {Record<string, string>} headers @param {{ body?: NodeJS.ReadableStream | Buffer | string | null, timeoutMs?: number }} [o] @returns {Promise<http.IncomingMessage>} */
function upstream(origin, method, path, headers, o = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(origin);
    const req = http.request({ host: u.hostname, port: u.port, method, path, headers, timeout: o.timeoutMs ?? 120_000 }, resolve);
    req.on("timeout", () => req.destroy(Object.assign(new Error("the app did not answer"), { code: "timeout" })));
    req.on("error", reject);
    const b = o.body;
    if (b && typeof /** @type {any} */ (b).pipe === "function") /** @type {NodeJS.ReadableStream} */ (b).pipe(req); else req.end(b || undefined);
  });
}
const readAll = (/** @type {http.IncomingMessage} */ res, cap = 1024 * 1024) => new Promise((resolve, reject) => { const c = /** @type {Buffer[]} */ ([]); let n = 0; res.on("data", d => { n += d.length; if (n > cap) { res.destroy(new Error("too big")); reject(new Error("too big")); } else c.push(d); }); res.on("end", () => resolve(Buffer.concat(c))); res.on("error", reject); });

/**
 * @param {{ app: (name: string) => Promise<null | { origin: string, origins: string[], login: null | { path: string, token: string, fields: Record<string, string>, ok: number[] }, public?: string[], rewriteHost?: boolean, passCookies?: boolean, viewerKey?: string, credentials: () => Promise<Record<string, string>> }>,
 *   tickets: ReturnType<typeof createTickets>, log?: (m: string) => void }} o
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse, at: { url: URL }) => Promise<boolean>} true when the request was this module's (answered), false when it is for something else
 */
export function createHostProxy(o) {
  const log = o.log || (() => {});
  /** @type {Map<string, Map<string, string>>} the app's own session cookies, one jar per app */
  const jars = new Map();
  /** @type {Map<string, Promise<boolean>>} */ const signing = new Map();

  async function signIn(/** @type {string} */ name, /** @type {any} */ app) {
    const l = app.login;
    if (!l) return true;
    const jar = new Map();
    const page = await upstream(app.origin, "GET", l.path, { accept: "text/html" });
    const html = (await readAll(page)).toString("utf8");
    keepCookies(jar, page.headers["set-cookie"]);
    const tok = new RegExp(`name=["']${l.token}["'][^>]*value=["']([^"']+)["']|value=["']([^"']+)["'][^>]*name=["']${l.token}["']`).exec(html) || new RegExp(`name=["']csrf-token["'][^>]*content=["']([^"']+)["']|content=["']([^"']+)["'][^>]*name=["']csrf-token["']`).exec(html);
    const authenticity = tok ? (tok[1] || tok[2]) : "";
    const cred = await app.credentials();
    const form = new URLSearchParams();
    form.set(l.token, authenticity);
    for (const [k, v] of Object.entries(l.fields)) form.set(k, v.replace(/\{([a-z_]+)\}/g, (_m, key) => cred[key] ?? ""));
    const body = form.toString();
    const r = await upstream(app.origin, "POST", l.path, { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)), cookie: cookieHeader(jar), origin: app.origin, referer: app.origin + l.path }, { body });
    await readAll(r).catch(() => {});
    keepCookies(jar, r.headers["set-cookie"]);
    if (!l.ok.includes(r.statusCode || 0)) { log(`appmods: signing in to ${name} gave ${r.statusCode}`); return false; }
    jars.set(name, jar);
    return true;
  }
  async function ensure(/** @type {string} */ name, /** @type {any} */ app, force = false) {
    if (!app.login) return true;
    if (!force && jars.has(name)) return true;
    if (!signing.has(name)) signing.set(name, signIn(name, app).finally(() => signing.delete(name)));
    return /** @type {Promise<boolean>} */ (signing.get(name));
  }

  async function serve(req, res, { url }) {
    const host = String(req.headers.host || "").toLowerCase();
    const mh = moduleHost(host);
    if (!mh) return false;
    const app = await o.app(mh.name);
    if (!app) return false;
    const plain = (/** @type {number} */ code, /** @type {string} */ text, /** @type {Record<string, string>} */ more = {}) => { res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...more }); res.end(text); return true; };
    const secure = Boolean(/** @type {any} */ (req.socket).encrypted) || String(req.headers["x-forwarded-proto"] || "") === "https" || !/^localhost(?::\d+)?$/.test(mh.base);
    const here = originFor(mh.name, mh.base);
    // The way in: a ticket Vyre made for this host, traded once for this host's cookie.
    if (url.pathname === ENTER) {
      if (req.method !== "GET") return plain(404, "not found");
      const got = o.tickets.trade(url.searchParams.get("t") || "", host);
      if (!got) return plain(404, "not found");
      res.writeHead(302, { location: got.next || "/", "set-cookie": `${COOKIE}=${got.sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${got.maxAge}${secure ? "; Secure" : ""}`, "cache-control": "no-store" });
      res.end();
      return true;
    }
    const sid = /(?:^|;\s*)vyre_app=([A-Za-z0-9_-]+)/.exec(String(req.headers.cookie || ""));
    const open = ["GET", "HEAD"].includes(String(req.method)) && Array.isArray(app.public) && app.public.includes(url.pathname);
    if (!open && !o.tickets.valid(sid ? sid[1] : undefined, mh.name, host)) return plain(404, "not found");
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(String(req.method))) return plain(405, "method not allowed");
    try {
      if (!(await ensure(mh.name, app))) return plain(502, "Vyre could not sign in to the app. Try again in a minute.");
      /** @param {boolean} retry */
      const once = async retry => {
        /** @type {Record<string, string>} */ const h = {};
        for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith("x-vyre-") && typeof v === "string") h[k] = v;
        const jar = jars.get(mh.name);
        if (jar && jar.size) h.cookie = cookieHeader(jar);
        // A preview is a whole app of its own on its own origin: its cookies are its own, so they go through (never Vyre's session cookie, which is only this proxy's).
        if (app.passCookies) { const mine = String(req.headers.cookie || "").split(/;\s*/).filter(c => c && !c.startsWith(COOKIE + "=")).join("; "); if (mine) h.cookie = mine; else delete h.cookie; }
        if (req.headers["content-length"]) { if (Number(req.headers["content-length"]) > MAX_BODY) throw Object.assign(new Error("too big"), { code: "too_big" }); h["content-length"] = String(req.headers["content-length"]); }
        if (req.headers["transfer-encoding"]) h["transfer-encoding"] = String(req.headers["transfer-encoding"]);
        // A preview's own dev server answers only to its own address (Vite's allowed hosts, a framework's host check): it is sent that, and told the host the person is on.
        if (app.viewerKey) { const w = o.tickets.whoOf(sid ? sid[1] : undefined); if (w) h["x-vyre-viewer"] = viewerHeader(app.viewerKey, w); else delete h["x-vyre-viewer"]; }
        if (app.rewriteHost) { const u = new URL(app.origin); h["x-forwarded-host"] = host; h["x-forwarded-proto"] = secure ? "https" : "http"; h.host = u.host; delete h.origin; delete h.referer; }
        const r = await upstream(app.origin, String(req.method), url.pathname + url.search, h, { body: ["GET", "HEAD"].includes(String(req.method)) ? null : req });
        // The app lost our session (it restarted, it expired): sign in again, once, and repeat a request that has no body to repeat.
        if (!retry && app.login && jars.has(mh.name) && String(r.headers.location || "").includes(app.login.path) && ["GET", "HEAD"].includes(String(req.method))) { await readAll(r).catch(() => {}); jars.delete(mh.name); if (!(await ensure(mh.name, app, true))) throw Object.assign(new Error("sign in"), { code: "login" }); return once(true); }
        return r;
      };
      const r = await once(false);
      const jar = jars.get(mh.name) || new Map();
      keepCookies(jar, r.headers["set-cookie"]);
      if (app.login) jars.set(mh.name, jar);
      /** @type {Record<string, string | string[]>} */ const out = {};
      for (const [k, v] of Object.entries(r.headers)) { if (HOP.has(k) || (k === "set-cookie" && !app.passCookies) || v === undefined) continue; out[k] = /** @type {any} */ (v); }
      if (typeof out.location === "string") out.location = rewriteLocation(out.location, app.origins, here);
      res.writeHead(r.statusCode || 502, out);
      if (req.method === "HEAD") { r.resume(); res.end(); } else r.pipe(res);
      return true;
    } catch (e) {
      const err = /** @type {any} */ (e);
      log(`appmods: ${mh.name} ${req.method} ${url.pathname.slice(0, 80)}: ${err && err.message}`);
      if (res.headersSent) { res.destroy(); return true; }
      return plain(err && err.code === "too_big" ? 413 : 502, err && err.code === "too_big" ? "too big" : "The app is not answering. It may still be starting.");
    }
  }

  /**
   * A WebSocket (a dev server's hot reload, a live app's channel) on an app's own origin: the same checks as a request (the host names a running app, the session cookie is this host's), then the bytes
   * are tunnelled to the app's own address. Anything else is closed with a plain 404.
   * @param {http.IncomingMessage} req @param {import("node:net").Socket} socket @param {Buffer} head
   * @returns {Promise<boolean>} true when it was an app host (answered or tunnelled)
   */
  serve.upgrade = async (req, socket, head) => {
    const host = String(req.headers.host || "").toLowerCase();
    const mh = moduleHost(host);
    if (!mh) return false;
    const app = await o.app(mh.name);
    if (!app) return false;
    const refuse = () => { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\ncontent-length: 0\r\n\r\n"); return true; };
    const sid = /(?:^|;\s*)vyre_app=([A-Za-z0-9_-]+)/.exec(String(req.headers.cookie || ""));
    if (!o.tickets.valid(sid ? sid[1] : undefined, mh.name, host)) return refuse();
    const u = new URL(app.origin);
    const up = net.connect({ host: u.hostname, port: Number(u.port) || 80 });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
    up.on("connect", () => {
      /** @type {string[]} */ const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i], v = req.rawHeaders[i + 1], low = k.toLowerCase();
        if (low === "authorization") continue;
        if (low === "cookie") { if (!app.passCookies) continue; const mine = v.split(/;\s*/).filter(c => c && !c.startsWith(COOKIE + "=")).join("; "); if (mine) lines.push(`Cookie: ${mine}`); continue; } // the person's Vyre session never travels to the app
        if (low === "host" && app.rewriteHost) { lines.push(`Host: ${u.host}`); lines.push(`X-Forwarded-Host: ${host}`); continue; }
        if ((low === "origin" || low === "referer") && app.rewriteHost) continue;
        if (low.startsWith("x-vyre-")) continue; // only the proxy tells a page who is looking
        lines.push(`${k}: ${v}`);
      }
      const wsWho = app.viewerKey ? o.tickets.whoOf(sid ? sid[1] : undefined) : null;
      if (wsWho && app.viewerKey) lines.push(`X-Vyre-Viewer: ${viewerHeader(app.viewerKey, wsWho)}`);
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head && head.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    return true;
  };
  return serve;
}
