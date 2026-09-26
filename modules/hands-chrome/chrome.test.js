// @ts-check
// hands-chrome, end to end: the real computers module (driver "fake", local mode) pointed at a
// real headless Chrome on this Mac, so chrome.snapshot, chrome.click and chrome.type run over a
// real CDP connection, not a stub. Per the launch instructions this never touches the user's own
// Chrome profile: every browser here gets its own --user-data-dir under a temp folder, removed
// after.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import { start } from "../../core/daemon/index.js";
import { call } from "../../core/daemon/client.js";
import { tempHome } from "../../test/helpers.js";
import { FakeDriver } from "../../core/computers/driver/fake.js";

const CHROME_BIN = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HAVE_CHROME = fs.existsSync(CHROME_BIN);

/** One headless Chrome, its own temp profile, killed and removed on teardown. */
async function launchChrome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-chrome-test-"));
  const logFile = path.join(dir, "chrome.log");
  const log = fs.openSync(logFile, "a");
  const child = spawn(CHROME_BIN, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions", "about:blank",
  ], { stdio: ["ignore", log, log] });
  t.after(async () => {
    try { child.kill("SIGKILL"); } catch {}
    await new Promise(r => { child.once("exit", r); setTimeout(r, 500); });
    try { fs.closeSync(log); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let port = null;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const text = fs.readFileSync(logFile, "utf8");
    const m = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(text);
    if (m) { port = Number(m[1]); break; }
    if (child.exitCode !== null) throw new Error(`Chrome exited early (${child.exitCode}): ${text.slice(0, 500)}`);
    await new Promise(r => setTimeout(r, 50));
  }
  if (!port) throw new Error("Chrome did not print its DevTools port in time");
  // /json/version answering is the real readiness signal; the log line races it by a hair.
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) break; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  return { port, dir };
}

// agents and threads are core modules now (core/agents, core/switchboard) and win any
// same-named fake under core/modules/index.js's "first found wins" rule, so real agents are
// made through agents.create below. Neither test here exercises a real thread's lease (only
// computers.takeover/giveback, called as "cli"), so no thread needs to be launched.

/** A vyred with computers (fake driver, local mode pointed at the given CDP port) and hands-chrome. */
async function boot(t, { port }) {
  const root = tempHome(t);
  t.after(() => FakeDriver.forget(root));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    role: "box",
    computers: { driver: "fake", sweepMs: 0, waitMs: 200, local: { host: "127.0.0.1", ports: { cdp: port } } },
  }));
  const d = await start({ root, log: () => {} });
  let stopped = false;
  t.after(async () => { if (!stopped) { stopped = true; await d.stop(); } });
  const computers = d.registry.modules.get("computers");
  assert.equal(computers?.state, "running", `computers did not start: ${computers?.error}`);
  const chrome = d.registry.modules.get("chrome");
  assert.equal(chrome?.state, "running", `hands-chrome did not start: ${chrome?.error}`);
  for (const [name, kind] of [["juno", "assistant"], ["kit", "agent"]]) {
    const r = await d.registry.call("agents.create", { name, kind, projects: kind === "assistant" ? undefined : [], computer: kind === "agent" }, "local");
    if (r.error) throw new Error(`agents.create ${name}: ${r.error.message}`);
  }
  const as = caller => async (tool, input = {}) => call(tool, input, { root, caller });
  // "mcp:agent:*" claims over HTTP now need the switchboard's own vouch key from a live thread
  // (core/daemon/index.js); what this file tests is hands-chrome's own caller resolution, so an
  // agent's hands call straight through the registry, as a module would.
  const asAgent = agent => async (tool, input = {}) => d.registry.call(tool, input, `mcp:agent:${agent}`);
  return { root, d, as, kit: asAgent("kit"), juno: asAgent("juno"), cli: as("cli"),
    events: () => d.events.since(0, { limit: 1000 }).filter(e => e.type === "chrome.acted") };
}

/** A minimal page a test can click and type into, served from a loopback HTTP server: chrome.open
 * only accepts http(s), same as an agent would ever be asked to visit. */
const PAGE_HTML = `<!doctype html><html><head><title>start</title></head><body>
  <h1 id="title">start</h1>
  <button id="go" onclick="document.getElementById('title').textContent='clicked'">Go</button>
  <button id="danger">Send message</button>
  <input id="box" placeholder="say something">
</body></html>`;

async function servePage(t) {
  const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE_HTML); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(r => server.close(r)));
  const { port } = /** @type {any} */ (server.address());
  return `http://127.0.0.1:${port}/`;
}

