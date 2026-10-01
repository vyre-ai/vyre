// AR-S2: does the artifact sandbox hold in a real browser? This is the harness's server. It stands in
// for Vyre's origin: it sets a session cookie, holds a "Vyre API" that counts who calls it, serves a
// Deck stand-in that frames an artifact with sandbox="allow-scripts" (what the Deck does), and serves
// the hostile artifact with the REAL page headers from core/artifacts/render.js. The hostile page
// tries to read the cookie, local and session storage and IndexedDB, reach the parent's document and
// location, navigate the top window, and call out by fetch, XHR, beacon, image, script, stylesheet,
// frame, form, WebSocket, import() and window.open. Every one must fail: the page reports what it
// saw, and the server reports who got through. Runs only on a runner (see the artifact-sandbox
// workflow), never on a person's Mac.

import http from "node:http";
import { page, pageHeaders } from "../render.js";

export const SECRET_COOKIE = "vyre_session=S3CRET-COOKIE";
export const LAX_COOKIE = "vyre_lax=S3CRET-LAX";
export const SECRET_STORAGE = "S3CRET-STORAGE";

/** The hostile artifact's script: each attack passes when it throws, returns nothing secret or is blocked. */
const HOSTILE = String.raw`
(async () => {
  const MODE = new URLSearchParams(location.search).get("mode") || "framed";
  const PORT = location.port;
  const out = [];
  const SECRETS = ["S3CRET-COOKIE", "S3CRET-LAX", "S3CRET-STORAGE", "S3CRET-GLOBAL"];
  const leaks = v => { try { const s = typeof v === "string" ? v : JSON.stringify(v); return SECRETS.some(x => s && s.includes(x)); } catch { return false; } };
  // An attack is blocked when it throws, is refused, or returns nothing secret.
  const attack = async (name, fn) => {
    try { const v = await Promise.race([Promise.resolve().then(fn), new Promise(r => setTimeout(() => r("__timeout__"), 3000))]); out.push({ name, ok: !leaks(v), detail: leaks(v) ? "LEAKED " + String(v).slice(0, 60) : v === undefined ? "returned nothing" : "returned " + String(v).slice(0, 40) }); }
    catch (e) { out.push({ name, ok: true, detail: "blocked: " + (e && e.name || "error") }); }
  };
  // Opaque origin: the page is not first party, framed or at the top level.
  out.push({ name: "self.origin is the opaque origin", ok: self.origin === "null", detail: String(self.origin) });
  await attack("read document.cookie", () => document.cookie);
  await attack("write document.cookie", () => { document.cookie = "planted=1; path=/"; return document.cookie; });
  await attack("read localStorage", () => localStorage.getItem("vyre_token"));
  await attack("write localStorage", () => { localStorage.setItem("planted", "1"); return "wrote"; }).then(() => { const last = out[out.length - 1]; if (last.detail === "returned wrote") { last.ok = false; last.detail = "WROTE to localStorage"; } });
  await attack("read sessionStorage", () => sessionStorage.getItem("vyre_token"));
  await attack("open IndexedDB", () => new Promise((res, rej) => { const r = indexedDB.open("vyre"); r.onsuccess = () => rej(new Error("opened")); r.onerror = () => res("blocked"); r.onblocked = () => res("blocked"); }).then(v => v, e => { throw e; }));
  const last = out[out.length - 1]; if (last && last.name === "open IndexedDB" && /opened/.test(last.detail)) last.ok = false;
  if (MODE === "framed") {
    await attack("read parent.document", () => parent.document.cookie);
    await attack("read parent.localStorage", () => parent.localStorage.getItem("vyre_token"));
    await attack("read parent's global", () => parent.vyreSecret);
    await attack("read parent.location", () => parent.location.href);
    await attack("read top.document", () => top.document.title);
    await attack("navigate the top window", () => { top.location.href = "/hijack?via=top"; return "navigated"; }).then(() => {});
    await attack("navigate the parent", () => { parent.location = "/hijack?via=parent"; return "navigated"; }).then(() => {});
  }
  const sink = u => u + "?via=";
  await attack("fetch the Vyre API with cookies", () => fetch(sink("/v1/api/secret") + "fetch", { credentials: "include" }).then(r => r.text()));
  await attack("fetch another origin", () => fetch("http://localhost:" + PORT + sink("/v1/beacon") + "crossorigin", { mode: "no-cors" }).then(r => "status " + r.status));
  await attack("XMLHttpRequest", () => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open("GET", sink("/v1/api/secret") + "xhr"); x.onload = () => res(x.responseText); x.onerror = () => rej(new Error("blocked")); x.send(); }));
  await attack("sendBeacon", () => { if (navigator.sendBeacon(sink("/v1/beacon") + "beacon", "x")) return "queued"; throw new Error("refused"); });
  await attack("WebSocket", () => new Promise((res, rej) => { const w = new WebSocket("ws://127.0.0.1:" + PORT + sink("/v1/beacon") + "ws"); w.onopen = () => res("open"); w.onerror = () => rej(new Error("blocked")); setTimeout(() => rej(new Error("blocked")), 1500); }));
  await attack("import()", () => import(sink("/v1/beacon") + "import"));
  await attack("window.open", () => { const w = window.open(sink("/v1/beacon") + "open"); if (w) return "opened"; throw new Error("blocked"); });
  const tag = (name, make) => attack(name, () => new Promise(res => { const el = make(); document.body.appendChild(el); setTimeout(() => res("tried"), 800); }));
  await tag("img src", () => { const i = new Image(); i.src = sink("/v1/beacon") + "img"; return i; });
  await tag("script src", () => { const s = document.createElement("script"); s.src = sink("/v1/beacon") + "script"; return s; });
  await tag("stylesheet", () => { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = sink("/v1/beacon") + "css"; return l; });
  await tag("iframe src", () => { const f = document.createElement("iframe"); f.src = sink("/v1/beacon") + "iframe"; return f; });
  await attack("popup by an anchor with target=_blank", () => new Promise(res => { const a = document.createElement("a"); a.href = sink("/v1/beacon") + "blank"; a.target = "_blank"; document.body.appendChild(a); a.click(); setTimeout(() => res("clicked"), 800); }));
  await attack("download by an anchor with the download attribute", () => new Promise(res => { const a = document.createElement("a"); a.href = sink("/v1/beacon") + "download"; a.download = "x.json"; document.body.appendChild(a); a.click(); setTimeout(() => res("clicked"), 800); }));
  await attack("popup by form target=_blank", () => new Promise(res => { const f = document.createElement("form"); f.action = sink("/v1/api/secret") + "formblank"; f.method = "post"; f.target = "_blank"; document.body.appendChild(f); try { f.submit(); } catch {} setTimeout(() => res("tried"), 800); }));
  await tag("form submit", () => { const f = document.createElement("form"); f.action = sink("/v1/api/secret") + "form"; f.method = "post"; setTimeout(() => { try { f.submit(); } catch {} }, 50); return f; });
  await tag("object data", () => { const o = document.createElement("object"); o.data = sink("/v1/beacon") + "object"; return o; });
  await tag("css url()", () => { const d = document.createElement("div"); d.style.cssText = "width:9px;height:9px;background:url('" + sink("/v1/beacon") + "cssurl')"; return d; });
  const payload = { mode: MODE, ua: navigator.userAgent, results: out };
  if (MODE === "framed") parent.postMessage({ vyreProof: payload }, "*");
  else {
    const pre = document.createElement("pre"); pre.id = "results"; pre.textContent = JSON.stringify(payload); document.body.appendChild(pre);
    // A browser with no WebDriver (the iOS simulator, headless Chrome) reads the result by the page navigating itself
    // to the collector, which the sandbox allows and the CSP does not forbid: it carries results, not data out.
    if (new URLSearchParams(location.search).get("report") === "nav") location.href = "/topreport?d=" + btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, "-").replace(/\//g, "_");
  }
})();
`;

