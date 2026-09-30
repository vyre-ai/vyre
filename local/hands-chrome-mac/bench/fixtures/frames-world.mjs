// @ts-check
// frames-world: the fixture that matches how GoHighLevel really renders. One http server answers several
// *.localhost hostnames (Chrome resolves them to loopback and treats each as its own SITE, so with
// --site-per-process each is its own process):
//
//   a.localhost  SHELL   left nav + top bar; embeds the app, a same-origin frame, a sandboxed help panel,
//                        a ticker (navigates), and adds a live-chat frame 1.5 s after load
//   b.localhost  APP     the Workflows list + builder, in an iframe of the shell; blank until the shell posts
//                        {type:"auth", token}; then calls its OWN API (/api/...) with Authorization: Bearer
//   c.localhost  WIDGETS the email editor nested in the app, the late chat, the ticker, the sandboxed help
//   d.localhost  a fresh origin nothing talks to: /collect is where a script that leaks page data would send it
//
// State lives in the server and is read at /__state on any host: workflows created through the iframe app's
// API, test messages "sent", editor saves, ticker acks, what reached d.localhost, request counts.
// Sample world only (Harlow Legal, Northwind Bakery, alex, juno, kit).
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const FRAME_TOKEN = "fixture-token-123";
/** The shell's path as GoHighLevel spells it: a sub-account, then the section. */
export const SHELL_PATH = "/v2/location/HarlowLoc0001/automation/workflows";
export const SITES = { shell: "a.localhost", app: "b.localhost", widgets: "c.localhost", fresh: "d.localhost" };

const here = new URL("./", import.meta.url);
const page = (/** @type {string} */ name) => fs.readFileSync(fileURLToPath(new URL(name, here)), "utf8");

/** @param {import("node:http").ServerResponse} res @param {number} status @param {unknown} body @param {Record<string,string>} [headers] */
function json(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", ...headers });
  res.end(JSON.stringify(body));
}
/** @param {import("node:http").ServerResponse} res @param {string} html */
function html(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}
/** @param {import("node:http").IncomingMessage} req @returns {Promise<any>} */
const readJson = req => new Promise((resolve, reject) => {
  /** @type {Buffer[]} */ const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(e); } });
  req.on("error", reject);
});

const NAMES = ["alex", "juno", "kit", "riley", "sam", "morgan"];
const CONTACTS = NAMES.map((n, i) => ({ id: `ct_${i}`, name: `${n} Sample`, email: `${n}${i}@example.com` }));

