// @ts-check
// frames (harness): does the extension see INSIDE cross-origin iframes on a real Chrome? The GoHighLevel workflow builder is one
// (real-use finding), so this is the proof that Vyre for Chrome is not blind to it. A shell page on one site embeds an app on another
// site, which embeds a third: three sites, three processes under site isolation, one server answering by hostname (*.localhost).
//
//   node standalone/harness/frames.mjs [--out file] [--chrome path]
//
// Throwaway runners only.
// Chrome here is always launched through launchChrome (spike/harness/lib.mjs), which spreads CHROME_SAFE (lib/chrome-flags).

import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { hostManifest, launchChrome, parseArgs, prepareExtension, registerHost, resolveChrome, sleep, stepSummary, stopProcess } from "../../spike/harness/lib.mjs";
import { build } from "../build-release.mjs";

const args = parseArgs(process.argv.slice(2));
const out = /** @type {Record<string, any>} */ ({ tool: "chrome-frames", os: `${process.platform}-${os.arch()}`, node: process.version, at: new Date().toISOString(), stages: {} });
const log = (/** @type {string} */ m) => console.error(`[frames] ${m}`);
setTimeout(() => { out.fatal = out.fatal || "watchdog"; console.log(JSON.stringify(out, null, 2)); process.exit(3); }, 240_000).unref();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-frames-"));
// One server, three sites by hostname. Each page says who it is, has a control, and (the shell and the app) embeds the next.
const server = http.createServer((req, res) => {
  const host = String(req.headers.host || "").split(":")[0];
  const port = String(req.headers.host || "").split(":")[1];
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  if (host === "a.localhost") res.end(`<!doctype html><title>shell</title><h1>Shell</h1><nav><button id="nav1">Home</button></nav><iframe id="app" src="http://b.localhost:${port}/app" width="800" height="500"></iframe>`);
  else if (host === "b.localhost") res.end(`<!doctype html><title>app</title><h2>Workflows</h2><button id="create">Create Workflow</button><iframe id="inner" src="http://c.localhost:${port}/inner" width="400" height="200"></iframe>`);
  else res.end(`<!doctype html><title>inner</title><input id="q" aria-label="Search box"><button id="go">Go</button>`);
});
await new Promise(r => server.listen(0, "127.0.0.1", () => r(null)));
const port = /** @type {any} */ (server.address()).port;

const rel = build({ out: path.join(tmp, "release") });
const home = path.join(tmp, "home"); fs.mkdirSync(home);
const data = path.join(tmp, "data");
const env = { ...process.env, HOME: home, USERPROFILE: home, VYRE_CHROME_HOME: data };
const inst = spawnSync(process.execPath, [path.join(rel.dir, "standalone", "cli.mjs"), "install", "--browsers", "chrome", "--no-wait"], { env, encoding: "utf8" });
if (inst.status !== 0) { out.fatal = "install failed: " + inst.stderr; console.log(JSON.stringify(out, null, 2)); process.exit(1); }
const app = path.join(data, "app");
const udd = path.join(tmp, "profile"); fs.mkdirSync(udd);
const ext = prepareExtension(path.join(app, "extension"), path.join(tmp, "extension"));
registerHost({ manifestObj: hostManifest({ wrapper: path.join(app, "native-host", process.platform === "win32" ? "run-host.cmd" : "run-host.sh"), id: ext.id }), dir: tmp, userDataDir: udd });
const chrome = resolveChrome({ chrome: typeof args.chrome === "string" ? args.chrome : undefined });
out.chrome = chrome.version;
const l = launchChrome({ chrome: chrome.path, userDataDir: udd, url: "about:blank", extraArgs: [`--load-extension=${ext.dir}`, `--disable-extensions-except=${ext.dir}`, "--site-per-process"], logFile: path.join(tmp, "chrome.log") });

const child = spawn(process.execPath, [path.join(app, "standalone", "cli.mjs"), "mcp"], { env, stdio: ["pipe", "pipe", "ignore"] });
let n = 0, buf = ""; const waiting = new Map();
child.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch { /* not ours */ } } });
const rpc = (/** @type {string} */ method, /** @type {any} */ params) => new Promise(res => { const id = ++n; waiting.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); setTimeout(() => res({ error: { message: "timeout" } }), 30_000).unref(); });
const call = async (/** @type {string} */ name, /** @type {any} */ a = {}) => { const r = /** @type {any} */ (await rpc("tools/call", { name, arguments: a })); if (r.error) throw new Error(r.error.message); const t = r.result.content[0].text; if (r.result.isError) throw new Error(t.slice(0, 400)); try { return JSON.parse(t); } catch { return t; } };
const stage = async (/** @type {string} */ name, /** @type {() => Promise<any>} */ fn) => { log(`stage ${name}`); try { out.stages[name] = { ok: true, ...(await fn()) }; } catch (e) { out.stages[name] = { ok: false, error: String(/** @type {Error} */ (e).message).slice(0, 500) }; } };

/** @type {number|undefined} */ let tab;
try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  await stage("connected", async () => { for (let i = 0; i < 60; i++) { const s = await call("chrome_status"); if (s.connected) return {}; await sleep(500); } throw new Error("never connected"); });
  await stage("open_shell", async () => { const r = await call("chrome_tabs", { action: "open", url: `http://a.localhost:${port}/` }); tab = r.id; await sleep(2500); return { open: r }; });
  await stage("frames_probe", async () => { const r = await call("chrome_frames", { action: "probe", tab }); return { probe: r }; });
  await stage("click_routing", async () => { const r = await call("chrome_frames", { action: "clicktest", tab, frame: "b.localhost", css: "#create" }); return { clicktest: r }; });
  await stage("frames_list", async () => { const r = await call("chrome_frames", { action: "list", tab }); return { list: r }; });
} finally { stopProcess(l.child); try { child.kill(); } catch { /* gone */ } server.close(); }
const p = out.stages.frames_probe;
const rows = p && p.probe && p.probe.frames || [];
out.summary = { frames: rows.length, readable: rows.filter((/** @type {any} */ r) => r.readable).length, titles: rows.map((/** @type {any} */ r) => r.title || null), autoAttach: p && p.probe && p.probe.autoAttach };
out.ok = rows.length === 3 && rows.every((/** @type {any} */ r) => r.readable) && ["shell", "app", "inner"].every(t => rows.some((/** @type {any} */ r) => r.title === t));
const line = `chrome-frames ${out.ok ? "PASS" : "FAIL"} ${out.os}: ${out.summary.frames} frames, ${out.summary.readable} readable, titles ${JSON.stringify(out.summary.titles)}, autoAttach ${JSON.stringify(out.summary.autoAttach)}`;
console.log(JSON.stringify(out, null, 2)); console.log(line); stepSummary(`- ${line}`);
if (typeof args.out === "string") { fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true }); fs.writeFileSync(args.out, JSON.stringify(out, null, 2)); }
setTimeout(() => { try { spawnSync("chmod", ["-R", "u+rwX", tmp]); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } process.exit(out.ok ? 0 : 1); }, 500);
