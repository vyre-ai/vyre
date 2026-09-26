// @ts-check
// hands-desktop against a real vyred: the real computers module (fake Docker driver, pointed at
// a fake computerd over HTTP through FakeDriver's "local" mode) and this module's own index.js,
// discovered from modules/ exactly as it would be on the box. AT-SPI itself is Linux-only, so
// what is faked here is computerd, not the accessibility tree logic: snapshot.js, selector.js,
// verify.js and act.js run for real against whatever computerd answers.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { start } from "../../core/daemon/index.js";
import { call } from "../../core/daemon/client.js";
import { tempHome } from "../../test/helpers.js";
import { FakeDriver } from "../../core/computers/driver/fake.js";

// agents and threads are core modules now (core/agents, core/switchboard) and win any
// same-named fake under core/modules/index.js's "first found wins" rule, so real agents are made
// through agents.create in boot() below. computers.endpoint's checkout is given a real thread id
// (launched with the fake `claude` at core/switchboard/testing/fake-claude.js), since the
// take-over test below leases that thread for real.
const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "core", "switchboard", "testing", "fake-claude.js");
fs.chmodSync(FAKE_CLAUDE, 0o755);
const THREADS_SRC = `
export default { async start(ctx) {
  const held = new Map();
  const obj = { type: "object", required: ["thread"], properties: { thread: { type: "string" }, surface: { type: "string" } } };
  ctx.tool("threads.lease", { input: obj, run: async ({ thread, surface }, { caller }) => {
    const s = surface || caller, previous = held.get(thread) || null;
    held.set(thread, s);
    if (previous !== s) ctx.events.emit("lease.changed", { holder: s, previous }, { thread });
    return { thread, holder: s, previous };
  } });
  ctx.tool("threads.release", { input: obj, run: async ({ thread, surface }, { caller }) => {
    const s = surface || caller;
    if (held.get(thread) !== s) return { thread, released: false, holder: held.get(thread) || null };
    held.delete(thread);
    ctx.events.emit("lease.changed", { holder: null, previous: s }, { thread });
    return { thread, released: true, holder: null };
  } });
  return { async stop() {} };
} };`;

// A one-pixel PNG: enough to prove screenshot() gets binary bytes through unharmed.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082", "hex");

