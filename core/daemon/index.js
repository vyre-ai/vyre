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
  const server = http.createServer((req, res) => route(req, res, { registry, events, cfg, started }).catch(e => {
    send(res, 500, { error: { code: "internal", message: e.message } });
  }));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(p.socket, () => resolve(undefined)); });
  fs.chmodSync(p.socket, 0o600);
  fs.writeFileSync(p.pid, String(process.pid));
  log(`vyred ${VERSION} up · role ${cfg.role} · ${registry.status().filter(m => m.state === "running").length} modules`);

  let stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true;
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

async function route(req, res, { registry, events, cfg, started }) {
  const url = new URL(req.url || "/", "http://vyred");
  const caller = String(req.headers["x-vyre-caller"] || "local");
  if (req.method === "GET" && url.pathname === "/v1/health") {
    const mods = registry.status();
    return send(res, 200, { data: { version: VERSION, pid: process.pid, role: cfg.role, uptime: Date.now() - started,
      modules: { running: mods.filter(m => m.state === "running").length, failed: mods.filter(m => ["failed", "invalid"].includes(m.state)).length } } });
  }
  if (req.method === "GET" && url.pathname === "/v1/modules") return send(res, 200, { data: registry.status() });
  if (req.method === "GET" && url.pathname === "/v1/tools") return send(res, 200, { data: registry.listTools() });
  if (req.method === "POST" && url.pathname.startsWith("/v1/tools/")) {
    const name = decodeURIComponent(url.pathname.slice("/v1/tools/".length));
    const result = await registry.call(name, await body(req), caller);
    const status = !result.error ? 200 : result.error.code === "no_such_tool" ? 404 : result.error.code === "denied" ? 403 : result.error.code === "bad_input" ? 400 : 500;
    return send(res, status, result);
  }
  if (req.method === "GET" && url.pathname === "/v1/events") {
    return send(res, 200, { data: events.since(Number(url.searchParams.get("since") || 0), {
      type: url.searchParams.get("type"), project: url.searchParams.get("project"), limit: Math.min(1000, Number(url.searchParams.get("limit") || 200)) }) });
  }
  return send(res, 404, { error: { code: "not_found", message: `${req.method} ${url.pathname}` } });
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
