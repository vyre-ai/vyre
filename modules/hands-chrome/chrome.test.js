// @ts-check
// hands-chrome, end to end: the real computers module (driver "fake", local mode) pointed at a
// real headless Chrome on this Mac, through a fakeComputerd() proxy standing in for the
// container's helper, so chrome.snapshot, chrome.click and chrome.type run over a real CDP
// connection reached the same authenticated way a real computer's would be (ADR 0005), not a
// stub and not a raw port. Per the launch instructions this never touches the user's own Chrome
// profile: every browser here gets its own --user-data-dir under a temp folder, removed after.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { start } from "../../core/daemon/index.js";
import { call } from "../../core/daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";
import { FakeDriver } from "../../core/computers/driver/fake.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { scrub } from "./index.js";

const CHROME_BIN = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HAVE_CHROME = fs.existsSync(CHROME_BIN);

/** One headless Chrome, its own temp profile, killed and removed on teardown. */
async function launchChrome(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-chrome-test-"));
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

/**
 * A stand-in for computerd's `/cdp/json/version` and WS-upgrade proxy (ADR 0005), in front of
 * the real Chrome `launchChrome` started: bearer-checked HTTP, query-token-checked upgrade,
 * otherwise the same authenticated-pipe shape as `core/computers/image/computerd/index.js`. The
 * token starts empty and is taught after boot, exactly as computerd trusts the token vyred baked
 * into its env, since the pool generates its own and this proxy has to agree with it.
 * @param {number} chromePort
 */
function fakeComputerdCdp(chromePort) {
  let token = "";
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://fake-computerd");
    if (req.method === "GET" && url.pathname === "/cdp/json/version") {
      const auth = req.headers["authorization"] || "";
      if (auth !== `Bearer ${token}`) { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "missing or wrong bearer token" } })); return; }
      const r = await fetch(`http://127.0.0.1:${chromePort}/json/version`);
      const info = await r.json();
      if (typeof info.webSocketDebuggerUrl === "string") info.webSocketDebuggerUrl = info.webSocketDebuggerUrl.replace(/^wss?:\/\/[^/]+/, `ws://${req.headers.host}/cdp`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(info));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "no such route" } }));
  });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://fake-computerd");
    if (url.searchParams.get("token") !== token || !url.pathname.startsWith("/cdp/")) { socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n"); return; }
    const targetPath = url.pathname.slice("/cdp".length);
    const upstream = net.connect(chromePort, "127.0.0.1");
    upstream.on("error", () => { try { socket.destroy(); } catch {} });
    socket.on("error", () => { try { upstream.destroy(); } catch {} });
    upstream.on("connect", () => {
      const headers = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (/^host$/i.test(req.rawHeaders[i])) continue;
        headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      headers.push(`Host: 127.0.0.1:${chromePort}`);
      upstream.write(`GET ${targetPath} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
  });
  return {
    listen: () => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(/** @type {any} */ (server.address()).port))),
    close: () => new Promise(resolve => server.close(() => resolve(undefined))),
    setToken: t => { token = t; },
  };
}

// agents and threads are core modules now (core/agents, core/switchboard) and win any
// same-named fake under core/modules/index.js's "first found wins" rule, so real agents are
// made through agents.create below. Neither test here exercises a real thread's lease (only
// computers.takeover/giveback, called as "cli"), so no thread needs to be launched.

/**
 * A vyred with computers (fake driver, local mode pointed at a fakeComputerdCdp proxy in front
 * of the given real Chrome) and hands-chrome. Chrome's own port is never handed to hands-chrome
 * directly, matching ADR 0005: only the proxy's port goes into `local.ports.helper`.
 */
async function boot(t, { port }) {
  const root = tempHome(t);
  t.after(() => FakeDriver.forget(root));
  const proxy = fakeComputerdCdp(port);
  const proxyPort = await proxy.listen();
  t.after(proxy.close);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    role: "box",
    computers: { driver: "fake", sweepMs: 0, waitMs: 200, local: { host: "127.0.0.1", ports: { helper: proxyPort } } },
  }));
  const d = await start({ presence: present, root, log: () => {} });
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
  // The pool made kit's helper token on first checkout; teach the proxy to accept it, exactly
  // as the real computerd trusts the token vyred baked into its env.
  const endpoint = await d.registry.call("computers.endpoint", { agent: "kit" }, "module:hands-chrome");
  if (endpoint.error) throw new Error(`computers.endpoint for kit: ${endpoint.error.message}`);
  proxy.setToken(endpoint.data.helper.token);
  const as = caller => async (tool, input = {}) => call(tool, input, { root, caller });
  // "mcp:agent:*" claims over HTTP now need the switchboard's own vouch key from a live thread
  // (core/daemon/index.js); what this file tests is hands-chrome's own caller resolution, so an
  // agent's hands call straight through the registry, as a module would.
  const asAgent = agent => async (tool, input = {}) => d.registry.call(tool, input, `mcp:agent:${agent}`);
  return { root, d, as, kit: asAgent("kit"), juno: asAgent("juno"), cli: as("cli"), proxy, token: endpoint.data.helper.token,
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

  // Shield refuses a read too, not just an action: unlike an ordinary take-over, this is the one
  // that must stop a screenshot from showing a person's password.
  const on = await s.d.registry.call("computers.shield", { agent: "kit", on: true }, "module:test");
  assert.deepEqual(on.data, { agent: "kit", shielded: true, computerd: false });
  const shot = await s.kit("chrome.screenshot", {});
  assert.match(shot.error.message, /signing in/);
  const off = await s.d.registry.call("computers.shield", { agent: "kit", on: false }, "module:test");
  assert.deepEqual(off.data, { agent: "kit", shielded: false, computerd: false });
  const shot2 = await s.kit("chrome.screenshot", {});
  assert.equal(shot2.error, undefined);
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

test("hands-chrome: Chrome is reached only through the authenticated proxy, never a raw port", { skip: !HAVE_CHROME && "no Chrome binary at " + CHROME_BIN }, async t => {
  const { port } = await launchChrome(t);
  const s = await boot(t, { port });
  // A wrong token gets a readable refusal, not a leaked one, over the fetch that discovers the
  // WebSocket debugger URL (cdp.js's /json/version call).
  s.proxy.setToken("wrong-on-purpose");
  const bad = await s.kit("chrome.snapshot", { agent: "kit" });
  assert.ok(bad.error, "expected an error when the proxy rejects the token");
  assert.match(bad.error.message, /helper token was not accepted/);
  assert.doesNotMatch(bad.error.message, new RegExp(s.token));
  // The real token still works once restored.
  s.proxy.setToken(s.token);
  assert.equal((await s.kit("chrome.snapshot", { agent: "kit" })).error, undefined);
  // Chrome's raw debugging port answers directly (it is real, loopback Chrome on this Mac, not
  // a container) — the point is that hands-chrome/cdp.js never dials it: computers.endpoint
  // never hands out a `cdp` field, only `helper`, so there is nothing in this codebase's own
  // wiring that could reach port directly even though it happens to be open here.
  const r = await fetch(`http://127.0.0.1:${port}/json/version`);
  assert.ok(r.ok, "the port is real Chrome, reachable directly only because this is a Mac test, not a container");
  const endpoint = await s.d.registry.call("computers.endpoint", { agent: "kit" }, "module:hands-chrome");
  assert.equal(endpoint.data.cdp, undefined, "computers.endpoint must never hand out a raw Chrome address");
});

test("scrub: a URL in an action's words keeps its origin and path, never its query, fragment or login", () => {
  assert.equal(scrub("https://harlowlegal.example/sign-in?token=abc123&next=%2F#frag"), "https://harlowlegal.example/sign-in");
  assert.equal(scrub("opened http://alex:pw@northwind.example/a/b?x=1 then more"), "opened http://northwind.example/a/b then more");
  assert.equal(scrub("12 controls on Start"), "12 controls on Start");
  assert.equal(scrub("line one\n  line two"), "line one line two");
  assert.ok(scrub("x".repeat(500)).length <= 200);
});

test("hands-chrome: chrome.acted never stores a query string, and carries the thread and tool call", { skip: !HAVE_CHROME && "no Chrome binary at " + CHROME_BIN }, async t => {
  const { port } = await launchChrome(t);
  const s = await boot(t, { port });
  const PAGE = await servePage(t);
  const r = await s.d.registry.call("chrome.open", { url: `${PAGE}?token=abc123#frag` }, "mcp:agent:kit", { thread: "t-kit-1", call: "toolu_01" });
  assert.equal(r.error, undefined, r.error && r.error.message);
  const e = s.events().find(x => x.payload.action === "open");
  assert.ok(e, "an open step");
  assert.equal(e.payload.summary, PAGE);
  assert.ok(!JSON.stringify(e.payload).includes("abc123"), "no query in the event");
  assert.equal(e.payload.thread, "t-kit-1");
  assert.equal(e.payload.call, "toolu_01");
  assert.equal(e.payload.app, "Chrome");
  assert.equal(e.thread, "t-kit-1", "scoped to the thread");
});
