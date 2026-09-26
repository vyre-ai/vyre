// @ts-check
// vyred — the one process per machine that runs every Vyre service.
//
// It opens the store, starts the modules this machine's role calls for, and serves the API on
// a unix socket in VYRE_HOME. Surfaces, the Harness hooks and the CLI all talk to it here and
// nowhere else. Networking over Tailscale is layered on later by the names module; the socket
// is always the local way in and never leaves the machine.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as config from "../config/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { Registry, discover } from "../modules/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..");
export const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;

/** Where modules come from: Vyre's own folders first, then whatever the user installed. */
export function moduleRoots(root) {
  return [path.join(REPO, "core"), path.join(REPO, "local"), path.join(REPO, "modules"), config.paths(root).modules];
}

/**
 * Start vyred. Returns a handle with the running registry and a stop() for tests.
 * @param {{ root?: string, log?: (m: string, x?: any) => void, rules?: any }} [opts]
 */
export async function start(opts = {}) {
  const root = opts.root || config.home();
  const p = config.ensure(root);
  const cfg = config.load(root);
  const logFile = path.join(p.logs, new Date().toISOString().slice(0, 10) + ".log");
  const log = opts.log || ((msg, extra) => {
    const line = `${new Date().toISOString()} ${msg}${extra ? " " + JSON.stringify(extra) : ""}\n`;
    try { fs.appendFileSync(logFile, line); } catch {}
  });
  for (const problem of cfg.problems) log("config: " + problem);

  const db = open(p.db);
  const events = new Events(db);
  const registry = new Registry({ db, events, config: cfg, paths: p, log, rules: opts.rules });
  await registry.start(discover(moduleRoots(root)), { role: cfg.role, ...cfg.modules });

  // A stale socket from a crash would make listen() fail with EADDRINUSE. If nothing answers on
  // it, it is safe to remove; if something does, another vyred is running and this one stops.
  if (fs.existsSync(p.socket)) {
    const alive = await ping(p.socket);
    if (alive) { await registry.stop(); db.close(); throw new Error(`vyred is already running (${p.socket})`); }
    fs.rmSync(p.socket, { force: true });
  }

  const started = Date.now();
  /** Open event streams, closed on stop so server.close() is not held open by them. */
  const streams = new Set();
  const server = http.createServer((req, res) => route(req, res, { registry, events, cfg, started, streams }).catch(e => {
    send(res, 500, { error: { code: "internal", message: e.message } });
  }));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(p.socket, () => resolve(undefined)); });
  fs.chmodSync(p.socket, 0o600);
  fs.writeFileSync(p.pid, String(process.pid));
  log(`vyred ${VERSION} up · role ${cfg.role} · ${registry.status().filter(m => m.state === "running").length} modules`);

  let stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true;
    for (const end of streams) end();
    await new Promise(r => server.close(() => r(undefined)));
    await registry.stop();
    db.close();
    fs.rmSync(p.socket, { force: true });
    try { if (fs.readFileSync(p.pid, "utf8") === String(process.pid)) fs.rmSync(p.pid, { force: true }); } catch {}
    log("vyred down");
  };
  return { registry, events, config: cfg, paths: p, stop };
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 5_000_000) throw new Error("request too large"); }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error("request body is not JSON"); }
}