/** The hostile artifact as Vyre serves it: the author's HTML, under pageHeaders(). */
export function hostilePage(variant = "main") {
  // main: the full attack. navmeta and navloc: a page that navigates ITSELF away (a meta refresh, a script):
  // the sandbox allows a frame to navigate itself and no header forbids it (the Deck blanks a frame that
  // loads twice), so the server is reached; what must hold is that no cookie goes with it and the
  // response is unreadable.
  // Each carries 8 KB in its address, standing for anything the page holds: what arrives is what leaves.
  const D = "x".repeat(8000);
  const body = variant === "navmeta" ? `<meta http-equiv="refresh" content="0;url=/v1/beacon?via=navmeta&d=${D}"><p>moving</p>`
    : variant === "navloc" ? `<p>moving</p><script>location.href = '/v1/beacon?via=navloc&d=${D}';</script>`
    : variant === "navext" ? `<p>moving</p><script>location.href = 'http://localhost:' + location.port + '/v1/beacon?via=navext&d=${D}';</script>`
    : `<h1>Hostile artifact</h1><script>${HOSTILE}</script>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Hostile</title></head><body>${body}</body></html>`;
  const p = page({ title: "Hostile", format: "html", files: { "index.html": html } });
  return { body: p.html, headers: pageHeaders({ scripts: p.scripts, framedBy: "self" }) };
}

