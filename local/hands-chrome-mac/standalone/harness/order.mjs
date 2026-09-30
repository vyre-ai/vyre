// @ts-check
// order: the fresh-install ORDER problem, on a real Chrome (real-use finding 2: "the extension never connected until Chrome was restarted").
// The extension, the native host manifest and the server can each appear before or after Chrome starts. This measures how long each
// order takes to connect, reads the extension's own connection record through its service worker, and says whether Chrome needed a restart.
//
//   A  registered, then Chrome, then the server           the tidy order (must connect)
//   B  registered, Chrome running with the extension, the server starts LATE   (the user's order; must connect)
//   C  Chrome running with the extension and the server, the connector registered AFTERWARDS (the folder did not exist at start)
//      -> connects by itself? If not, does a restart fix it? (reported, never failed: this is the question)
//
// Throwaway runners only. Never run this on a person's machine.
//   node standalone/harness/order.mjs [--out file] [--chrome path]

// Chrome here is always launched through launchChrome (spike/harness/lib.mjs), which spreads CHROME_SAFE (lib/chrome-flags).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { hostManifest, launchChrome, parseArgs, prepareExtension, registerHost, resolveChrome, sleep, stepSummary, stopProcess, readDevToolsPort, Cdp } from "../../spike/harness/lib.mjs";
import { build } from "../build-release.mjs";

const T0 = performance.now();
const log = (/** @type {string} */ m) => console.error(`[order +${Math.round(performance.now() - T0)}ms] ${m}`);
const args = parseArgs(process.argv.slice(2));
const out = /** @type {Record<string, any>} */ ({ tool: "chrome-order", os: `${process.platform}-${os.arch()}`, node: process.version, at: new Date().toISOString(), scenarios: {} });
setTimeout(() => { out.fatal = out.fatal || "watchdog: still running after 540 s"; console.log(JSON.stringify(out, null, 2)); if (typeof args.out === "string") try { fs.writeFileSync(args.out, JSON.stringify(out, null, 2)); } catch { /* best effort */ } process.exit(3); }, 540_000).unref();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-order-"));
const rel = build({ out: path.join(tmp, "release") });
const home = path.join(tmp, "home"); fs.mkdirSync(home);
const data = path.join(tmp, "data");
const env = { ...process.env, HOME: home, USERPROFILE: home, VYRE_CHROME_HOME: data };
const inst = spawnSync(process.execPath, [path.join(rel.dir, "standalone", "cli.mjs"), "install", "--browsers", "chrome", "--no-wait"], { env, encoding: "utf8" });
if (inst.status !== 0) { out.fatal = `install failed: ${inst.stderr}`; console.log(JSON.stringify(out, null, 2)); process.exit(1); }
const app = path.join(data, "app");
const cli = path.join(app, "standalone", "cli.mjs");
const chrome = resolveChrome({ chrome: typeof args.chrome === "string" ? args.chrome : undefined });
out.chrome = chrome.version;
const launcher = path.join(app, "native-host", process.platform === "win32" ? "run-host.cmd" : "run-host.sh");

/** A minimal MCP client. @param {import("node:child_process").ChildProcess} child */
function mcp(child) {
  let n = 0, buf = ""; const waiting = new Map(); /** @type {any} */ const c = child;
  c.stdout.on("data", (/** @type {any} */ d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch { /* not ours */ } } });
  const rpc = (/** @type {string} */ method, /** @type {any} */ params) => new Promise(res => { const id = ++n; waiting.set(id, res); c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); setTimeout(() => res({ error: { message: "timeout" } }), 8000).unref(); });
  return { status: async () => { const r = /** @type {any} */ (await rpc("tools/call", { name: "chrome_status", arguments: {} })); try { return JSON.parse(r.result.content[0].text); } catch { return null; } }, init: () => rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} }) };
}