/** Small pages for the widget frames, each says who it is and has a control with a name of its own. @param {string} title @param {string} body */
const small = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:13px system-ui,sans-serif;margin:6px}</style></head><body>${body}</body></html>`;

export function createFramesWorld() {
  /** @type {Map<string, any>} */
  const workflows = new Map();
  const state = {
    sent: /** @type {any[]} */ ([]),
    editorSaves: /** @type {any[]} */ ([]),
    acks: /** @type {number[]} */ ([]),
    collected: /** @type {any[]} */ ([]),
    api: { ok: 0, denied: 0 },
    hits: /** @type {Record<string, number>} */ ({}),
  };

  /** The hostname (no port) of a request, lower-case. @param {import("node:http").IncomingMessage} req */
  const hostnameOf = req => String(req.headers.host || "").split(":")[0].toLowerCase();
  const portOf = (/** @type {import("node:http").IncomingMessage} */ req) => String(req.headers.host || "").split(":")[1] || "80";
  const isFrameHost = (/** @type {string} */ h) => Object.values(SITES).includes(h);

  /** The JSON /__state serves. */
  const snapshot = () => ({ workflows: [...workflows.values()], sent: state.sent, editorSaves: state.editorSaves, acks: state.acks, collected: state.collected, api: state.api, hits: state.hits });

  /**
   * Answer a request if it is ours: /__state on any host, or anything on one of the four site hostnames.
   * @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res @returns {boolean}
   */
  function handle(req, res) {
    const host = hostnameOf(req);
    const url = new URL(req.url || "/", "http://x");
    const p = url.pathname;
    if (p === "/__state" && (req.method === "GET" || req.method === "HEAD")) { json(res, 200, { data: snapshot() }); return true; }
    if (!isFrameHost(host)) return false;
    const port = portOf(req);
    const o = (/** @type {string} */ h) => `http://${h}:${port}`;
    const key = `${host}${p}`;
    state.hits[key] = (state.hits[key] || 0) + 1;

    if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS" }); res.end(); return true; }

    // ---- site A: the shell and a same-origin frame
    if (host === SITES.shell) {
      // "/" and the path GoHighLevel really uses for a sub-account: /v2/location/<id>/<section>, so the shell's URL reads as GHL's does.
      if (req.method === "GET" && (p === "/" || p === "/shell" || /^\/v2\/location\/[A-Za-z0-9]{10,40}(\/|$)/.test(p))) {
        // Query flags (slow, whatsnew, guard, stale, toast) go through to the app; nothing else does.
        const keep = new URLSearchParams();
        for (const k of ["slow", "whatsnew", "guard", "stale", "toast"]) if (url.searchParams.has(k)) keep.set(k, String(url.searchParams.get(k)));
        const q = keep.toString() ? `?${keep}` : "";
        html(res, page("ghl-shell.html").replaceAll("{{APP}}", o(SITES.app)).replaceAll("{{C}}", o(SITES.widgets)).replaceAll("{{APPPATH}}", /\/contacts\/?$/.test(p) ? "/contacts" : "/automation/workflows").replaceAll("{{QUERY}}", q).replaceAll("{{TOKEN}}", FRAME_TOKEN));
        return true;
      }
      // A page whose origin runs a service worker with a fetch handler (many apps do), and a page under a strict CSP: a guarded eval must still run on both, and still hold an exfiltration.
      if (req.method === "GET" && p === "/sw-page") {
        html(res, `<!doctype html><html><head><meta charset="utf-8"><title>SW page</title></head><body><h1 id="h">service worker page</h1><script>
          navigator.serviceWorker.register('/sw.js').then(function () { return navigator.serviceWorker.ready; }).then(function () { if (navigator.serviceWorker.controller) document.title = 'SW controlled'; else navigator.serviceWorker.addEventListener('controllerchange', function () { document.title = 'SW controlled'; }); });
        </script></body></html>`);
        return true;
      }
      if (req.method === "GET" && p === "/sw.js") {
        // Answers every same-origin GET and every cross-origin GET through the worker's own fetch, and a /sw-cached path from its cache without the network.
        res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
        res.end(`self.addEventListener('install', function () { self.skipWaiting(); });
          self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
          self.addEventListener('fetch', function (e) {
            var u = new URL(e.request.url);
            if (u.pathname.indexOf('/sw-cached') === 0) { e.respondWith(new Response('cached', { status: 200 })); return; }
            e.respondWith(fetch(e.request));
          });`);
        return true;
      }
      if (req.method === "GET" && p === "/csp-page") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'none'" });
        res.end('<!doctype html><html><head><meta charset="utf-8"><title>CSP page</title></head><body><h1>strict csp page</h1></body></html>');
        return true;
      }
      if (req.method === "GET" && p === "/same-origin-frame") {
        html(res, small("notifications", `<p>Notifications</p><button type="button" data-testid="mark-read" id="mark-read">Mark all read</button>`));
        return true;
      }
    }

    // ---- site B: the app
    if (host === SITES.app) {
      if (req.method === "GET" && (p === "/automation/workflows" || p === "/contacts" || p === "/")) {
        html(res, page("ghl-app.html").replaceAll("{{SHELL}}", o(SITES.shell)).replaceAll("{{C}}", o(SITES.widgets)));
        return true;
      }
      if (p.startsWith("/api/")) {
        const authed = req.headers.authorization === `Bearer ${FRAME_TOKEN}`;
        if (!authed) { state.api.denied++; json(res, 401, { error: "unauthorized" }); return true; }
        state.api.ok++;
        if (req.method === "GET" && p === "/api/contacts") { json(res, 200, { data: CONTACTS }); return true; }
        if (p === "/api/workflows" && req.method === "GET") { json(res, 200, { data: [...workflows.values()] }); return true; }
        if (p === "/api/workflows" && req.method === "POST") {
          readJson(req).then(body => {
            const id = `wf_${crypto.randomBytes(5).toString("hex")}`;
            const wf = { id, name: String(body.name || ""), trigger: body.trigger ?? null, actions: Array.isArray(body.actions) ? body.actions : [], status: body.status === "published" ? "published" : "draft" };
            workflows.set(id, wf);
            json(res, 201, { data: wf });
          }, () => json(res, 400, { error: "bad json" }));
          return true;
        }
        const one = /^\/api\/workflows\/([\w-]+)$/.exec(p);
        if (one && req.method === "GET") { const w = workflows.get(one[1]); if (w) json(res, 200, { data: w }); else json(res, 404, { error: "not found" }); return true; }
        if (one && req.method === "PUT") {
          const w = workflows.get(one[1]);
          if (!w) { json(res, 404, { error: "not found" }); return true; }
          readJson(req).then(body => {
            Object.assign(w, { name: String(body.name ?? w.name), trigger: body.trigger ?? w.trigger, actions: Array.isArray(body.actions) ? body.actions : w.actions, status: body.status === "published" ? "published" : "draft" });
            json(res, 200, { data: w });
          }, () => json(res, 400, { error: "bad json" }));
          return true;
        }
        if (p === "/api/conversations/messages" && req.method === "POST") {
          readJson(req).then(body => { const m = { to: String(body.to || ""), subject: String(body.subject || "") }; state.sent.push(m); json(res, 201, { data: { id: `msg_${state.sent.length}`, ...m } }); }, () => json(res, 400, { error: "bad json" }));
          return true;
        }
        json(res, 404, { error: "no such route" });
        return true;
      }
    }

    // ---- site C: the widgets
    if (host === SITES.widgets && req.method === "GET") {
      // A page that, the moment it runs, sends a request to the address in ?to= (the neutralize check: a frame the guard could not reach must never get to run this).
      if (p === "/beacon-page") {
        html(res, `<!doctype html><html><head><title>beacon page</title></head><body>beacon<script>try { fetch(${JSON.stringify(url.searchParams.get("to") || "")}, { mode: "no-cors" }); new Image().src = ${JSON.stringify(url.searchParams.get("to") || "")} + "img"; } catch (e) {}</script></body></html>`);
        return true;
      }
      if (p === "/email-editor") {
        html(res, small("email editor", `<label>Email editor body <input id="editor-body" data-testid="editor-body"></label> <button type="button" id="editor-save" data-testid="editor-save">Save design</button> <span id="editor-status" role="status"></span>
<script>document.getElementById('editor-save').addEventListener('click', function () { var v = document.getElementById('editor-body').value; fetch('/api/editor/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: v }) }).then(function () { document.getElementById('editor-status').textContent = 'Design saved'; }); });</script>`));
        return true;
      }
      if (p === "/late") {
        html(res, small("live chat", `<button type="button" id="open-chat" data-testid="open-chat">Open chat widget</button>`));
        return true;
      }
      if (p === "/sandboxed") {
        html(res, small("help center", `<h3>Help center</h3><button type="button" id="contact-support" data-testid="contact-support">Contact support</button>`));
        return true;
      }
      if (p === "/ticker") {
        const n = Number(url.searchParams.get("n")) || 1;
        const body = small(`ticker ${n}`, `<span>Ticker ${n}</span> <button type="button" id="ticker-ack" data-testid="ticker-ack-${n}">Ticker ${n === 1 ? "one" : "two"} ack</button>
<script>document.getElementById('ticker-ack').addEventListener('click', function () { fetch('/api/ticker/ack?n=${n}', { method: 'POST' }); });</script>`);
        // The second page is slow, so the frame is mid-navigation for a moment.
        if (n === 2) setTimeout(() => html(res, body), 400); else html(res, body);
        return true;
      }
    }
    if (host === SITES.widgets && req.method === "POST") {
      if (p === "/api/editor/save") { readJson(req).then(b => { state.editorSaves.push({ body: String(b.body ?? "") }); json(res, 200, { data: { saved: true } }); }, () => json(res, 400, { error: "bad json" })); return true; }
      if (p === "/api/ticker/ack") { state.acks.push(Number(url.searchParams.get("n")) || 0); json(res, 200, { data: { ok: true } }); return true; }
    }

    // ---- site D: where a leak would go
    if (host === SITES.fresh && p.startsWith("/collect")) {
      state.collected.push({ method: req.method, path: p, d: String(url.searchParams.get("d") || "").slice(0, 200) });
      json(res, 200, { data: { ok: true } });
      return true;
    }

    json(res, 404, { error: "not found" });
    return true;
  }

  return { handle, snapshot, workflows };
}
