// @ts-check
// run: the proof harness for deep Chrome control (ADR 0049). On a throwaway runner it launches
// Chrome for Testing with an unpacked MV3 extension in a temp user-data-dir, registers a native
// messaging host for that profile, and measures the full path:
//
//   this process <-unix socket / named pipe-> host.js <-native messaging stdio-> extension worker
//                                                        |-chrome.debugger-> fixture tab
//
// Stages (each recorded ok/fail with timings): ipc_server, host_loopback (host relay alone, no
// Chrome), chrome_launch, sw_hello (worker started AND connectNative reached the host and the
// socket), tab_present, attach (cost of one attach, fresh and repeated), eval (Runtime.evaluate
// answer is right), ping_latency and eval_latency (p50/p95 over --calls, default 200).
//
//   node run.mjs [--extension <dir>] [--host <dir>] [--profile spike|real] [--out file]
//                [--calls 200] [--timeout 45000] [--chrome <path>] [--headless new|false] [--diag] [--keep]
//
// --extension / --host point at the real extension and host later (--profile real maps the ops
// to tabs.list and page.eval). --diag adds a remote debugging port so a failed run can report the
// worker's own log. Never run this on a person's machine: it launches Chrome and registers a host.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  Cdp, Deframer, frame, hostManifest, ipcPath, launchChrome, parseArgs, prepareExtension, readDevToolsPort,
  registerHost, resolveChrome, sleep, stats, stepSummary, stopProcess, wrapperScript, HOST_NAME,
} from "./lib.mjs";
import { startFixtureServer } from "../../bench/fixtures/server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const spikeDir = path.resolve(here, "..");

/** Op mapping per profile: the spike's own ops, or the real extension's. */
export const PROFILES = {
  spike: {
    ping: () => ({ op: "ping", args: {} }),
    eval: (/** @type {string} */ expression, /** @type {string} */ urlPrefix) => ({ op: "eval", args: { expression, urlPrefix } }),
    attach: (/** @type {string} */ urlPrefix) => ({ op: "attach", args: { urlPrefix } }),
    detach: (/** @type {string} */ urlPrefix) => ({ op: "detach", args: { urlPrefix } }),
    tabs: () => ({ op: "tabs", args: {} }),
  },
  real: {
    ping: () => ({ op: "tabs.list", args: {} }),
    eval: (/** @type {string} */ expression) => ({ op: "page.eval", args: { expression } }),
    attach: null, detach: null,
    tabs: () => ({ op: "tabs.list", args: {} }),
  },
};

