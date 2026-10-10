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
import { matcher, dress, publicHeaders, signerCookies, handOn, CREDIT_CSS, SIGNED, checkLink, EXPIRED_HTML, filePaths } from "./signing.js";

export const ENTER = "/__vyre/enter";
export const COOKIE = "vyre_app";
/** The stylesheet that dresses a public signing page, served from the app's own origin. */
export const BRAND_CSS = "/__vyre/brand.css";
const MAX_BODY = 64 * 1024 * 1024;
/** What a stranger may send: a signature image and a few fields. */
const PUBLIC_BODY = 20 * 1024 * 1024;
const TICKET_MS = 60_000;
const SESSION_MS = 8 * 3_600_000;
/** Vyre's own header family, in any spelling a client can send: X-Vyre-*, x_vyre_* (an underscore is a dash to many servers). */
const vyreHeader = (/** @type {string} */ k) => /^x[-_]vyre[-_]/i.test(k);
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

/** One-time tickets and the sessions they are traded for. Tickets live a minute in memory; a session (8 hours) is also kept in the store when there is one, so a restart or an update does not sign anyone out. @param {{ now?: () => number, store?: any }} [o] */
export function createTickets(o = {}) {
  const now = o.now || Date.now;
  /** Signed-in sessions survive a restart when a store is given: kept by the hash of the cookie, never the cookie itself. @type {{ put: (h: string, r: any) => void, get: (h: string) => any, dropName: (n: string) => void, sweep: (t: number) => void } | undefined} */
  const store = o.store;
  const hash = (/** @type {string} */ sid) => crypto.createHash("sha256").update(String(sid)).digest("hex");
  /** @type {Map<string, { name: string, host: string, next: string, exp: number, who: { w: string, r: string } | null, embed: boolean }>} */ const tickets = new Map();
  /** @type {Map<string, { name: string, host: string, exp: number, who: { w: string, r: string } | null }>} */ const sessions = new Map();
  const sweep = () => { const t = now(); for (const [k, v] of tickets) if (v.exp < t) tickets.delete(k); for (const [k, v] of sessions) if (v.exp < t) sessions.delete(k); if (store) store.sweep(t); };
  /** A live session by its cookie: in memory, else from the store (after a restart). @param {string | undefined} sid */
  const load = sid => {
    if (!sid) return null;
    const m = sessions.get(sid);
    if (m) return m;
    const r = store ? store.get(hash(sid)) : null;
    if (r && r.exp > now()) { sessions.set(sid, r); return r; }
    return null;
  };
  return {
    /** A ticket for this app at this exact host; good once, for a minute. `who` is the person it was made for (their id and their role), which a preview's page is told on every request. @param {string} name @param {string} host @param {string} next @param {{ w: string, r: string } | null} [who] @param {boolean} [embed] the address is for a frame inside Vyre's own app: its cookie must work in a frame */
    issue(name, host, next, who = null, embed = false) { sweep(); const t = crypto.randomBytes(24).toString("base64url"); tickets.set(t, { name, host, next, exp: now() + TICKET_MS, who, embed }); return t; },
    /** Trade a ticket for a session id, once, only at the host it was made for. @param {string} t @param {string} host */
    trade(t, host) {
      sweep();
      const v = tickets.get(String(t));
      tickets.delete(String(t));
      if (!v || v.host !== host) return null;
      const sid = crypto.randomBytes(32).toString("base64url");
      sessions.set(sid, { name: v.name, host, exp: now() + SESSION_MS, who: v.who });
      if (store) store.put(hash(sid), { name: v.name, host, exp: now() + SESSION_MS, who: v.who });
      return { sid, next: v.next, maxAge: Math.floor(SESSION_MS / 1000), embed: v.embed };
    },
    /** @param {string | undefined} sid @param {string} name @param {string} host */
    valid(sid, name, host) { const v = load(sid); return Boolean(v && v.name === name && v.host === host && v.exp > now()); },
    /** Who a live session is for, or null. @param {string | undefined} sid */
    whoOf(sid) { const v = load(sid); return v && v.exp > now() ? v.who : null; },
    drop(/** @type {string} */ name) { for (const [k, v] of sessions) if (v.name === name) sessions.delete(k); for (const [k, v] of tickets) if (v.name === name) tickets.delete(k); if (store) store.dropName(name); },
  };
}

