// @ts-check
// The fallback pairing page: http://<the server>/setup. The person pastes the code the app shows and chooses Pair.
// vyred listens on 8080 (it runs as uid 1000 and cannot bind port 80). The box publishes host port 80 to that.
// The code arrives in the POST body, never in the query string, and the page locks for good once pairing has finished.

import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tokens = JSON.parse(readFileSync(fileURLToPath(new URL("../../lib/theme/tokens.json", import.meta.url)), "utf8"));
const paper = tokens.color.paper;
const font = tokens.font;

const css = `:root{--bg:${paper.bg};--panel:${paper.panel};--text:${paper.text};--text2:${paper.text2};--rule:${paper.rule};--primary:${paper.primaryBg};--ink:${paper.primaryInk};--sans:${font.sans},sans-serif;--mono:${font.mono},monospace}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);font-weight:${font.weight.regular}}main{max-width:32rem;margin:0 auto;padding:3rem 1.25rem}h1{font-size:1.75rem;line-height:2.125rem;font-weight:${font.weight.strong};margin:0 0 0.75rem}p{color:var(--text2);font-size:0.95rem;line-height:1.45rem}form{background:var(--panel);border:1px solid var(--rule);padding:1.25rem;margin-top:1.5rem}label{display:block;font-size:0.8rem;margin-bottom:0.4rem}textarea{width:100%;min-height:7rem;font-family:var(--mono);font-size:0.8rem;padding:0.6rem;border:1px solid var(--rule);background:var(--bg);color:var(--text)}button{margin-top:0.9rem;background:var(--primary);color:var(--ink);border:0;font-family:var(--sans);font-weight:${font.weight.strong};padding:0.55rem 1rem;cursor:pointer}.err{color:var(--text)}`;

const page = (/** @type {{ locked?: boolean, error?: string, hidePaste?: boolean }} */ o) => {
  const lead = o.locked ? "Pairing is finished. This page stays closed." : o.hidePaste ? "The install line is pairing this server. Nothing to paste." : "Paste the code from the Vyre app, then choose Pair.";
  const form = o.locked || o.hidePaste ? "" : `<form method="post" action="/setup"><label for="code">Code</label><textarea id="code" name="code" autocomplete="off" spellcheck="false"></textarea><button type="submit">Pair</button></form>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair this server</title><style>${css}</style></head><body><main><h1>${o.locked ? "This server is paired" : "Pair this server"}</h1><p>${lead}</p>${o.error ? `<p class="err">${escapeText(o.error)}</p>` : ""}${form}</main></body></html>`;
};

/** @param {string} s */
function escapeText(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c] || c)); }

/** @param {Buffer} body */
function codeFromBody(body) {
  const text = body.toString("utf8");
  const params = new URLSearchParams(text);
  const fromForm = params.get("code");
  if (fromForm) return fromForm.trim();
  try { const j = JSON.parse(text); if (j && typeof j.code === "string") return j.code.trim(); } catch { /* a form */ }
  return "";
}

/** A browser form post comes from this page: its Origin names this host, and it is not marked cross-site. A call with no Origin (a command line, a test) is not a browser and is let through to the code check. @param {import("node:http").IncomingMessage} req */
function sameOrigin(req) {
  if (String(req.headers["sec-fetch-site"] || "") === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try { return new URL(String(origin)).host === String(req.headers.host || ""); } catch { return false; }
}

const TRIES = 10;
const TRY_WINDOW_MS = 60_000;

/**
 * @param {{ redeem: (code: string) => Promise<unknown>, locked: () => boolean, hidePaste?: () => boolean, stopWhenPaired?: boolean, now?: () => number }} o
 * `stopWhenPaired`: once a response says the server is paired, the page stops listening. Ten tries a minute, then it answers 429 until the minute is up.
 */
export function createSetupPage(o) {
  /** @type {import("node:http").Server | null} */ let server = null;
  const now = o.now || Date.now;
  /** @type {number[]} */ let tries = [];
  const closeSoon = () => { if (o.stopWhenPaired) setImmediate(() => { void stop(); }); };
  async function stop() { if (!server) return; const s = server; server = null; await new Promise(r => { s.close(() => r(undefined)); s.closeIdleConnections?.(); }); }
  /**
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   */
  function handle(req, res) {
    const url = new URL(req.url || "/", "http://setup.local");
    if (url.pathname !== "/setup" && url.pathname !== "/") { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found"); return; }
    const hidePaste = () => Boolean(o.hidePaste && o.hidePaste());
    if (req.method === "GET" || req.method === "HEAD") {
      const locked = o.locked();
      res.writeHead(locked ? 403 : 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(req.method === "HEAD" ? "" : page({ locked, hidePaste: hidePaste() }));
      if (locked) closeSoon();
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/setup") { res.writeHead(405, { "content-type": "text/plain; charset=utf-8" }); res.end("Use the page."); return; }
    if (url.searchParams.has("code")) { res.writeHead(400, { "content-type": "text/html; charset=utf-8" }); res.end(page({ hidePaste: hidePaste(), error: "Paste the code into the box. It does not belong in the address." })); return; }
    if (o.locked()) { res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(page({ locked: true })); closeSoon(); return; }
    if (!sameOrigin(req)) { res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(page({ hidePaste: hidePaste(), error: "Use this page itself to pair, not a form on another site." })); return; }
    const at = now();
    tries = tries.filter(t => at - t < TRY_WINDOW_MS);
    if (tries.length >= TRIES) { res.writeHead(429, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "retry-after": "60" }); res.end(page({ hidePaste: hidePaste(), error: "Too many tries. Wait a minute and paste the code again." })); return; }
    tries.push(at);
    const chunks = [];
    let size = 0;
    req.on("data", (/** @type {Buffer} */ c) => { size += c.length; if (size > 4096) req.destroy(); else chunks.push(c); });
    req.on("end", async () => {
      const code = codeFromBody(Buffer.concat(chunks));
      try {
        await o.redeem(code);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(page({ locked: true }));
        closeSoon();
      } catch (e) {
        const err = /** @type {any} */ (e);
        const locked = err && err.code === "locked" || o.locked();
        res.writeHead(locked ? 403 : 400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(page({ locked, hidePaste: hidePaste(), error: locked ? "" : String(err && err.message || "That code was not accepted. Make a new install line in the Vyre app.") }));
        if (locked) closeSoon();
      }
    });
  }
  return {
    handle,
    /** Listen only when the box asks for the page. Port 0 picks a free port for tests. @param {{ port?: number, host?: string }} [opt] */
    start(opt = {}) {
      if (server) return server;
      server = http.createServer(handle);
      server.listen(opt.port ?? 8080, opt.host ?? "0.0.0.0");
      return server;
    },
    stop,
    /** Whether the page is listening. */
    get listening() { return server !== null; },
    /** The address the page listens on, or null. */
    address() { return server ? server.address() : null; },
  };
}