/** Everything for one scenario in its own profile. */
async function run(/** @type {string} */ name, /** @type {(w: any) => Promise<void>} */ body) {
  log(`scenario ${name}`);
  const dir = path.join(tmp, name); fs.mkdirSync(dir);
  const udd = path.join(dir, "profile"); fs.mkdirSync(udd);
  const ext = prepareExtension(path.join(app, "extension"), path.join(dir, "extension"));
  const t0 = performance.now();
  const s = /** @type {Record<string, any>} */ ({ events: [] });
  const mark = (/** @type {string} */ e) => { s.events.push({ e, atMs: Math.round(performance.now() - t0) }); log(`${name}: ${e}`); };
  /** @type {any} */ let chromeProc = null, server = null, client = null;
  const w = {
    mark, s, ext, udd,
    register: () => { registerHost({ manifestObj: hostManifest({ wrapper: launcher, id: ext.id }), dir, userDataDir: udd }); mark("host manifest written"); },
    startChrome: async () => {
      const l = launchChrome({ chrome: chrome.path, userDataDir: udd, url: "about:blank", extraArgs: [`--load-extension=${ext.dir}`, `--disable-extensions-except=${ext.dir}`, "--remote-debugging-port=0"], logFile: path.join(dir, "chrome.log") });
      chromeProc = l.child; mark("chrome started");
    },
    stopChrome: async () => { stopProcess(chromeProc); chromeProc = null; await sleep(1500); mark("chrome stopped"); },
    startServer: async () => {
      server = spawn(process.execPath, [cli, "mcp"], { env, stdio: ["pipe", "pipe", "ignore"] }); client = mcp(server); await client.init(); mark("server started");
    },
    connected: async () => { const st = client ? await client.status() : null; return { connected: st && st.connected === true, st }; },
    /** The extension's own record, read from its service worker, or null. */
    record: async () => {
      let cdp;
      try {
        const { port, wsPath } = await readDevToolsPort(udd, 5000);
        cdp = await Cdp.connect(`ws://127.0.0.1:${port}${wsPath}`);
        const { targetInfos } = await cdp.send("Target.getTargets");
        const sw = targetInfos.find((/** @type {any} */ t) => t.type === "service_worker" && String(t.url).includes(ext.id));
        if (!sw) return { serviceWorker: "not running (Chrome stops an idle worker; the alarm wakes it)" };
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
        const r = await cdp.send("Runtime.evaluate", { expression: "chrome.storage.session.get('vyre.conn')", awaitPromise: true, returnByValue: true }, sessionId);
        return r && r.result && r.result.value && r.result.value["vyre.conn"] || { serviceWorker: "running", record: null };
      } catch (e) { return { error: String(/** @type {Error} */ (e).message).slice(0, 120) }; } finally { try { cdp && cdp.close(); } catch { /* gone */ } }
    },
    /** Wait until connected or the time is up; returns the seconds it took, or null. */
    until: async (/** @type {number} */ secs) => { const t = performance.now(); while (performance.now() - t < secs * 1000) { const c = await w.connected(); if (c.connected) { const sec = +((performance.now() - t) / 1000).toFixed(1); mark(`connected after ${sec} s`); return sec; } await sleep(1000); } mark(`not connected after ${secs} s`); return null; },
  };
  try { await body(w); s.ok = true; }
  catch (e) { s.ok = false; s.error = String(/** @type {Error} */ (e).message); }
  finally { stopProcess(chromeProc); try { server && server.kill(); } catch { /* gone */ } out.scenarios[name] = s; }
}

await run("A_registered_then_chrome_then_server", async w => {
  w.register(); await w.startChrome(); await sleep(3000); await w.startServer();
  const sec = await w.until(60); w.s.secondsToConnect = sec;
  if (sec === null) throw new Error("the tidy order did not connect");
});

await run("B_chrome_running_server_starts_late", async w => {
  w.register(); await w.startChrome();
  await sleep(20_000); // the extension has been trying, and failing, for 20 s: the host runs but no server listens
  w.s.recordBeforeServer = await w.record();
  await w.startServer();
  const sec = await w.until(90); w.s.secondsToConnectAfterServer = sec;
  if (sec === null) throw new Error("a server started after Chrome never connected");
});

await run("C_connector_registered_after_chrome_started", async w => {
  await w.startChrome(); await w.startServer();
  await sleep(20_000);
  w.s.recordBeforeRegister = await w.record();
  w.s.diagnosisBeforeRegister = (await w.connected()).st && { stage: (await w.connected()).st.stage, problem: (await w.connected()).st.problem };
  w.register();
  const sec = await w.until(120); w.s.secondsToConnectWithoutRestart = sec;
  w.s.needsRestart = sec === null;
  if (sec === null) {
    w.s.recordStillFailing = await w.record();
    await w.stopChrome(); await w.startChrome();
    w.s.secondsToConnectAfterRestart = await w.until(60);
  }
});

const failed = Object.entries(out.scenarios).filter(([k, v]) => /** @type {any} */ (v).ok === false && !k.startsWith("C_")).map(([k]) => k);
out.ok = failed.length === 0;
const c = out.scenarios.C_connector_registered_after_chrome_started || {};
const line = `chrome-order ${out.ok ? "PASS" : "FAIL"} ${out.os}: tidy ${out.scenarios.A_registered_then_chrome_then_server?.secondsToConnect ?? "n/a"} s, server-late ${out.scenarios.B_chrome_running_server_starts_late?.secondsToConnectAfterServer ?? "n/a"} s, registered-after-Chrome: ${c.needsRestart === undefined ? "n/a" : c.needsRestart ? `NEEDED A RESTART (after restart ${c.secondsToConnectAfterRestart ?? "n/a"} s)` : `connected by itself in ${c.secondsToConnectWithoutRestart} s`}`;
console.log(JSON.stringify(out, null, 2)); console.log(line); stepSummary(`- ${line}`);
if (typeof args.out === "string") { fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true }); fs.writeFileSync(args.out, JSON.stringify(out, null, 2)); }
setTimeout(() => { try { spawnSync("chmod", ["-R", "u+rwX", tmp]); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } process.exit(out.ok ? 0 : 1); }, 500);
