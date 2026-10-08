// @ts-check
// The app's own screens, served by vyred under /m/<module>/ behind Vyre's sign-in (spec 0.3.0 part 8, interface 3). The app is never forked or restyled: this proxy takes what the app says and puts it
// under the prefix. Most apps (DocuSeal among them) want the root of an origin and have no setting for a sub-path, so what is root-absolute is made prefixed on the way out (HTML and CSS bodies,
// redirects, cookies) and by a small script the proxy serves itself (the page's own Content-Security-Policy only allows scripts from the same origin) for what the app's JavaScript builds at run time.
//   - Only a signed-in person gets anything (the caller the daemon established); everyone else gets a plain 404.
//   - The app's own sign-in is done here, once, with the credentials the install made and kept in the Vault: the person never sees a second login, and the app's cookies never reach the browser
//     (and Vyre's never reach the app).
//   - Nothing but the app's origin is ever fetched: the app cannot send the proxy anywhere else.
import http from "node:http";

export const SHIM_PATH = "/__vyre/shim.js";
const MAX_BODY = 16 * 1024 * 1024;
const MAX_REWRITE = 8 * 1024 * 1024;
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", "accept-encoding", "cookie", "authorization", "origin", "referer"]);

/** `/m/docuseal/templates/1?x=2` -> { name: "docuseal", rest: "/templates/1?x=2" }, or null. @param {URL} url */
export function split(url) {
  const m = /^\/m\/([a-z][a-z0-9-]{1,30})(\/.*)?$/.exec(url.pathname);
  return m ? { name: m[1], rest: (m[2] || "/") + url.search } : null;
}

/** Make a root-absolute path prefixed; leave everything else (relative, protocol-relative, other schemes, already prefixed) alone. @param {string} u @param {string} prefix */
export function pre(u, prefix) {
  if (typeof u !== "string" || u[0] !== "/" || u[1] === "/" || u[1] === "\\") return u;
  return u === prefix || u.startsWith(prefix + "/") ? u : prefix + u;
}

/** The app's own addresses for itself (where it thinks it lives), as a list the body rewrite turns into the prefix. @param {string[]} origins */
const originsRe = origins => new RegExp(`(?:${origins.map(o => o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?=/|"|'|\\s|$)`, "g");

/**
 * HTML out: every root-absolute href, src, action, poster, formaction and srcset entry gets the prefix; the app's own origins become the prefix; the shim is the first script in <head>.
 * @param {string} html @param {string} prefix @param {{ origins?: string[], shim?: boolean }} [o]
 */