/**
 * The negative control: the same kind of page with the sandbox OFF (no CSP, allow-same-origin). It must
 * reach the server and read the cookie, so a zero count from the hostile page means "blocked", not
 * "unreachable".
 */
function controlPage() {
  return `<!doctype html><html><body><script>
  (async () => {
    const out = {};
    try { out.cookie = document.cookie; } catch (e) { out.cookie = "threw " + e.name; }
    try { out.storage = localStorage.getItem("vyre_token"); } catch (e) { out.storage = "threw " + e.name; }
    try { out.fetch = (await (await fetch("/v1/api/secret?via=ctlfetch", { credentials: "include" })).json()).secret; } catch (e) { out.fetch = "threw " + e.name; }
    new Image().src = "/v1/beacon?via=ctlimg";
    try { navigator.sendBeacon("/v1/beacon?via=ctlbeacon", "x"); } catch {}
    await new Promise(r => setTimeout(r, 800));
    parent.postMessage({ vyreControl: out }, "*");
  })();
  </script></body></html>`;
}

/** The Deck stand-in: first-party, with secrets in its cookie, storage and globals, framing the artifact. */
function deckPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Deck</title></head><body>
<h1>Deck stand-in</h1>
<script>
  localStorage.setItem("vyre_token", "${SECRET_STORAGE}");
  sessionStorage.setItem("vyre_token", "${SECRET_STORAGE}");
  window.vyreSecret = "S3CRET-GLOBAL";
</script>
<iframe id="f" sandbox="allow-scripts" src="/a/hostile?mode=framed" style="width:340px;height:300px"></iframe>
<iframe id="c" sandbox="allow-scripts allow-same-origin" src="/a/control" style="width:200px;height:80px"></iframe>
<script>
  const f = document.getElementById("f"), c = document.getElementById("c"), framed = []; let control = null;
  let sent = false;
  async function finish(note) {
    if (sent) return; sent = true;
    const outer = [];
    try { void f.contentDocument.title; outer.push({ name: "outer reads the frame's document", ok: false, detail: "READ IT" }); } catch (e) { outer.push({ name: "outer reads the frame's document", ok: true, detail: "blocked: " + e.name }); }
    outer.push({ name: "the frame cannot plant a cookie", ok: !document.cookie.includes("planted"), detail: "outer cookie: " + document.cookie.replace(/S3CRET[^;]*/, "<secret>") });
    outer.push({ name: "the frame cannot plant localStorage", ok: localStorage.getItem("planted") === null, detail: String(localStorage.getItem("planted")) });
    outer.push({ name: "the deck is still here after the hostile page ran", ok: location.pathname === "/", detail: location.pathname });
    await fetch("/report", { method: "POST", body: JSON.stringify({ ua: navigator.userAgent, note, framed, outer, control }) });
    document.title = "reported";
  }
  addEventListener("message", e => {
    if (e.source === c.contentWindow && e.data && e.data.vyreControl) { control = e.data.vyreControl; return; }
    if (e.source !== f.contentWindow || !e.data || !e.data.vyreProof) return;
    framed.push({ origin: e.origin, ...e.data.vyreProof });
    // The pages that navigate themselves away run after the main attack, each in its own sandboxed frame.
    for (const v of ["navmeta", "navloc", "navext"]) { const n = document.createElement("iframe"); n.sandbox = "allow-scripts"; n.src = "/a/hostile?mode=" + v; document.body.appendChild(n); }
    setTimeout(() => finish("message"), 2500);
  });
  setTimeout(() => finish("timeout"), 25000);