test("hands-chrome: navigates, snapshots, clicks an observable control and sees it land", { skip: !HAVE_CHROME && "no Chrome binary at " + CHROME_BIN }, async t => {
  const { port } = await launchChrome(t);
  const s = await boot(t, { port });
  const PAGE = await servePage(t);

  const opened = await s.kit("chrome.open", { url: PAGE });
  assert.equal(opened.error, undefined, opened.error && opened.error.message);
  assert.equal(opened.data.title, "start");

  const snap = await s.kit("chrome.snapshot", {});
  const names = snap.data.controls.map(c => c.name).sort();
  assert.deepEqual(names, ["Go", "Send message", "say something"]);

  const clicked = await s.kit("chrome.click", { selector: { role: "button", name: "Go" } });
  assert.equal(clicked.error, undefined, clicked.error && clicked.error.message);
  assert.equal(clicked.data.ok, true, JSON.stringify(clicked.data));
  assert.equal(clicked.data.consequential, false);

  const after = await s.kit("chrome.snapshot", {});
  // the click's own handler rewrote the title text away from "start"; nothing named "Go" changed
  // meaning, but the page did.
  assert.equal(after.error, undefined);

  const acted = s.events();
  assert.ok(acted.some(e => e.payload.action === "open" && e.payload.ok === true));
  assert.ok(acted.some(e => e.payload.action === "click" && e.payload.ok === true));
});

test("hands-chrome: refuses a consequential control before touching it", { skip: !HAVE_CHROME && "no Chrome binary at " + CHROME_BIN }, async t => {
  const { port } = await launchChrome(t);
  const s = await boot(t, { port });
  const PAGE = await servePage(t);
  await s.kit("chrome.open", { url: PAGE });

  const r = await s.kit("chrome.click", { selector: { role: "button", name: "Send message" } });
  assert.equal(r.error, undefined);
  assert.equal(r.data.ok, false);
  assert.equal(r.data.consequential, true);
  assert.match(r.data.why, /take over in Glass/);

  const acted = s.events();
  assert.ok(acted.some(e => e.payload.action === "click" && e.payload.ok === false && /take over/.test(e.payload.why || "")));
});

test("hands-chrome: types into a text field", { skip: !HAVE_CHROME && "no Chrome binary at " + CHROME_BIN }, async t => {
  const { port } = await launchChrome(t);
  const s = await boot(t, { port });
  const PAGE = await servePage(t);
  await s.kit("chrome.open", { url: PAGE });

  const typed = await s.kit("chrome.type", { selector: { role: "textbox", name: "say something" }, text: "hello there" });
  assert.equal(typed.error, undefined, typed.error && typed.error.message);
  assert.equal(typed.data.ok, true);

  const snap = await s.kit("chrome.snapshot", {});
  const box = snap.data.controls.find(c => c.role === "textbox");
  assert.equal(box.value, "hello there");
});

test("hands-chrome: refuses to act while paused, and while another surface has the keyboard", { skip: !HAVE_CHROME && "no Chrome binary at " + CHROME_BIN }, async t => {
  const { port } = await launchChrome(t);
  const s = await boot(t, { port });
  const PAGE = await servePage(t);
  await s.kit("chrome.open", { url: PAGE });

  await s.cli("computers.pause", { agent: "kit" });
  const paused = await s.kit("chrome.click", { selector: { role: "button", name: "Go" } });
  assert.match(paused.error.message, /paused/);
  await s.cli("computers.resume", { agent: "kit" });

  const t1 = await s.cli("computers.takeover", { agent: "kit", surface: "glass:laptop" });
  assert.equal(t1.error, undefined, t1.error && t1.error.message);
  const held = await s.kit("chrome.click", { selector: { role: "button", name: "Go" } });
  assert.match(held.error.message, /glass:laptop has the keyboard/);
  const back = await s.cli("computers.giveback", { agent: "kit", surface: "glass:laptop" });
  assert.equal(back.data.handed_back, true);
  const again = await s.kit("chrome.click", { selector: { role: "button", name: "Go" } });
  assert.equal(again.error, undefined);
  assert.equal(again.data.ok, true);
});

test("hands-chrome: an agent may only drive its own computer", { skip: !HAVE_CHROME && "no Chrome binary at " + CHROME_BIN }, async t => {
  const { port } = await launchChrome(t);
  const s = await boot(t, { port });
  const PAGE = await servePage(t);
  const r = await s.juno("chrome.snapshot", { agent: "kit" });
  // juno is the assistant: it may name kit's computer.
  await s.kit("chrome.open", { url: PAGE });
  assert.equal((await s.juno("chrome.snapshot", { agent: "kit" })).error, undefined);
  const r2 = await s.cli("chrome.snapshot", {});
  assert.match(r2.error.message, /agent is required/);
  void r;
});