export function rewriteHtml(html, prefix, o = {}) {
  let out = html;
  if (o.origins && o.origins.length) out = out.replace(originsRe(o.origins), prefix);
  out = out.replace(/(\s(?:href|src|action|poster|formaction|data-src|data-url|data-href)\s*=\s*)(["'])(\/[^"']*)\2/gi, (_m, a, q, u) => `${a}${q}${pre(u, prefix)}${q}`);
  out = out.replace(/(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi, (_m, a, q, v) => `${a}${q}${v.split(",").map((/** @type {string} */ part) => { const t = part.trim().split(/\s+/); t[0] = pre(t[0], prefix); return t.join(" "); }).join(", ")}${q}`);
  if (o.shim !== false) out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, h => `${h}<script src="${prefix}${SHIM_PATH}"></script>`) : `<script src="${prefix}${SHIM_PATH}"></script>${out}`;
  return out;
}

/** CSS out: url(/x) and @import "/x". @param {string} css @param {string} prefix */
export function rewriteCss(css, prefix) {
  return css.replace(/url\(\s*(["']?)(\/[^)"']*)\1\s*\)/gi, (_m, q, u) => `url(${q}${pre(u, prefix)}${q})`).replace(/@import\s+(["'])(\/[^"']*)\1/gi, (_m, q, u) => `@import ${q}${pre(u, prefix)}${q}`);
}

/** A redirect the app sent: its own address (root-absolute, or on its own origin) becomes one under the prefix. @param {string} loc @param {string} prefix @param {string[]} origins */
export function rewriteLocation(loc, prefix, origins) {
  for (const o of origins) if (loc === o || loc.startsWith(o + "/") || loc.startsWith(o + "?")) return prefix + loc.slice(o.length) || prefix + "/";
  return pre(loc, prefix);
}

/** A Link header (preload hints): each <url> that is root-absolute gets the prefix. @param {string} link @param {string} prefix @param {string[]} origins */
export function rewriteLink(link, prefix, origins) {
  return link.replace(/<([^>]*)>/g, (_m, u) => `<${rewriteLocation(u, prefix, origins)}>`);
}

/**
 * The script that makes what the app's JavaScript builds at run time land under the prefix: fetch, XMLHttpRequest, EventSource, WebSocket, history, window.open and the src, href and action the app
 * sets on its elements. A root-absolute string gets the prefix; nothing else is touched.
 * @param {string} prefix
 */
export function shimSource(prefix) {
  return `(() => {
  "use strict";
  const P = ${JSON.stringify(prefix)};
  const fix = u => (typeof u === "string" && u[0] === "/" && u[1] !== "/" && u[1] !== "\\\\" && u !== P && !u.startsWith(P + "/") ? P + u : u);
  const fixAny = u => { try { if (u instanceof URL) return u; if (typeof u === "string") return fix(u); if (u && typeof u.url === "string") return u; } catch {} return u; };
  const f0 = window.fetch; if (f0) window.fetch = function (input, init) { if (typeof input === "string") input = fix(input); else if (input instanceof Request && input.url.startsWith(location.origin + "/") ) { const p = input.url.slice(location.origin.length); if (!(p === P || p.startsWith(P + "/"))) input = new Request(location.origin + P + p, input); } return f0.call(this, input, init); };
  const o0 = XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open = function (m, u, ...r) { return o0.call(this, m, fixAny(u), ...r); };
  if (window.EventSource) { const E = window.EventSource; window.EventSource = function (u, c) { return new E(fix(u), c); }; window.EventSource.prototype = E.prototype; }
  if (window.WebSocket) { const W = window.WebSocket; window.WebSocket = function (u, p) { try { const x = new URL(u, location.href); if (x.host === location.host && !(x.pathname === P || x.pathname.startsWith(P + "/"))) x.pathname = P + x.pathname; return p === undefined ? new W(x.href) : new W(x.href, p); } catch { return new W(u, p); } }; window.WebSocket.prototype = W.prototype; Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }); }
  for (const k of ["pushState", "replaceState"]) { const h0 = history[k]; history[k] = function (s, t, u) { return h0.call(this, s, t, u == null ? u : fix(String(u))); }; }
  const w0 = window.open; window.open = function (u, ...r) { return w0.call(this, typeof u === "string" ? fix(u) : u, ...r); };
  const sa = Element.prototype.setAttribute; Element.prototype.setAttribute = function (n, v) { if (typeof v === "string" && /^(src|href|action|poster|formaction)$/i.test(n)) v = fix(v); return sa.call(this, n, v); };
  const prop = (C, name) => { const d = Object.getOwnPropertyDescriptor(C.prototype, name); if (d && d.set) Object.defineProperty(C.prototype, name, { ...d, set(v) { d.set.call(this, typeof v === "string" ? fix(v) : v); } }); };
  for (const [C, ns] of [[HTMLScriptElement, ["src"]], [HTMLLinkElement, ["href"]], [HTMLImageElement, ["src"]], [HTMLAnchorElement, ["href"]], [HTMLFormElement, ["action"]], [HTMLIFrameElement, ["src"]], [HTMLSourceElement, ["src"]], [HTMLMediaElement, ["src"]]]) for (const n of ns) prop(C, n);
})();
`;
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
 * @param {string} origin @param {string} method @param {string} path @param {Record<string, string>} headers
 * @param {{ body?: NodeJS.ReadableStream | Buffer | string | null, timeoutMs?: number }} [o]
 * @returns {Promise<http.IncomingMessage>}
 */
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
const readAll = (/** @type {http.IncomingMessage} */ res, cap = MAX_REWRITE) => new Promise((resolve, reject) => { const c = /** @type {Buffer[]} */ ([]); let n = 0; res.on("data", d => { n += d.length; if (n > cap) { res.destroy(new Error("too big")); reject(new Error("too big")); } else c.push(d); }); res.on("end", () => resolve(Buffer.concat(c))); res.on("error", reject); });

/**
 * The proxy. `app(name)` says where an installed, running app is and how to sign in to it; nothing else is ever fetched.
 * @param {{ isPerson: (caller: string) => boolean, app: (name: string) => Promise<null | { origin: string, origins: string[], login: null | { path: string, token: string, fields: Record<string, string>, ok: number[] }, credentials: () => Promise<Record<string, string>> }>, log?: (m: string) => void }} o
 */
export function createProxy(o) {
  const log = o.log || (() => {});
  /** @type {Map<string, Map<string, string>>} the app's own session cookies, one jar per app (kept here, never sent to a browser) */
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

  /** @type {(req: http.IncomingMessage, res: http.ServerResponse, at: { caller: string, url: URL }) => Promise<void>} */
  return async function serve(req, res, { caller, url }) {
    const plain = (/** @type {number} */ code, /** @type {string} */ text) => { res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(text); };
    // A page that is not for you is not there: no word about whether an app exists.
    if (!o.isPerson(caller)) return plain(404, "not found");
    const sp = split(url);
    if (!sp) return plain(404, "not found");
    const prefix = `/m/${sp.name}`;
    const app = await o.app(sp.name);
    if (!app) return plain(404, "not found");
    if (sp.rest === SHIM_PATH) { res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" }); res.end(shimSource(prefix)); return; }
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(String(req.method))) return plain(405, "method not allowed");
    try {
      if (!(await ensure(sp.name, app))) return plain(502, "Vyre could not sign in to the app. Try again in a minute.");
      /** @param {boolean} retry */
      const once = async retry => {
        /** @type {Record<string, string>} */ const h = {};
        for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith("x-vyre-") && typeof v === "string") h[k] = v;
        h["accept-encoding"] = "identity";
        const jar = jars.get(sp.name);
        if (jar && jar.size) h.cookie = cookieHeader(jar);
        h.origin = app.origin; h.referer = app.origin + sp.rest;
        if (req.headers["content-length"]) { if (Number(req.headers["content-length"]) > MAX_BODY) throw Object.assign(new Error("too big"), { code: "too_big" }); h["content-length"] = String(req.headers["content-length"]); }
        if (req.headers["transfer-encoding"]) h["transfer-encoding"] = String(req.headers["transfer-encoding"]);
        const r = await upstream(app.origin, String(req.method), sp.rest, h, { body: ["GET", "HEAD"].includes(String(req.method)) ? null : req });
        // The app lost our session (it restarted, the session expired): sign in again, once, and repeat a request that has no body to repeat.
        if (!retry && app.login && jars.has(sp.name) && String(r.headers.location || "").includes(app.login.path) && ["GET", "HEAD"].includes(String(req.method))) { await readAll(r).catch(() => {}); jars.delete(sp.name); if (!(await ensure(sp.name, app, true))) throw Object.assign(new Error("sign in"), { code: "login" }); return once(true); }
        return r;
      };
      const r = await once(false);
      const jar = jars.get(sp.name) || new Map();
      keepCookies(jar, r.headers["set-cookie"]);
      if (app.login) jars.set(sp.name, jar);
      /** @type {Record<string, string | string[]>} */ const out = {};
      for (const [k, v] of Object.entries(r.headers)) { if (HOP.has(k) || k === "set-cookie" || k === "content-length" || v === undefined) continue; out[k] = /** @type {any} */ (v); }
      if (typeof out.location === "string") out.location = rewriteLocation(out.location, prefix, app.origins);
      if (typeof out.link === "string") out.link = rewriteLink(out.link, prefix, app.origins);
      const type = String(r.headers["content-type"] || "").toLowerCase();
      const body = type.startsWith("text/html") || type.startsWith("text/css");
      if (!body) { res.writeHead(r.statusCode || 502, out); r.pipe(res); return; }
      const text = (await readAll(r)).toString("utf8");
      const rewritten = type.startsWith("text/html") ? rewriteHtml(text, prefix, { origins: app.origins }) : rewriteCss(text, prefix);
      delete out.etag; delete out["last-modified"];
      // The app's own policy would allow only the app's origin's scripts; the shim and the pages are the same origin as Vyre's, which the policy's 'self' already means. Nothing is loosened.
      const b = Buffer.from(rewritten, "utf8");
      res.writeHead(r.statusCode || 502, { ...out, "content-length": String(b.length) });
      res.end(req.method === "HEAD" ? undefined : b);
    } catch (e) {
      const err = /** @type {any} */ (e);
      log(`appmods: ${sp.name} ${req.method} ${sp.rest.slice(0, 80)}: ${err && err.message}`);
      if (res.headersSent) { res.destroy(); return; }
      plain(err && err.code === "too_big" ? 413 : 502, err && err.code === "too_big" ? "too big" : "The app is not answering. It may still be starting.");
    }
  };
}