</script></body></html>`;
}

/**
 * @param {{ port?: number, host?: string }} [o]
 * @returns {Promise<{ url: string, port: number, state: any, close: () => Promise<void> }>}
 */
export function startServer({ port = 0, host = "127.0.0.1" } = {}) {
  const state = { hits: /** @type {Record<string, number>} */ ({}), cookies: /** @type {Record<string, string[]>} */ ({}), urls: /** @type {Record<string, { len: number, data: number, host: string }[]>} */ ({}), api: /** @type {{ via: string, cookie: boolean }[]} */ ([]), report: /** @type {any} */ (null), top: /** @type {any} */ (null), served: [] };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://x");
    const via = u.searchParams.get("via");
    state.served.push(req.method + " " + u.pathname + (via ? "?via=" + via : ""));
    if (u.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": [SECRET_COOKIE + "; Path=/; SameSite=Strict", LAX_COOKIE + "; Path=/; SameSite=Lax"], "cache-control": "no-store" });
      return void res.end(deckPage());
    }
    if (u.pathname === "/a/control") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return void res.end(controlPage()); }
    if (u.pathname === "/a/hostile") {
      const mode = u.searchParams.get("mode");
      const h = hostilePage(mode === "navmeta" || mode === "navloc" || mode === "navext" ? mode : "main");
      res.writeHead(200, h.headers);
      return void res.end(h.body);
    }
    if (u.pathname === "/v1/api/secret" || u.pathname === "/v1/beacon" || u.pathname === "/hijack") {
      const key = u.pathname === "/hijack" ? "hijack" : via || "unknown";
      state.hits[key] = (state.hits[key] || 0) + 1;
      (state.urls[key] ||= []).push({ len: (req.url || "").length, data: (u.searchParams.get("d") || "").length, host: String(req.headers.host || "") });
      (state.cookies[key] ||= []).push(String(req.headers.cookie || "").split(";").map(x => x.trim().split("=")[0]).filter(Boolean).join(","));
      if (u.pathname === "/v1/api/secret") state.api.push({ via: key, cookie: /vyre_session/.test(req.headers.cookie || "") });
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      return void res.end(JSON.stringify({ secret: "S3CRET-API" }));
    }
    if (u.pathname === "/report" && req.method === "POST") {
      let b = "";
      req.on("data", c => { b += c; });
      req.on("end", () => { try { state.report = JSON.parse(b); } catch { state.report = { error: "bad report" }; } res.writeHead(204); res.end(); });
      return;
    }
    if (u.pathname === "/topreport") {
      try { state.top = JSON.parse(Buffer.from(String(u.searchParams.get("d")).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); } catch { state.top = { results: [{ name: "the top-level report", ok: false, detail: "unreadable" }] }; }
      res.writeHead(200, { "content-type": "text/plain" });
      return void res.end("ok");
    }
    if (u.pathname === "/state") { res.writeHead(200, { "content-type": "application/json" }); return void res.end(JSON.stringify({ hits: state.hits, cookies: state.cookies, urls: state.urls, api: state.api, report: state.report, top: state.top })); }
    res.writeHead(404); res.end("not found");
  });
  server.on("upgrade", (req, socket) => { const u = new URL(req.url || "/", "http://x"); const via = u.searchParams.get("via") || "ws"; state.hits[via] = (state.hits[via] || 0) + 1; socket.destroy(); });
  return new Promise(resolve => server.listen(port, host, () => {
    const p = /** @type {any} */ (server.address()).port;
    resolve({ url: `http://${host}:${p}`, port: p, state, close: () => new Promise(r => server.close(() => r(undefined))) });
  }));
}
