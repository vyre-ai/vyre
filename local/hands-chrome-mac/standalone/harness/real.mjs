// @ts-check
// real (standalone): the built vyre-chrome package, an MCP client, and a REAL Chrome with the REAL
// extension and native host, on a throwaway runner. It installs the connector the way a person
// would (cli.mjs install), talks to `cli.mjs mcp` over stdio like Claude Code, and measures:
//   per-call round trip through MCP, a 20-step batch as one call, a whole GoHighLevel-shaped flow
//   against the awkward fixture (slow route, popup, unsaved guard, toast, stale re-render), the
//   Esc halt of a running batch, the held-send path (chrome_send), the blind-page refusal, and
//   that the trace file exists and holds no secret. Never run this on a person's machine.
//
//   node standalone/harness/real.mjs [--iters 30] [--out file] [--chrome path] [--headless new|false]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hostManifest, launchChrome, parseArgs, prepareExtension, registerHost, resolveChrome, sleep, stats, stepSummary, stopProcess } from "../../spike/harness/lib.mjs";
import { startFixtureServer } from "../../bench/fixtures/server.mjs";
import { WORKFLOW_STEPS, GHL_ROBUST, CHECKOUT_FIELDS } from "../../bench/scenarios.mjs";
import { build } from "../build-release.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const T0 = performance.now();
const log = (/** @type {string} */ m) => console.error(`[standalone +${Math.round(performance.now() - T0)}ms] ${m}`);
/** @template T @param {Promise<T>} p @param {number} ms @param {string} what @returns {Promise<T>} */
const within = (p, ms, what) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`${what} took longer than ${ms} ms`)), ms); p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); }); });