async function route(req, res, { registry, events, cfg, started, streams }) {
  const url = new URL(req.url || "/", "http://vyred");
  // The caller is the client's own claim, except that no client may claim to be a module: only
  // the loader can say that, and a module caller is what internal tools such as vault.release
  // trust. Anything on the socket posing as "module:x" is treated as a plain local client.
  const claimed = String(req.headers["x-vyre-caller"] || "local");
  // A header is a claim, not an identity. "module:<name>" is what the registry uses between
  // modules, and "hook" is what the webhook route sets itself; neither may be claimed over HTTP.
  const caller = claimed.startsWith("module:") || claimed === "hook" ? "local" : claimed;
  if (req.method === "GET" && url.pathname === "/v1/health") {
    const mods = registry.status();
    // last_event lets a surface follow the stream from now: `since=0` would replay the whole
    // log, and a guessed cursor past the end drops every live event.
    const last = /** @type {any} */ (events.db.prepare("SELECT MAX(id) AS id FROM events").get());
    return send(res, 200, { data: { version: VERSION, pid: process.pid, role: cfg.role, uptime: Date.now() - started, last_event: Number(last && last.id) || 0,
      modules: { running: mods.filter(m => m.state === "running").length, failed: mods.filter(m => ["failed", "invalid"].includes(m.state)).length } } });
  }
  if (req.method === "GET" && url.pathname === "/v1/modules") return send(res, 200, { data: registry.status() });
  if (req.method === "GET" && url.pathname === "/v1/tools") return send(res, 200, { data: registry.listTools(caller) });
  if (req.method === "POST" && url.pathname.startsWith("/v1/tools/")) {
    const name = decodeURIComponent(url.pathname.slice("/v1/tools/".length));
    const result = await registry.call(name, await body(req), caller);
    const status = !result.error ? 200 : result.error.code === "no_such_tool" ? 404 : result.error.code === "denied" ? 403 : result.error.code === "bad_input" ? 400 : 500;
    return send(res, status, result);
  }
  // Webhooks: POST /v1/<module>/<name>/hook reaches that module's hook tool (watchers.hook) with
  // the name, the token from x-vyre-token or ?token=, and the JSON body. The tool checks the token.
  const hook = req.method === "POST" && /^\/v1\/([a-z][a-z0-9-]*)\/([^/]+)\/hook$/.exec(url.pathname);
  if (hook) {
    const token = String(req.headers["x-vyre-token"] || url.searchParams.get("token") || "");
    let payload;
    try { payload = await body(req); } catch (e) { return send(res, 400, { error: { code: "bad_input", message: /** @type {Error} */ (e).message } }); }
    const result = await registry.call(`${hook[1]}.hook`, { name: decodeURIComponent(hook[2]), token, body: payload }, "hook");
    return send(res, result.error ? (result.error.code === "no_such_tool" ? 404 : 403) : 202, result);
  }
  if (req.method === "GET" && url.pathname === "/v1/events") {
    return send(res, 200, { data: events.since(Number(url.searchParams.get("since") || 0), {
      type: url.searchParams.get("type"), project: url.searchParams.get("project"), limit: Math.min(1000, Number(url.searchParams.get("limit") || 200)) }) });
  }
  if (req.method === "GET" && url.pathname === "/v1/events/stream") return stream(req, res, url, events, streams);
  if (req.method === "GET" && !url.pathname.startsWith("/v1/")) return serveDeck(res, url.pathname);
  return send(res, 404, { error: { code: "not_found", message: `${req.method} ${url.pathname}` } });
}

/**
 * Live events as server-sent events: everything after `since` first (so a surface that was
 * away catches up without a gap), then each new event as it happens. `type` filters the same way
 * as events.on: "thread.started", "thread.*" or "*". The SSE id is the event id, so a browser's
 * EventSource resumes from Last-Event-ID on its own.
 */
function stream(req, res, url, events, streams) {
  const type = url.searchParams.get("type") || "*";
  // since=latest skips the backlog: a surface that renders current state from tools only needs
  // what happens next, and replaying a long log to reach "now" is wasted work.
  const sinceParam = url.searchParams.get("since");
  const latest = !req.headers["last-event-id"] && sinceParam === "latest";
  const lastId = latest ? events.latestId() : Number(req.headers["last-event-id"] || sinceParam || 0);
  const match = type === "*" ? () => true : type.endsWith(".*") ? e => e.type.startsWith(type.slice(0, -1)) : e => e.type === type;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  const write = e => res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  let cursor = lastId;
  // Backlog in pages, then live. Anything emitted while paging is caught by the cursor check.
  for (;;) {
    const page = events.since(cursor, { limit: 500 });
    for (const e of page) { cursor = e.id; if (match(e)) write(e); }
    if (page.length < 500) break;
  }
  const off = events.on(type, e => { if (e.id > cursor) { cursor = e.id; write(e); } });
  const beat = setInterval(() => res.write(": beat\n\n"), 15_000);
  const end = () => { off(); clearInterval(beat); streams.delete(end); res.end(); };
  streams.add(end);
  req.on("close", end);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

/**
 * The Deck: static files from deck/ in the repo (the deck workstream builds them). Paths that
 * are not files get index.html, so the Deck can route on the client. Nothing outside deck/ is
 * ever served, whatever the path says.
 */
function serveDeck(res, pathname) {
  const dir = path.join(REPO, "deck");
  let file = path.resolve(dir, "." + path.posix.normalize(decodeURIComponent(pathname)));
  if (!file.startsWith(dir + path.sep) && file !== dir) return send(res, 404, { error: { code: "not_found", message: pathname } });
  try { if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html"); } catch { file = path.join(dir, "index.html"); }
  let buf;
  try { buf = fs.readFileSync(file); } catch { return send(res, 404, { error: { code: "no_deck", message: "the Deck is not built on this machine" } }); }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache",
    "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'" });
  res.end(buf);
}

/** Does anything answer on this socket? */
export function ping(socket, timeout = 1500) {
  return new Promise(resolve => {
    const req = http.request({ socketPath: socket, path: "/v1/health", method: "GET", timeout }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}
