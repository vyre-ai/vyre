// @ts-check
// real: the REAL extension, native host and bridge on a throwaway runner, driven by the bench.
//
//   Chrome for Testing + local/hands-chrome-mac/extension (unpacked, its own manifest key)
//     <-native messaging-> native-host/host.js <-socket/pipe-> bridge.js (this process)
//   ExtensionDriver (bench/extension-driver.mjs) -> runScenarios (bench/chrome-bench.mjs)
//
// Prints the same JSON as chrome-bench plus the extension's hello and the stage timings, and one
// human line. Also proves the two things a person relies on: Esc (a stop pushed to the extension)
// halts a running batch within a step, and a blind origin is refused by the extension's own floor.
// Never run this on a person's machine: it launches Chrome and registers a native host.
//
//   node spike/harness/real.mjs [--iters 30] [--out file] [--chrome path] [--headless new|false]

// Chrome here is always launched through launchChrome (spike/harness/lib.mjs), which spreads CHROME_SAFE (lib/chrome-flags).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostManifest, ipcPath, launchChrome, parseArgs, prepareExtension, registerHost, resolveChrome, sleep, stats, stepSummary, stopProcess, wrapperScript } from "./lib.mjs";
import { startFixtureServer } from "../../bench/fixtures/server.mjs";
import { createBridge } from "../../bridge.js";
import { ExtensionDriver } from "../../bench/extension-driver.mjs";
import { runScenarios, humanLine } from "../../bench/chrome-bench.mjs";
import { WORKFLOW_STEPS } from "../../bench/scenarios.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const T0 = performance.now();
const log = (/** @type {string} */ m) => console.error(`[real +${Math.round(performance.now() - T0)}ms] ${m}`);
/** A step that must finish: it rejects after ms instead of holding the job until the runner's own cutoff. @template T @param {Promise<T>} p @param {number} ms @param {string} what @returns {Promise<T>} */
const within = (p, ms, what) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`${what} took longer than ${ms} ms`)), ms); p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); }); });

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const iters = Number(args.iters) || 30;
  const headless = args.headless === "false" ? false : typeof args.headless === "string" ? args.headless : "new";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-real-"));
  const udd = path.join(tmp, "profile");
  fs.mkdirSync(udd);
  /** @type {Record<string, any>} */ const out = { tool: "chrome-real", os: `${process.platform}-${os.arch()}`, node: process.version, headless, stages: {}, at: new Date().toISOString() };
  // Whatever happens, leave what was learned behind before the runner's own cutoff.
  setTimeout(() => {
    out.fatal = out.fatal || "watchdog: still running after 400 s";
    console.log(JSON.stringify(out, null, 2));
    if (typeof args.out === "string") { try { fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true }); fs.writeFileSync(args.out, JSON.stringify(out, null, 2)); } catch { /* best effort */ } }
    process.exit(3);
  }, 400_000).unref();
  const cleanups = /** @type {Array<()=>void>} */ ([]);
  /** @type {any} */ let chromeProc = null; let fixture = null; let bridge = null;
  const stage = async (/** @type {string} */ name, /** @type {()=>Promise<any>} */ fn) => {
    const t = performance.now();
    log(`stage ${name}`);
    try { out.stages[name] = { ok: true, ...(await within(fn(), 120_000, `stage ${name}`)), ms: Math.round(performance.now() - t) }; log(`stage ${name} ok`); return true; }
    catch (e) { log(`stage ${name} FAILED: ${/** @type {Error} */ (e).message}`); out.stages[name] = { ok: false, error: String(/** @type {Error} */ (e).message || e).slice(0, 400), ms: Math.round(performance.now() - t) }; return false; }
  };
  try {
    log("fixture");
    fixture = await startFixtureServer();
    const sockPath = ipcPath();
    bridge = createBridge({ sockPath, timeoutMs: 10_000 });
    log("bridge listen");
    await bridge.listen();
    const ext = prepareExtension(path.join(root, "extension"), path.join(tmp, "extension"));
    out.extensionId = ext.id;
    const wrapper = path.join(tmp, process.platform === "win32" ? "host.bat" : "host.sh");
    fs.writeFileSync(wrapper, wrapperScript({ node: process.execPath, hostJs: path.join(root, "native-host", "host.js"), sock: sockPath, home: tmp }));
    if (process.platform !== "win32") fs.chmodSync(wrapper, 0o755);
    cleanups.push(registerHost({ manifestObj: hostManifest({ wrapper, id: ext.id }), dir: tmp, userDataDir: udd }));

    log("resolve chrome");
    const chrome = resolveChrome({ chrome: typeof args.chrome === "string" ? args.chrome : undefined });
    out.chrome = chrome.version;
    const extra = [`--load-extension=${ext.dir}`, `--disable-extensions-except=${ext.dir}`];
    const launched = launchChrome({ chrome: chrome.path, userDataDir: udd, url: `${fixture.url}/checkout`, extraArgs: extra, headless, env: { VYRE_CHROME_SOCK: sockPath, VYRE_HOME: tmp }, logFile: path.join(tmp, "chrome.log") });
    chromeProc = launched.child;
    log("chrome launched");

    const hello = await stage("hello", async () => {
      const end = Date.now() + 45_000;
      while (!bridge.connected()) { if (Date.now() > end) throw new Error("the real extension never said hello"); await sleep(100); }
      const h = bridge.info();
      return { protocol: h && h.protocol, version: h && h.version, caps: h && h.caps };
    });

    if (hello) {
      // Every call is logged with its time, so a hang names the op that never came back.
      let calls = 0;
      const traced = { call: async (/** @type {string} */ op, /** @type {any} */ a) => {
        const n = ++calls, t = performance.now();
        if (n <= 40 || n % 50 === 0) log(`> #${n} ${op}`);
        try { const r = await bridge.call(op, a); if (n <= 40 || n % 50 === 0) log(`< #${n} ${op} ${Math.round(performance.now() - t)}ms`); return r; }
        catch (e) { log(`! #${n} ${op} ${/** @type {any} */ (e).code} ${String(/** @type {any} */ (e).message).slice(0, 160)}`); throw e; }
      }, close: () => bridge.close() };
      const driver = new ExtensionDriver(traced);
      log("bench");
      out.bench = await within(runScenarios(driver, { url: fixture.url, iters }), 240_000, "the bench");
      log("bench done");

      await stage("blind_refused", async () => {
        let code = "";
        try { await bridge.call("tabs.open", { url: "chrome://settings/passwords" }); } catch (e) { code = /** @type {any} */ (e).code; }
        if (code !== "blocked") throw new Error(`expected blocked, got ${JSON.stringify(code)}`);
        return { code };
      });

      await stage("stop_halts_batch", async () => {
        const g = await bridge.call("tabs.use", { url: `${fixture.url}/ghl`, openIfMissing: true });
        const steps = [...WORKFLOW_STEPS, ...WORKFLOW_STEPS, ...WORKFLOW_STEPS].map(s => s.op === "click"
          ? { op: "page.act", args: { tabId: g.id, selector: { identifier: (/data-testid="([^"]+)"/.exec(s.selector) || [])[1] }, kind: "click" } }
          : { op: "page.fill", args: { tabId: g.id, fields: [{ selector: { identifier: s.selector.replace(/^#/, "") }, value: s.value }] } });
        const tRun = performance.now();
        const run = bridge.call("batch.run", { steps, asked: true });
        await sleep(30);
        const t0 = performance.now();
        await bridge.push({ event: "stop" });
        const r = await run;
        const stoppedMs = Math.round(performance.now() - t0);
        await bridge.push({ event: "resume" });
        if (r.ok !== false || r.code !== "stopped") throw new Error("the batch was not halted by stop: " + JSON.stringify({ ok: r.ok, code: r.code, done: r.done }));
        return { stoppedMs, haltMsAfterStopArrived: r.haltMs, doneBeforeStop: r.done, of: steps.length, batchTotalMs: Math.round(performance.now() - tRun) };
      });

      await stage("held_submit", async () => {
        const c = await bridge.call("tabs.use", { url: `${fixture.url}/checkout`, openIfMissing: true });
        const r = await bridge.call("page.act", { tabId: c.id, selector: { identifier: "place-order" }, kind: "click" });
        if (!r.held || !r.sig) throw new Error("the order button was not held: " + JSON.stringify(r).slice(0, 200));
        return { held: true, fieldsShown: Object.keys(r.fields || {}).length };
      });
    }
  } catch (e) {
    out.fatal = String(/** @type {Error} */ (e).message || e);
    try { out.chromeLogTail = fs.readFileSync(path.join(tmp, "chrome.log"), "utf8").slice(-1500); } catch { /* no log */ }
  } finally {
    log("cleanup");
    stopProcess(chromeProc);
    for (const c of cleanups) try { c(); } catch { /* best effort */ }
    await within(Promise.resolve(bridge?.close()), 5000, "closing the bridge").catch(e => log(String(e.message)));
    await within(Promise.resolve(fixture?.close()), 5000, "closing the fixture").catch(e => log(String(e.message)));
    log("cleanup done");
    setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }, 2500).unref();
  }
  const bench = out.bench;
  const failed = Object.entries(out.stages).filter(([, v]) => /** @type {any} */ (v).ok === false).map(([k]) => k);
  const errs = bench ? Object.keys(bench.errors || {}) : ["bench"];
  out.ok = !out.fatal && failed.length === 0 && errs.length === 0;
  const line = bench
    ? `chrome-real ${out.ok ? "PASS" : "FAIL"} ${out.os}: ${humanLine({ mode: "real-extension", os: out.os, chrome: out.chrome, ops: bench.ops, errors: bench.errors })}; stop halts a batch in ${out.stages.stop_halts_batch?.stoppedMs ?? "n/a"} ms${out.ok ? "" : `; failed: ${[...failed, ...errs].join(",")}`}`
    : `chrome-real FAIL ${out.os}: ${out.fatal || "no bench"}`;
  console.log(JSON.stringify(out, null, 2));
  console.log(line);
  stepSummary(`- ${line}`);
  if (typeof args.out === "string") { fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true }); fs.writeFileSync(args.out, JSON.stringify(out, null, 2)); }
  process.exitCode = out.ok ? 0 : 1;
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => setTimeout(() => process.exit(process.exitCode || 0), 3000).unref(), e => { console.error(e); process.exit(1); });
}