/** @param {string} origin @param {string} method @param {string} path @param {Record<string, string>} headers @param {{ body?: NodeJS.ReadableStream | Buffer | string | null, timeoutMs?: number }} [o] @returns {Promise<http.IncomingMessage>} */
function upstream(origin, method, path, headers, o = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(origin);
    const req = http.request({ host: u.hostname, port: u.port, method, path, headers, timeout: o.timeoutMs ?? 120_000 }, resolve);
    req.on("timeout", () => req.destroy(Object.assign(new Error("the app did not answer: wait a minute and call again, or look at appmods.status"), { code: "timeout" })));
    req.on("error", reject);
    const b = o.body;
    if (b && typeof /** @type {any} */ (b).pipe === "function") /** @type {NodeJS.ReadableStream} */ (b).pipe(req); else req.end(b || undefined);
  });
}
const readAll = (/** @type {http.IncomingMessage} */ res, cap = 1024 * 1024) => new Promise((resolve, reject) => { const c = /** @type {Buffer[]} */ ([]); let n = 0; res.on("data", d => { n += d.length; if (n > cap) { res.destroy(new Error("too big")); reject(new Error("too big")); } else c.push(d); }); res.on("end", () => resolve(Buffer.concat(c))); res.on("error", reject); });

/**
 * @param {{ app: (name: string) => Promise<null | { origin: string, origins: string[], login: null | { path: string, token: string, fields: Record<string, string>, ok: number[] }, public?: string[], rewriteHost?: boolean, passCookies?: boolean, allowEmbed?: boolean, viewerKey?: string, signing?: { routes?: { methods: string[], path: string }[], redirects?: { from: string, to: string }[], signed?: { list: string } }, credentials: () => Promise<Record<string, string>> }>,
 *   alias?: (host: string) => string | null,   the app an own domain (sign.firm.com) is for, or null
 *   tickets: ReturnType<typeof createTickets>, log?: (m: string) => void, brand?: () => Promise<string>, linkKey?: (name: string) => Buffer | null, now?: () => number,
 *   wsMax?: number, wsConnectMs?: number, wsHeadMs?: number, wsIdleMs?: number }} o
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

  /** Which app a host is for, and the address a person sees it at: an own domain the module lists (sign.firm.com), else <module>.<base>. @param {string} host */
  function appHost(host) {
    const own = o.alias ? o.alias(host.replace(/:\d+$/, "")) : null;
    if (own) return { name: own, base: host, here: `https://${host}` };
    const m = moduleHost(host);
    return m ? { ...m, here: originFor(m.name, m.base) } : null;
  }

  async function serve(req, res, { url }) {
    const host = String(req.headers.host || "").toLowerCase();
    const mh = appHost(host);
    if (!mh) return false;
    const app = await o.app(mh.name);
    if (!app) return false;
    const plain = (/** @type {number} */ code, /** @type {string} */ text, /** @type {Record<string, string>} */ more = {}) => { res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...more }); res.end(text); return true; };
    const secure = Boolean(/** @type {any} */ (req.socket).encrypted) || String(req.headers["x-forwarded-proto"] || "") === "https" || !/^localhost(?::\d+)?$/.test(mh.base);
    const here = mh.here;
    // The way in: a ticket Vyre made for this host, traded once for this host's cookie.
    if (url.pathname === ENTER) {
      if (req.method !== "GET") return plain(404, "not found");
      const got = o.tickets.trade(url.searchParams.get("t") || "", host);
      if (!got) return plain(404, "not found");
      res.writeHead(302, { location: got.next || "/", "set-cookie": `${COOKIE}=${got.sid}; Path=/; HttpOnly; ${got.embed ? "SameSite=None; Secure; Partitioned" : `SameSite=Lax${secure ? "; Secure" : ""}`}; Max-Age=${got.maxAge}`, "cache-control": "no-store" });
      res.end();
      return true;
    }
    const sid = /(?:^|;\s*)vyre_app=([A-Za-z0-9_-]+)/.exec(String(req.headers.cookie || ""));
    const method = String(req.method);
    const sign = app.signing ? matcher(app.signing) : null;
    const ticketed = o.tickets.valid(sid ? sid[1] : undefined, mh.name, host);
    // A signer's way in: the pretty link goes to the page (no ticket, nothing of the app touched), and the stylesheet that dresses the pages is ours.
    if (sign && !ticketed && ["GET", "HEAD"].includes(method)) {
      const to = sign.redirect(url.pathname);
      if (to) { res.writeHead(302, { location: to, ...publicHeaders(false) }); res.end(); return true; }
      if (url.pathname === BRAND_CSS) {
        const css = CREDIT_CSS + (o.brand ? await o.brand().catch(() => "") : "");
        res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
        res.end(method === "HEAD" ? undefined : css);
        return true;
      }
    }
    // The signed copy, by an expiring link only: /signed/<token>[/<n>]. The app's own address for the finished file is not public (the signer's slug opens the signing page, not the PDF).
    if (sign && !ticketed && app.signing && app.signing.signed && o.linkKey && method === "GET" && url.pathname.startsWith(SIGNED)) {
      const m = /^\/signed\/([^/]+)(?:\/(\d))?$/.exec(url.pathname);
      const key = o.linkKey(mh.name);
      const c = m && key ? checkLink(key, m[1], (o.now || Date.now)()) : null;
      if (!c) return plain(404, "not found");
      if (!c.ok) {
        if (c.expired) { res.writeHead(410, { "content-type": "text/html; charset=utf-8", ...publicHeaders(true) }); res.end(EXPIRED_HTML); return true; }
        return plain(404, "not found");
      }
      try {
        const list = await upstream(app.origin, "GET", app.signing.signed.list.replace(":slug", c.slug), { accept: "application/json", "accept-encoding": "identity" });
        const files = filePaths(JSON.parse((await readAll(list, 1024 * 1024)).toString("utf8") || "null"));
        const at = files[Number(m && m[2] || 0)];
        if (!at) return plain(404, "not found");
        const f = await upstream(app.origin, "GET", at, { "accept-encoding": "identity" });
        if ((f.statusCode || 0) !== 200) { await readAll(f).catch(() => {}); return plain(502, "The signed copy is not available right now. Try again in a minute."); }
        const name = at.split("/").pop() || "signed.pdf";
        res.writeHead(200, { "content-type": String(f.headers["content-type"] || "application/pdf"), "content-disposition": `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, "_")}"`, ...(f.headers["content-length"] ? { "content-length": String(f.headers["content-length"]) } : {}), ...publicHeaders(false), "cache-control": "no-store" });
        f.pipe(res);
        return true;
      } catch (e) { log(`appmods: ${mh.name} signed copy: ${/** @type {Error} */ (e).message}`); return plain(502, "The signed copy is not available right now. Try again in a minute."); }
    }
    const exact = ["GET", "HEAD"].includes(method) && Array.isArray(app.public) && app.public.includes(url.pathname);
    const signing = Boolean(sign && sign.open(method, url.pathname));
    // A server Publish made, once live, answers everyone on every route with its own cookies and nothing of Vyre's: the owner's ticket cookie is removed below (passCookies) and the app has no sign-in here
    const wide = app.open === true;
    const open = exact || signing || wide;
    // Anyone without a ticket on a SIGNING route or a public path is a stranger, not the owner: the app sees them as it sees a stranger, never as the install's admin (test/stranger-session.test.js, S6).
    const stranger = (signing || exact) && !ticketed;
    if (!open && !ticketed) return plain(404, "not found");
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(String(req.method))) return plain(405, "method not allowed");
    try {
      if (!stranger && !(await ensure(mh.name, app))) return plain(502, "Vyre could not sign in to the app. Try again in a minute.");
      /** @param {boolean} retry */
      const once = async retry => {
        /** @type {Record<string, string>} */ const h = {};
        for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !vyreHeader(k) && typeof v === "string") h[k] = v;
        const jar = jars.get(mh.name);
        // an open server's visitors send their own credentials to the site they are using; nothing of Vyre's is ever in the header (the owner's session is the cookie this front removes)
        if (wide && typeof req.headers.authorization === "string") h.authorization = req.headers.authorization;
        if (stranger) {
          // only the signer's own cookies for the app; never the install's session, never ours; an uncompressed answer so a page can be dressed
          const c = signerCookies(req.headers.cookie);
          if (c) h.cookie = c;
          h["accept-encoding"] = "identity";
        } else if (jar && jar.size) h.cookie = cookieHeader(jar);
        // A preview is a whole app of its own on its own origin: its cookies are its own, so they go through (never Vyre's session cookie, which is only this proxy's).
        if (app.passCookies) { const mine = String(req.headers.cookie || "").split(/;\s*/).filter(c => c && !c.startsWith(COOKIE + "=")).join("; "); if (mine) h.cookie = mine; else delete h.cookie; }
        if (req.headers["content-length"]) { if (Number(req.headers["content-length"]) > (stranger || (wide && !ticketed) ? PUBLIC_BODY : MAX_BODY)) throw Object.assign(new Error("too big"), { code: "too_big" }); h["content-length"] = String(req.headers["content-length"]); }
        if (req.headers["transfer-encoding"]) h["transfer-encoding"] = String(req.headers["transfer-encoding"]);
        // A preview's own dev server answers only to its own address (Vite's allowed hosts, a framework's host check): it is sent that, and told the host the person is on.
        if (app.viewerKey) { const w = o.tickets.whoOf(sid ? sid[1] : undefined); if (w) h["x-vyre-viewer"] = viewerHeader(app.viewerKey, w); else delete h["x-vyre-viewer"]; }
        if (app.rewriteHost) { const u = new URL(app.origin); h["x-forwarded-host"] = host; h["x-forwarded-proto"] = secure ? "https" : "http"; h.host = u.host; delete h.origin; delete h.referer; }
        const r = await upstream(app.origin, String(req.method), url.pathname + url.search, h, { body: ["GET", "HEAD"].includes(String(req.method)) ? null : req });
        // The app lost our session (it restarted, it expired): sign in again, once, and repeat a request that has no body to repeat.
        if (!retry && !stranger && app.login && jars.has(mh.name) && String(r.headers.location || "").includes(app.login.path) && ["GET", "HEAD"].includes(String(req.method))) { await readAll(r).catch(() => {}); jars.delete(mh.name); if (!(await ensure(mh.name, app, true))) throw Object.assign(new Error("sign in"), { code: "login" }); return once(true); }
        return r;
      };
      const r = await once(false);
      /** @type {Record<string, string | string[]>} */ const out = {};
      for (const [k, v] of Object.entries(r.headers)) { if (HOP.has(k) || (k === "set-cookie" && !app.passCookies) || v === undefined) continue; out[k] = /** @type {any} */ (v); }
      if (typeof out.location === "string") out.location = rewriteLocation(out.location, app.origins, here);
      // an open server's cookies stay on its own host: a Domain attribute would reach the other apps' hosts and Vyre's own
      if (wide && out["set-cookie"]) out["set-cookie"] = [].concat(/** @type {any} */ (out["set-cookie"])).map(handOn);
      if (stranger) {
        // the signer's cookies go back to the signer, not into the install's jar
        const sc = r.headers["set-cookie"];
        if (sc) out["set-cookie"] = (Array.isArray(sc) ? sc : [sc]).map(handOn);
        const isHtml = /^text\/html/i.test(String(r.headers["content-type"] || ""));
        Object.assign(out, publicHeaders(isHtml));
        if (isHtml && (r.statusCode || 0) === 200 && method === "GET") {
          const page = (await readAll(r, 4 * 1024 * 1024)).toString("utf8");
          const body = Buffer.from(dress(page, BRAND_CSS), "utf8");
          out["content-length"] = String(body.length);
          res.writeHead(200, out);
          res.end(body);
          return true;
        }
        res.writeHead(r.statusCode || 502, out);
        if (method === "HEAD") { r.resume(); res.end(); } else r.pipe(res);
        return true;
      }
      const jar = jars.get(mh.name) || new Map();
      keepCookies(jar, r.headers["set-cookie"]);
      if (app.login) jars.set(mh.name, jar);
      // A preview is the owner's own, shown in Vyre's own app: the page's own wish not to be framed does not apply to Vyre, so the headers that say it are dropped (only for a preview).
      if (app.allowEmbed) { delete out["x-frame-options"]; if (typeof out["content-security-policy"] === "string") out["content-security-policy"] = out["content-security-policy"].replace(/(^|;)\s*frame-ancestors[^;]*/gi, "$1").replace(/^\s*;\s*/, ""); }
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
  /** @type {Map<string, number>} open tunnels per app */
  const wsOpen = new Map();
  serve.upgrade = async (req, socket, head) => {
    const host = String(req.headers.host || "").toLowerCase();
    const mh = appHost(host);
    if (!mh) return false;
    const app = await o.app(mh.name);
    if (!app) return false;
    const refuse = () => { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\ncontent-length: 0\r\n\r\n"); return true; };
    const sid = /(?:^|;\s*)vyre_app=([A-Za-z0-9_-]+)/.exec(String(req.headers.cookie || ""));
    // a server Publish made, once live, takes everyone's WebSocket as it takes everyone's request: with its own cookies and the visitor's own Authorization, never Vyre's session
    const wide = app.open === true;
    if (!wide && !o.tickets.valid(sid ? sid[1] : undefined, mh.name, host)) return refuse();
    // A tunnel is a file descriptor of the daemon's, which serves the owner's Vyre too: a cap per app, a limit on connecting, on the app's answer and on silence, and either end closing closes the other.
    const L = { max: o.wsMax ?? 64, connectMs: o.wsConnectMs ?? 10_000, headMs: o.wsHeadMs ?? 10_000, idleMs: o.wsIdleMs ?? 600_000 };
    const open = (wsOpen.get(mh.name) || 0);
    if (open >= L.max) { socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nretry-after: 5\r\ncontent-length: 0\r\n\r\n"); return true; }
    wsOpen.set(mh.name, open + 1);
    const u = new URL(app.origin);
    const up = net.connect({ host: u.hostname, port: Number(u.port) || 80 });
    let done = false;
    const end = () => { if (done) return; done = true; wsOpen.set(mh.name, Math.max(0, (wsOpen.get(mh.name) || 1) - 1)); try { up.destroy(); } catch { /* gone */ } try { socket.destroy(); } catch { /* gone */ } };
    up.on("error", end); up.on("close", end); socket.on("error", end); socket.on("close", end);
    socket.pause();
    const connectT = setTimeout(end, L.connectMs); connectT.unref?.();
    up.on("connect", () => {
      clearTimeout(connectT);
      /** @type {string[]} */ const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i], v = req.rawHeaders[i + 1], low = k.toLowerCase();
        if (low === "authorization" && !wide) continue;
        if (low === "cookie") { if (!app.passCookies) continue; const mine = v.split(/;\s*/).filter(c => c && !c.startsWith(COOKIE + "=")).join("; "); if (mine) lines.push(`Cookie: ${mine}`); continue; } // the person's Vyre session never travels to the app
        if (low === "host" && app.rewriteHost) { lines.push(`Host: ${u.host}`); lines.push(`X-Forwarded-Host: ${host}`); continue; }
        if ((low === "origin" || low === "referer") && app.rewriteHost) continue;
        if (vyreHeader(low)) continue; // only the proxy tells a page who is looking
        lines.push(`${k}: ${v}`);
      }
      const wsWho = app.viewerKey ? o.tickets.whoOf(sid ? sid[1] : undefined) : null;
      if (wsWho && app.viewerKey) lines.push(`X-Vyre-Viewer: ${viewerHeader(app.viewerKey, wsWho)}`);
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head && head.length) up.write(head);
      // the app's answer is read here first: only a 101 turns the connection into a tunnel; anything else (a plain 200 that keeps the connection alive) would let the client send further requests with no header filtering
      let buf = Buffer.alloc(0);
      const headT = setTimeout(end, L.headMs); headT.unref?.();
      const onData = (/** @type {Buffer} */ d) => {
        buf = Buffer.concat([buf, d]);
        const at = buf.indexOf("\r\n\r\n");
        if (at < 0) { if (buf.length > 16 * 1024) { clearTimeout(headT); end(); } return; }
        clearTimeout(headT);
        up.off("data", onData);
        if (!/^HTTP\/1\.1 101[ \r]/.test(buf.subarray(0, 16).toString("latin1"))) { socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\ncontent-length: 0\r\n\r\n"); end(); return; }
        socket.write(buf);
        up.setTimeout(L.idleMs, end); socket.setTimeout(L.idleMs, end);
        up.pipe(socket); socket.pipe(up);
        socket.resume();
      };
      up.on("data", onData);
    });
    return true;
  };
  return serve;
}