/** A minimal MCP client over a child's stdio. @param {import("node:child_process").ChildProcess} child */
function mcpClient(child) {
  let n = 0, calls = 0, buf = ""; const waiting = new Map();
  /** @type {any} */ const c = child;
  c.stdout.on("data", (/** @type {any} */ d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch { /* not ours */ } } });
  const rpc = (/** @type {string} */ method, /** @type {any} */ params, ms = 60_000) => within(new Promise(res => { const id = ++n; waiting.set(id, res); c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); }), ms, `mcp ${method}`);
  /** A tool call: the parsed JSON result, or throws with the tool's error text. */
  const call = async (/** @type {string} */ name, /** @type {any} */ args = {}, ms = 60_000) => {
    const n = ++calls, t = performance.now();
    if (n <= 40 || n % 50 === 0) log(`> #${n} ${name}`);
    const r = /** @type {any} */ (await rpc("tools/call", { name, arguments: args }, ms).catch(e => { log(`! #${n} ${name} ${e.message}`); throw e; }));
    if (n <= 40 || n % 50 === 0) log(`< #${n} ${name} ${Math.round(performance.now() - t)}ms${r.result && r.result.isError ? " (error)" : ""}`);
    if (r.error) throw new Error(`${name}: rpc ${r.error.code} ${r.error.message}`);
    const text = (r.result.content.find((/** @type {any} */ x) => x.type === "text") || {}).text || "null";
    if (r.result.isError) throw Object.assign(new Error(`${name}: ${text.slice(0, 500)}`), { text });
    try { return JSON.parse(text); } catch { return text; }
  };
  return { rpc, call };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const iters = Number(args.iters) || 30;
  const headless = args.headless === "false" ? false : typeof args.headless === "string" ? args.headless : "new";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-sa-"));
  const udd = path.join(tmp, "profile"); fs.mkdirSync(udd);
  const data = path.join(tmp, "data");
  /** @type {Record<string, any>} */ const out = { tool: "chrome-standalone", os: `${process.platform}-${os.arch()}`, node: process.version, headless, stages: {}, at: new Date().toISOString() };
  setTimeout(() => {
    out.fatal = out.fatal || "watchdog: still running after 420 s";
    console.log(JSON.stringify(out, null, 2));
    if (typeof args.out === "string") { try { fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true }); fs.writeFileSync(args.out, JSON.stringify(out, null, 2)); } catch { /* best effort */ } }
    process.exit(3);
  }, 420_000).unref();
  /** @type {any} */ let chromeProc = null, fixture = null, mcp = null;
  const cleanups = /** @type {Array<()=>void>} */ ([]);
  const stage = async (/** @type {string} */ name, /** @type {()=>Promise<any>} */ fn) => {
    const t = performance.now(); log(`stage ${name}`);
    try { out.stages[name] = { ok: true, ...(await within(fn(), 120_000, `stage ${name}`)), ms: Math.round(performance.now() - t) }; log(`stage ${name} ok`); return true; }
    catch (e) { const m = String(/** @type {Error} */ (e).message || e); log(`stage ${name} FAILED: ${m.slice(0, 300)}`); out.stages[name] = { ok: false, error: m.slice(0, 600), ms: Math.round(performance.now() - t) }; return false; }
  };
  /** Time n runs of a call. @param {number} n @param {()=>Promise<any>} fn */
  const timed = async (n, fn) => { const xs = []; for (let i = 0; i < n; i++) { const t = performance.now(); await fn(); xs.push(performance.now() - t); } return stats(xs); };

  try {
    log("build the release");
    const rel = build({ out: path.join(tmp, "release") });
    out.release = { version: rel.version, sha256: rel.sha };
    const home = path.join(tmp, "home"); fs.mkdirSync(home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, VYRE_CHROME_HOME: data };
    const cli = path.join(rel.dir, "standalone", "cli.mjs");
    log("cli install");
    const inst = spawnSync(process.execPath, [cli, "install", "--browsers", "chrome"], { env, encoding: "utf8" });
    out.install = { status: inst.status, printedAddLine: /claude mcp add vyre-chrome/.test(inst.stdout || ""), stderr: (inst.stderr || "").slice(0, 300) };
    if (inst.status !== 0) throw new Error(`install failed: ${inst.stderr}`);
    const ext = prepareExtension(path.join(rel.dir, "extension"), path.join(tmp, "extension"));
    out.extensionId = ext.id;
    const launcher = path.join(rel.dir, "native-host", process.platform === "win32" ? "run-host.cmd" : "run-host.sh");
    cleanups.push(registerHost({ manifestObj: hostManifest({ wrapper: launcher, id: ext.id }), dir: tmp, userDataDir: udd }));

    fixture = await startFixtureServer();
    const child = spawn(process.execPath, [cli, "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
    mcp = mcpClient(child);
    child.stderr.on("data", d => { const s = String(d).trim(); if (s) log(`mcp: ${s.slice(0, 200)}`); });
    cleanups.push(() => { try { child.kill(); } catch { /* gone */ } });
    await stage("mcp_initialize", async () => { const r = /** @type {any} */ (await mcp.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "harness", version: "1" } })); const l = /** @type {any} */ (await mcp.rpc("tools/list", {})); return { server: r.result.serverInfo, tools: l.result.tools.length }; });

    const chrome = resolveChrome({ chrome: typeof args.chrome === "string" ? args.chrome : undefined });
    out.chrome = chrome.version;
    const launched = launchChrome({ chrome: chrome.path, userDataDir: udd, url: `${fixture.url}/checkout`, extraArgs: [`--load-extension=${ext.dir}`, `--disable-extensions-except=${ext.dir}`], headless, logFile: path.join(tmp, "chrome.log") });
    chromeProc = launched.child; log("chrome launched");

    const connected = await stage("connected", async () => {
      const end = Date.now() + 45_000;
      for (;;) { const s = await mcp.call("chrome_status", {}); if (s.connected) return { extension: s.extension && { protocol: s.extension.protocol, version: s.extension.version } }; if (Date.now() > end) throw new Error("the extension never connected: " + JSON.stringify(s).slice(0, 300)); await sleep(250); }
    });
    if (connected) {
      /** @type {any} */ let tab;
      await stage("tabs_use", async () => { const r = await mcp.call("chrome_tabs", { action: "use", url: `${fixture.url}/checkout`, openIfMissing: true }); tab = r.id ?? (r.tab && r.tab.id); return { tab }; });
      await stage("snapshot", async () => { const s = await mcp.call("chrome_snapshot", { tab }); return { controls: (s.controls || []).length, ms: undefined, latency: await timed(iters, () => mcp.call("chrome_snapshot", { tab })) }; });
      await stage("fill_12", async () => ({ latency: await timed(iters, () => mcp.call("chrome_fill", { tab, fields: CHECKOUT_FIELDS.map(f => ({ selector: { identifier: f.selector.replace(/^#/, "") }, value: f.value })) })) }));
      await stage("click", async () => ({ latency: await timed(iters, () => mcp.call("chrome_act", { tab, selector: { identifier: "apply-promo" }, kind: "click" })) }));

      await stage("batch_20_one_call", async () => {
        const g = await mcp.call("chrome_tabs", { action: "use", url: `${fixture.url}/ghl`, openIfMissing: true }); const gt = g.id ?? (g.tab && g.tab.id);
        const steps = WORKFLOW_STEPS.map(s => s.op === "click"
          ? { op: "page.act", args: { tabId: gt, selector: { identifier: (/data-testid="([^"]+)"/.exec(s.selector) || [])[1] }, kind: "click" } }
          : { op: "page.fill", args: { tabId: gt, fields: [{ selector: { identifier: s.selector.replace(/^#/, "") }, value: s.value }] } });
        const batchMs = /** @type {number[]} */ ([]);
        for (let k = 0; k < 5; k++) {
          await mcp.call("chrome_tabs", { action: "navigate", tab: gt, url: `${fixture.url}/ghl` }); await sleep(200);
          const t = performance.now(); const r = await mcp.call("chrome_batch", { tab: gt, steps });
          if (r.ok === false) throw new Error("batch failed: " + JSON.stringify(r).slice(0, 300));
          batchMs.push(performance.now() - t);
        }
        return { steps: steps.length, oneCall: stats(batchMs) };
      });

      await stage("ghl_robust_flow", async () => {
        const r = await mcp.call("chrome_tabs", { action: "use", url: `${fixture.url}${GHL_ROBUST.path}`, openIfMissing: true }); const gt = r.id ?? (r.tab && r.tab.id);
        await mcp.call("chrome_tabs", { action: "navigate", tab: gt, url: `${fixture.url}${GHL_ROBUST.path}` }); await sleep(300);
        const t0 = performance.now();
        await mcp.call("chrome_batch", { tab: gt, steps: GHL_ROBUST.before.map(s => ({ ...s, args: { ...s.args, tabId: gt } })) });
        const run = await mcp.call("chrome_ghl", { action: "run", tab: gt, flow: GHL_ROBUST.flow, params: GHL_ROBUST.params }, 90_000);
        const ms = Math.round(performance.now() - t0);
        const st = await mcp.call("chrome_eval", { tab: gt, expression: "JSON.stringify(window.__state)" });
        const state = JSON.parse(typeof st === "string" ? st : (st.value ?? st.result ?? "null"));
        for (const [k, v] of Object.entries(GHL_ROBUST.expect.state)) if (JSON.stringify(state[k]) !== JSON.stringify(v)) throw new Error(`state.${k} is ${JSON.stringify(state[k])}, wanted ${JSON.stringify(v)}; run: ${JSON.stringify(run).slice(0, 400)}`);
        return { ms, ok: run.ok !== false, state: { saved: state.saved, steps: (state.steps || []).length, trigger: state.trigger, whatsnewClosed: state.whatsnewClosed, discarded: state.discarded } };
      });

      await stage("esc_halts_batch", async () => {
        const g = await mcp.call("chrome_tabs", { action: "use", url: `${fixture.url}/ghl`, openIfMissing: true }); const gt = g.id ?? (g.tab && g.tab.id);
        await mcp.call("chrome_tabs", { action: "navigate", tab: gt, url: `${fixture.url}/ghl` }); await sleep(200);
        const one = WORKFLOW_STEPS.map(s => s.op === "click"
          ? { op: "page.act", args: { tabId: gt, selector: { identifier: (/data-testid="([^"]+)"/.exec(s.selector) || [])[1] }, kind: "click" } }
          : { op: "page.fill", args: { tabId: gt, fields: [{ selector: { identifier: s.selector.replace(/^#/, "") }, value: s.value }] } });
        const steps = [...one, ...one, ...one, ...one, ...one];
        const run = mcp.call("chrome_batch", { tab: gt, steps }, 60_000).then(r => ({ r }), e => ({ e }));
        await sleep(25);
        const t0 = performance.now();
        await mcp.call("chrome_stop", { by: "esc" });
        const res = /** @type {any} */ (await run);
        const haltMs = Math.round(performance.now() - t0);
        const r = res.r || {}; const code = r.code || (res.e && /stopped/.test(String(res.e.message)) ? "stopped" : "");
        await mcp.call("chrome_resume", { answer: "ok" }).catch(() => {});
        if (code !== "stopped") throw new Error("the batch was not halted by Esc: " + JSON.stringify(res).slice(0, 300));
        return { stopToBatchReturnMs: haltMs, extensionHaltMs: r.haltMs ?? null, doneBeforeStop: r.done ?? null, of: steps.length };
      });

      await stage("held_send", async () => {
        const c = await mcp.call("chrome_tabs", { action: "use", url: `${fixture.url}/checkout`, openIfMissing: true }); const ct = c.id ?? (c.tab && c.tab.id);
        const h = await mcp.call("chrome_act", { tab: ct, selector: { identifier: "place-order" }, kind: "click" });
        if (!h.held || !h.id) throw new Error("the order button was not held: " + JSON.stringify(h).slice(0, 300));
        const sent = await mcp.call("chrome_send", { id: h.id });
        const again = await mcp.call("chrome_send", { id: h.id }).then(() => "sent twice", e => e.text ? "refused" : "refused");
        return { held: true, sentOk: sent && sent.ok !== false, secondSend: again };
      });

      await stage("blind_refused", async () => {
        let msg = "";
        try { await mcp.call("chrome_tabs", { action: "open", url: "chrome://settings/passwords" }); } catch (e) { msg = String(/** @type {Error} */ (e).message); }
        if (!/blocked/.test(msg)) throw new Error(`expected blocked, got ${JSON.stringify(msg).slice(0, 200)}`);
        return { refused: true };
      });

      await stage("trace_and_report", async () => {
        const logs = path.join(data, "logs");
        const files = fs.readdirSync(logs).filter(f => f.endsWith(".jsonl"));
        const text = files.map(f => fs.readFileSync(path.join(logs, f), "utf8")).join("");
        const lines = text.split("\n").filter(Boolean).map(l => JSON.parse(l));
        const calls = lines.filter(l => l.kind === "call");
        if (!calls.length) throw new Error("the trace has no calls");
        if (/alex@example\.com|4242424242424242/.test(text)) throw new Error("the trace holds a value that must be masked");
        const rep = spawnSync(process.execPath, [cli, "report", "--last", "1"], { env, encoding: "utf8" });
        if (rep.status !== 0) throw new Error("report failed: " + rep.stderr);
        return { calls: calls.length, withStrategy: calls.filter(c => c.strategy !== undefined).length, failures: calls.filter(c => !c.ok).length, report: (rep.stdout || "").split("\n")[1] || "" };
      });
    }
  } catch (e) {
    out.fatal = String(/** @type {Error} */ (e).message || e);
    try { out.chromeLogTail = fs.readFileSync(path.join(tmp, "chrome.log"), "utf8").slice(-1500); } catch { /* no log */ }
  } finally {
    log("cleanup");
    stopProcess(chromeProc);
    for (const c of cleanups) try { c(); } catch { /* best effort */ }
    await within(Promise.resolve(fixture?.close()), 5000, "closing the fixture").catch(e => log(String(e.message)));
    setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }, 2500).unref();
  }
  const failed = Object.entries(out.stages).filter(([, v]) => /** @type {any} */ (v).ok === false).map(([k]) => k);
  out.ok = !out.fatal && failed.length === 0;
  const s = out.stages;
  const line = `chrome-standalone ${out.ok ? "PASS" : "FAIL"} ${out.os}: mcp click p50 ${s.click?.latency?.p50 ?? "n/a"} ms, 12-field fill p50 ${s.fill_12?.latency?.p50 ?? "n/a"} ms, 20-step batch one call p50 ${s.batch_20_one_call?.oneCall?.p50 ?? "n/a"} ms, GHL robust flow ${s.ghl_robust_flow?.ms ?? "n/a"} ms, Esc halt ${s.esc_halts_batch?.stopToBatchReturnMs ?? "n/a"} ms${out.ok ? "" : `; failed: ${[...failed, ...(out.fatal ? ["fatal"] : [])].join(",")}`}`;
  console.log(JSON.stringify(out, null, 2)); console.log(line);
  stepSummary(`- ${line}`);
  if (typeof args.out === "string") { fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true }); fs.writeFileSync(args.out, JSON.stringify(out, null, 2)); }
  process.exitCode = out.ok ? 0 : 1;
}
main().then(() => setTimeout(() => process.exit(process.exitCode || 0), 3000).unref(), e => { console.error(e); process.exit(1); });