/** The socket side: talks to whichever host process Chrome (or the loopback stage) spawned. @param {string} sockPath */
function startIpc(sockPath) {
  /** @type {Map<number,{resolve:Function,reject:Function,timer:any}>} */ const pending = new Map();
  /** @type {any[]} */ const events = [];
  /** @type {net.Socket|null} */ let ext = null;
  let nextId = 1;
  /** @type {Array<()=>void>} */ const helloWaiters = [];
  const server = net.createServer(conn => {
    const rd = new Deframer();
    conn.on("data", d => {
      let msgs;
      try { msgs = rd.push(d); } catch { conn.destroy(); return; }
      for (const m of msgs) {
        if (m.loop) { conn.write(frame({ id: m.id, loop: true, ok: true })); continue; }
        if (m.event) { events.push(m); if (m.event === "hello") { ext = conn; helloWaiters.splice(0).forEach(f => f()); } continue; }
        const p = pending.get(m.id);
        if (p) { clearTimeout(p.timer); pending.delete(m.id); m.ok ? p.resolve(m.result) : p.reject(new Error(`${m.error?.code}: ${m.error?.message}`)); }
      }
    });
    conn.on("error", () => {});
    conn.on("close", () => { if (ext === conn) ext = null; });
  });
  return {
    events,
    listen: () => new Promise((resolve, reject) => { server.once("error", reject); server.listen(sockPath, () => { if (process.platform !== "win32") fs.chmodSync(sockPath, 0o600); resolve(undefined); }); }),
    waitHello: (/** @type {number} */ ms) => new Promise((resolve, reject) => {
      if (ext) return resolve(undefined);
      const t = setTimeout(() => reject(new Error(`no hello from the extension within ${ms} ms`)), ms);
      helloWaiters.push(() => { clearTimeout(t); resolve(undefined); });
    }),
    /** @param {{op:string,args:any}} req @param {number} [ms] */
    request(req, ms = 15_000) {
      if (!ext) return Promise.reject(new Error("extension not connected"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${req.op}`)); }, ms);
        pending.set(id, { resolve, reject, timer });
        /** @type {net.Socket} */ (ext).write(frame({ id, ...req }));
      });
    },
    close: () => new Promise(r => { server.close(() => r(undefined)); server.closeAllConnections?.(); setTimeout(r, 500).unref(); }),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profileName = args.profile === "real" ? "real" : "spike";
  const P = PROFILES[profileName];
  const calls = Number(args.calls) || 200;
  const helloTimeout = Number(args.timeout) || 45_000;
  const extSrc = path.resolve(typeof args.extension === "string" ? args.extension : path.join(spikeDir, "extension"));
  const hostDir = path.resolve(typeof args.host === "string" ? args.host : path.join(spikeDir, "host"));
  const hostJs = path.join(hostDir, "host.js");
  const headless = args.headless === "false" ? false : typeof args.headless === "string" ? args.headless : "new";

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-spike-"));
  const udd = path.join(tmp, "profile");
  fs.mkdirSync(udd);
  /** @type {Record<string, any>} */ const stages = {};
  const result = { tool: "chrome-spike", profile: profileName, os: `${process.platform}-${os.arch()}`, node: process.version, headless, chrome: "", extensionId: "", stages, at: new Date().toISOString(), diag: /** @type {any} */ (null) };
  const cleanups = [];
  /** @type {any} */ let chromeProc = null;
  let fixture = null; let ipc = null;
  const stage = async (/** @type {string} */ name, /** @type {()=>Promise<any>} */ fn) => {
    const t = performance.now();
    try { stages[name] = { ok: true, ...(await fn()), ms: Math.round((performance.now() - t) * 10) / 10 }; return true; }
    catch (e) { stages[name] = { ok: false, error: String(/** @type {Error} */ (e).message || e), ms: Math.round(performance.now() - t) }; return false; }
  };

  try {
    fixture = await startFixtureServer();
    const fixtureUrl = `${fixture.url}/checkout`;
    const sockPath = ipcPath();
    ipc = startIpc(sockPath);
    if (!await stage("ipc_server", async () => { await ipc.listen(); return { sock: process.platform === "win32" ? "named pipe" : "unix socket" }; })) throw new Error("ipc failed");

    const ext = prepareExtension(extSrc, path.join(tmp, "extension"));
    result.extensionId = ext.id;
    const wrapper = path.join(tmp, process.platform === "win32" ? "host.bat" : "host.sh");
    fs.writeFileSync(wrapper, wrapperScript({ node: process.execPath, hostJs, sock: sockPath, home: tmp }));
    if (process.platform !== "win32") fs.chmodSync(wrapper, 0o755);
    cleanups.push(registerHost({ manifestObj: hostManifest({ wrapper, id: ext.id }), dir: tmp, userDataDir: udd }));

    // The host relay alone: a byte pipe between a stdio pair and the socket, no Chrome involved.
    await stage("host_loopback", async () => {
      const child = spawn(process.platform === "win32" ? `"${wrapper}"` : wrapper, [], { stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32", windowsHide: true });
      const rd = new Deframer();
      /** @type {Map<string,Function>} */ const waiting = new Map();
      child.stdout.on("data", d => { for (const m of rd.push(d)) { const f = waiting.get(m.id); if (f) { waiting.delete(m.id); f(); } } });
      let stderr = ""; child.stderr.on("data", d => { stderr += d; });
      const rt = (/** @type {string} */ id) => new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("loopback timeout; host stderr: " + stderr.slice(-300))), 10_000);
        waiting.set(id, () => { clearTimeout(t); resolve(undefined); });
        child.stdin.write(frame({ id, loop: true, op: "loop" }));
      });
      try {
        await rt("warm");
        /** @type {number[]} */ const s = [];
        for (let i = 0; i < calls; i++) { const t = performance.now(); await rt("L" + i); s.push(performance.now() - t); }
        return { latency: stats(s) };
      } finally { child.stdin.end(); stopProcess(child); }
    });

    const chrome = resolveChrome({ chrome: typeof args.chrome === "string" ? args.chrome : undefined });
    result.chrome = chrome.version;
    stages.chrome_install = { ok: true, ms: chrome.installMs, version: chrome.version };

    const extraArgs = [`--load-extension=${ext.dir}`, `--disable-extensions-except=${ext.dir}`];
    if (args.diag) extraArgs.push("--remote-debugging-port=0");
    const launched = launchChrome({ chrome: chrome.path, userDataDir: udd, url: fixtureUrl, extraArgs, headless, env: { VYRE_CHROME_SOCK: sockPath, VYRE_HOME: tmp }, logFile: path.join(tmp, "chrome.log") });
    chromeProc = launched.child;
    const early = new Promise((_, reject) => launched.child.once("exit", code => reject(new Error(`Chrome exited early (code ${code})`))));
    early.catch(() => {}); // rejects again at teardown, after the race is over; that must not crash us
    stages.chrome_launch = { ok: true, args: launched.args.filter(a => !a.startsWith("--user-data-dir")).map(a => a.replace(tmp, "<tmp>")) };

    const helloAt = performance.now();
    const gotHello = await stage("sw_hello", async () => {
      await Promise.race([ipc.waitHello(helloTimeout), early]);
      const h = ipc.events.find(e => e.event === "hello");
      return { ua: h?.ua, headlessUa: /HeadlessChrome/.test(h?.ua || ""), sinceLaunchMs: Math.round(performance.now() - helloAt) };
    });

    if (gotHello) {
      await stage("tab_present", async () => {
        const end = Date.now() + 15_000;
        for (;;) {
          const tabs = await ipc.request(P.tabs());
          const hit = (Array.isArray(tabs) ? tabs : []).find((/** @type {any} */ t) => String(t.url).startsWith(fixture.url));
          if (hit) return { url: hit.url, title: hit.title };
          if (Date.now() > end) throw new Error("fixture tab never appeared: " + JSON.stringify(tabs));
          await sleep(200);
        }
      });

      if (P.attach && P.detach) {
        await stage("attach", async () => {
          const first = await ipc.request(P.attach(fixture.url));
          /** @type {number[]} */ const host = [], sw = [], swEnable = [];
          for (let i = 0; i < 10; i++) {
            await ipc.request(P.detach(fixture.url));
            const t = performance.now();
            const r = await ipc.request(P.attach(fixture.url));
            host.push(performance.now() - t); sw.push(r.attachMs); swEnable.push(r.attachPlusEnableMs);
          }
          return { first: { attachMs: first.attachMs, attachPlusEnableMs: first.attachPlusEnableMs }, hostRoundTrip: stats(host), attachInWorker: stats(sw), attachPlusEnableInWorker: stats(swEnable) };
        });
      }

      await stage("eval", async () => {
        const v = await ipc.request(P.eval("document.querySelectorAll('#checkout input, #checkout select').length", fixture.url));
        if (v !== 12) throw new Error(`expected 12 form controls, got ${JSON.stringify(v)}`);
        return { value: v };
      });

      await stage("ping_latency", async () => {
        for (let i = 0; i < 10; i++) await ipc.request(P.ping());
        /** @type {number[]} */ const s = [];
        for (let i = 0; i < calls; i++) { const t = performance.now(); await ipc.request(P.ping()); s.push(performance.now() - t); }
        return { latency: stats(s) };
      });

      await stage("eval_latency", async () => {
        for (let i = 0; i < 10; i++) await ipc.request(P.eval("1+1", fixture.url));
        /** @type {number[]} */ const s = [];
        for (let i = 0; i < calls; i++) { const t = performance.now(); await ipc.request(P.eval("document.title", fixture.url)); s.push(performance.now() - t); }
        return { latency: stats(s) };
      });
    } else {
      result.diag = args.diag ? await collectDiag(udd) : {};
      try { result.diag.chromeLogTail = fs.readFileSync(path.join(tmp, "chrome.log"), "utf8").slice(-1500); } catch { /* no log */ }
    }
  } catch (e) {
    result.diag = result.diag || {};
    result.diag.fatal = String(/** @type {Error} */ (e).message || e);
  } finally {
    stopProcess(chromeProc);
    for (const c of cleanups) try { c(); } catch { /* best effort */ }
    await ipc?.close();
    await fixture?.close();
    if (!args.keep) setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }, 2500).unref();
  }

  const ok = Object.values(stages).every(s => s.ok !== false);
  const line = summaryLine(result, ok);
  console.log(JSON.stringify({ ...result, ok }, null, 2));
  console.log(line);
  stepSummary(`- ${line}`);
  if (typeof args.out === "string") { fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true }); fs.writeFileSync(args.out, JSON.stringify({ ...result, ok }, null, 2)); }
  process.exitCode = ok ? 0 : 1;
}

/** With --diag: what the worker itself logged, read over CDP from its target. @param {string} udd */
async function collectDiag(udd) {
  try {
    const { port } = await readDevToolsPort(udd, 5000);
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const targets = list.map((/** @type {any} */ t) => ({ type: t.type, url: String(t.url).slice(0, 80) }));
    const sw = list.find((/** @type {any} */ t) => t.type === "service_worker" && String(t.url).startsWith("chrome-extension://"));
    let worker = null;
    if (sw) {
      const c = await Cdp.connect(sw.webSocketDebuggerUrl);
      const r = await c.send("Runtime.evaluate", { expression: "JSON.stringify(globalThis.__spike || null)", returnByValue: true });
      worker = r.result?.value ? JSON.parse(r.result.value) : null;
      c.close();
    }
    return { targets, serviceWorkerFound: Boolean(sw), worker };
  } catch (e) { return { diagError: String(/** @type {Error} */ (e).message || e) }; }
}

/** @param {any} r @param {boolean} ok */
export function summaryLine(r, ok) {
  const s = r.stages;
  const lat = (/** @type {string} */ k) => (s[k]?.latency ? `${s[k].latency.p50}/${s[k].latency.p95}` : "n/a");
  const att = s.attach?.hostRoundTrip ? `${s.attach.hostRoundTrip.p50} ms` : "n/a";
  return `chrome-spike ${ok ? "PASS" : "FAIL"} ${r.os} chrome ${r.chrome} headless=${r.headless}: hello ${s.sw_hello?.ok ? `${s.sw_hello.sinceLaunchMs} ms` : "NO"}, attach p50 ${att}, ping p50/p95 ${lat("ping_latency")} ms, eval p50/p95 ${lat("eval_latency")} ms, host relay only p50/p95 ${lat("host_loopback")} ms${ok ? "" : `; failed: ${Object.entries(s).filter(([, v]) => v.ok === false).map(([k, v]) => `${k} (${String(v.error).slice(0, 80)})`).join("; ")}`}`;
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => setTimeout(() => process.exit(process.exitCode || 0), 3000).unref(), e => { console.error(e); process.exit(1); });
}