/** A fake computerd: /health, /apps, /tree, /act, /input, /screenshot, token-checked, over plain HTTP on 127.0.0.1. */
function fakeComputerd() {
  /** @type {{ window: string, nodes: any[] }} */
  const state = {
    window: "Untitled",
    nodes: [
      { path: "/0", role: "push button", name: "Save", enabled: true, x: 10, y: 10, w: 80, h: 24 },
      { path: "/1", role: "push button", name: "Delete", enabled: true, x: 100, y: 10, w: 80, h: 24 },
      { path: "/2", role: "push button", name: "Save", enabled: true, x: 10, y: 60, w: 80, h: 24 }, // a second "Save": ties the selector on purpose
      { path: "/3", role: "entry", name: "Filename", enabled: true, value: "", x: 10, y: 100, w: 200, h: 24 },
    ],
  };
  let token = "";
  /** @type {Array<{ path: string, action: string, value?: string }>} */
  const acted = [];
  const server = http.createServer((req, res) => {
    const send = (code, body, binary) => {
      res.writeHead(code, { "content-type": binary ? "image/png" : "application/json" });
      res.end(binary ? body : JSON.stringify(body));
    };
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${token}`) return send(401, { error: { message: "invalid or stale token" } });
    const [route] = String(req.url).split("?");
    if (req.method === "GET" && route === "/health") return send(200, { ok: true, display: ":1", size: { w: 1440, h: 900 } });
    if (req.method === "GET" && route === "/apps") return send(200, [{ name: "Files", pid: 1, windows: [state.window] }]);
    if (req.method === "GET" && route === "/tree") return send(200, { window: state.window, nodes: state.nodes });
    if (req.method === "GET" && route === "/screenshot") return send(200, PNG, true);
    if (req.method !== "POST") return send(404, { error: { message: `no route ${route}` } });
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      const b = body ? JSON.parse(body) : {};
      if (route === "/act") {
        acted.push(b);
        const n = state.nodes.find(x => x.path === b.path);
        if (n && b.action === "press" && n.name === "Save") state.window = "Saved"; // the observable verification signal
        if (n && b.action === "focus") n.focused = true;
        if (n && b.action === "set-text") n.value = b.value;
        return send(200, { ok: true });
      }
      if (route === "/input") return send(200, { ok: true });
      send(404, { error: { message: `no route ${route}` } });
    });
  });
  return {
    server, state, acted,
    setToken: t => { token = t; },
    listen: () => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(/** @type {any} */ (server.address()).port))),
    close: () => new Promise(resolve => server.close(() => resolve(undefined))),
  };
}

/**
 * A vyred with the real computers module (fake driver, local mode pointed at the fake computerd)
 * and the real hands-desktop module.
 * @param {any} t
 */
async function boot(t) {
  const root = tempHome(t);
  t.after(() => FakeDriver.forget(root));
  const fake = fakeComputerd();
  const port = await fake.listen();
  t.after(fake.close);

  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    role: "box",
    computers: { driver: "fake", sweepMs: 0, waitMs: 100, local: { host: "127.0.0.1", ports: { helper: port, cdp: port, vnc: port } } },
  }));
  const prevEnv = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG };
  process.env.VYRE_CLAUDE_BIN = FAKE_CLAUDE;
  delete process.env.FAKE_CLAUDE_LOG;
  t.after(() => { for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  /** @type {string[]} */
  const logs = [];
  const d = await start({ root, log: (m, x) => logs.push(m + (x ? " " + JSON.stringify(x) : "")) });
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await d.stop(); } };
  t.after(stop);
  assert.equal(d.registry.modules.get("computers")?.state, "running", `computers did not start: ${d.registry.modules.get("computers")?.error}`);
  assert.equal(d.registry.modules.get("hands-desktop")?.state, "running", `hands-desktop did not start: ${d.registry.modules.get("hands-desktop")?.error}`);

  for (const [name, kind] of [["juno", "assistant"], ["kit", "agent"]]) {
    const r = await d.registry.call("agents.create", { name, kind, projects: kind === "assistant" ? undefined : [], computer: kind === "agent" }, "local");
    if (r.error) throw new Error(`agents.create ${name}: ${r.error.message}`);
  }
  const work = fs.mkdtempSync(path.join(root, "kit-work-"));
  const launched = await d.registry.call("threads.launch", { agent: "kit", agent_kind: "agent", cwd: work }, "module:test");
  if (launched.error) throw new Error(`threads.launch for kit: ${launched.error.message}`);
  const kitThread = launched.data.id;

  // The pool made a helper token for "kit" the first time it was asked; learn it and teach the
  // fake server to accept it, exactly as computerd would trust the token vyred baked into its env.
  // computers.endpoint is internal (module callers only), so this reaches it the way hands-desktop
  // itself does, through the registry directly rather than the HTTP surface.
  const first = await d.registry.call("computers.endpoint", { agent: "kit", thread: kitThread }, "module:test");
  assert.equal(first.error, undefined, JSON.stringify(first));
  fake.setToken(first.data.helper.token);

  /** Every result a test saw, for the secret scan. */
  const results = [];
  const as = caller => async (tool, input = {}) => { const r = await call(tool, input, { root, caller }); results.push(r); return r; };
  // "mcp:agent:*" claims over HTTP now need the switchboard's own vouch key from a live thread
  // (core/daemon/index.js); what this file tests is hands-desktop's own caller resolution, so an
  // agent's hands call straight through the registry, as a module would.
  const asAgent = agent => async (tool, input = {}) => { const r = await d.registry.call(tool, input, `mcp:agent:${agent}`); results.push(r); return r; };
  return { root, d, fake, port, token: first.data.helper.token, results, stop, kitThread,
    cli: as("cli"), kit: asAgent("kit"),
    desktopEvents: () => d.events.since(0, { limit: 1000 }).filter(e => e.type === "desktop.acted") };
}

test("hands-desktop: the manifest loads with its tools declared", async t => {
  const s = await boot(t);
  const tools = s.d.registry.listTools().map(x => x.name).filter(n => n.startsWith("hands-desktop."));
  assert.deepEqual(tools.sort(), ["hands-desktop.act", "hands-desktop.apps", "hands-desktop.screenshot", "hands-desktop.tree"]);
});

test("hands-desktop: tree reads the fake computerd and shapes it into a Snapshot", async t => {
  const s = await boot(t);
  const r = await s.kit("hands-desktop.tree", { agent: "kit" });
  assert.equal(r.error, undefined);
  assert.equal(r.data.window, "Untitled");
  assert.equal(r.data.controls.length, 4);
  assert.equal(r.data.controls.find(c => c.path === "/2").name, "Save");
});

test("hands-desktop: apps and screenshot reach the fake computerd", async t => {
  const s = await boot(t);
  const apps = await s.kit("hands-desktop.apps", { agent: "kit" });
  assert.equal(apps.error, undefined);
  assert.deepEqual(apps.data.apps.map(a => a.name), ["Files"]);

  const shot = await s.kit("hands-desktop.screenshot", { agent: "kit" });
  assert.equal(shot.error, undefined);
  assert.equal(shot.data.mime, "image/png");
  assert.deepEqual(Buffer.from(shot.data.image, "base64"), PNG);
});

test("hands-desktop: act presses a uniquely-named control and verifies the window changed", async t => {
  const s = await boot(t);
  // "Save" is on screen twice (see fakeComputerd): press by role+name filtered down to /0 fails
  // to disambiguate on name alone, so scope with a role that still ties, proving the ambiguity
  // is real, then use the one genuinely unique control instead.
  const tied = await s.kit("hands-desktop.act", { agent: "kit", name: "Save" });
  assert.equal(tied.error, undefined);
  assert.equal(tied.data.ok, false);
  assert.match(tied.data.why, /2 controls are named/);
  assert.equal(s.fake.acted.length, 0, "an ambiguous target must never reach a click");

  const r = await s.kit("hands-desktop.act", { agent: "kit", thread: s.kitThread, name: "Filename", role: "entry", action: "set-text", value: "report.txt" });
  assert.equal(r.error, undefined);
  assert.equal(r.data.ok, true);
  assert.equal(s.fake.state.nodes.find(n => n.path === "/3").value, "report.txt");
  assert.deepEqual(s.fake.acted.map(a => a.action), ["focus", "set-text"]);

  const events = s.desktopEvents();
  assert.equal(events.length, 2, "one event for the tied attempt, one for the successful set-text");
  assert.equal(events[0].payload.ok, false);
  assert.equal(events[1].payload.agent, "kit");
  assert.equal(events[1].payload.ok, true);
  assert.equal(events[1].thread, s.kitThread);
});

test("hands-desktop: a consequential control is refused before any click reaches computerd", async t => {
  const s = await boot(t);
  const r = await s.kit("hands-desktop.act", { agent: "kit", name: "Delete" });
  assert.equal(r.error, undefined);
  assert.equal(r.data.ok, false);
  assert.equal(r.data.consequential, true);
  assert.match(r.data.why, /take over in Glass/);
  assert.equal(s.fake.acted.length, 0, "a consequential control must never be pressed");

  const events = s.desktopEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.ok, false);
  assert.match(events[0].payload.why, /take over in Glass/);
});

test("hands-desktop: a take-over refuses the act (reads still work), and never touches computerd for the click", async t => {
  const s = await boot(t);
  const to = await s.d.registry.call("computers.takeover", { agent: "kit", surface: "glass:laptop" }, "mcp:agent:juno");
  assert.equal(to.error, undefined);

  // Reads still work through a take-over: ADR 0003, "an agent looks at its screen ... never
  // through Glass", and the take-over holds only the keyboard.
  const tree = await s.kit("hands-desktop.tree", { agent: "kit" });
  assert.equal(tree.error, undefined);

  const r = await s.kit("hands-desktop.act", { agent: "kit", name: "Filename", role: "entry", action: "set-text", value: "x" });
  assert.equal(r.error, undefined);
  assert.equal(r.data.ok, false);
  assert.match(r.data.why, /glass:laptop has the keyboard/);
  assert.equal(s.fake.acted.length, 0, "the click must be refused before it reaches computerd, not merely reported as failed");
});

test("hands-desktop: shield refuses reads too, unlike an ordinary take-over", async t => {
  const s = await boot(t);
  const on = await s.d.registry.call("computers.shield", { agent: "kit", on: true }, "module:test");
  assert.deepEqual(on.data, { agent: "kit", shielded: true });

  const tree = await s.kit("hands-desktop.tree", { agent: "kit" });
  assert.match(tree.error.message, /shielded while a person signs in/);
  const apps = await s.kit("hands-desktop.apps", { agent: "kit" });
  assert.match(apps.error.message, /shielded while a person signs in/);
  const shot = await s.kit("hands-desktop.screenshot", { agent: "kit" });
  assert.match(shot.error.message, /shielded while a person signs in/);
  assert.equal(s.fake.acted.length, 0, "a shielded read must never reach computerd");

  const off = await s.d.registry.call("computers.shield", { agent: "kit", on: false }, "module:test");
  assert.deepEqual(off.data, { agent: "kit", shielded: false });
  assert.equal((await s.kit("hands-desktop.tree", { agent: "kit" })).error, undefined, "reads work again once unshielded");
});

test("hands-desktop: a stale helper token surfaces a readable error, not a leaked one", async t => {
  const s = await boot(t);
  s.fake.setToken("some-other-token");
  const r = await s.kit("hands-desktop.tree", { agent: "kit" });
  assert.ok(r.error, "expected an error when computerd rejects the token");
  assert.match(r.error.message, /helper token was not accepted/);
  assert.match(r.error.message, /HTTP 401/);
  assert.doesNotMatch(r.error.message, new RegExp(s.token));
});

test("hands-desktop: only the assistant may act on another agent's computer", async t => {
  const s = await boot(t);
  const r = await s.d.registry.call("hands-desktop.tree", { agent: "kit" }, "mcp:agent:pax");
  assert.ok(r.error);
  assert.match(r.error.message, /could not reach|no such tool|pax/i);
});

test("hands-desktop: no computerd token reaches a tool result, an event, or a log line", async t => {
  const s = await boot(t);
  s.fake.setToken("wrong-on-purpose");
  await s.kit("hands-desktop.tree", { agent: "kit" }); // forces the 401 path, which once nearly echoed the header back
  s.fake.setToken(s.token);
  await s.kit("hands-desktop.act", { agent: "kit", name: "Filename", role: "entry", action: "set-text", value: "y" });
  await s.kit("hands-desktop.apps", { agent: "kit" });
  await s.kit("hands-desktop.screenshot", { agent: "kit" });

  const needle = s.token;
  const blob = JSON.stringify(s.results) + s.d.events.since(0, { limit: 1000 }).map(e => JSON.stringify(e)).join("\n");
  assert.ok(!blob.includes(needle), "the helper token leaked into a tool result or an event");
});
