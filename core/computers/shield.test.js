// @ts-check
// computers.helper and computers.shield in a real vyred on the fake driver, with every computer
// answering at a small fake computerd on 127.0.0.1 that records what it was told.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";
import { FakeDriver } from "./driver/fake.js";
import { SHIELDED } from "./shield.js";

/** A computerd that only answers POST /shield, and remembers each body. */
async function fakeComputerd(t) {
  /** @type {any[]} */
  const told = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/shield") told.push({ auth: req.headers.authorization, body: JSON.parse(raw || "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(() => r(undefined)); }));
  return { told, port: /** @type {any} */ (server.address()).port };
}

/** A vyred with computers on the fake driver pointed at `helperPort`, and agents juno (assistant) and kit. */
async function boot(t, helperPort) {
  const root = tempHome(t);
  t.after(() => FakeDriver.forget(root));
  const local = helperPort ? { host: "127.0.0.1", ports: { helper: helperPort } } : undefined;
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box",
    computers: { driver: "fake", sweepMs: 0, waitMs: 100, ...(local ? { local } : {}) } }));
  const logs = [];
  const d = await start({ presence: present, root, log: m => logs.push(m) });
  t.after(() => d.stop());
  const h = d.registry.modules.get("computers").handle;
  const clock = { t: 1_000 };
  h.pool.now = () => clock.t;
  for (const [name, kind] of [["juno", "assistant"], ["kit", "agent"]]) {
    const r = await d.registry.call("agents.create", { name, kind, projects: kind === "assistant" ? undefined : [], computer: kind === "agent" }, "local");
    if (r.error) throw new Error(`agents.create ${name}: ${r.error.message}`);
  }
  const mod = (tool, input = {}) => d.registry.call(tool, input, "module:glass");
  const cli = (tool, input = {}) => call(tool, input, { root, caller: "cli" });
  const events = () => d.events.since(0, { limit: 1000 }).filter(e => e.type.startsWith("computer."));
  return { root, d, h, clock, logs, mod, cli, events };
}

test("computers.helper: thaws and touches without a screen, and is hidden from every listing", async t => {
  const cd = await fakeComputerd(t);
  const s = await boot(t, cd.port);
  assert.ok(!s.d.registry.listTools().some(x => x.name === "computers.helper" || x.name === "computers.shield"));
  assert.equal((await s.cli("computers.helper", { agent: "kit" })).error.code, "no_such_tool");
  assert.equal((await s.d.registry.call("computers.helper", { agent: "kit" }, "mcp:agent:kit")).error.code, "no_such_tool");

  const r = await s.mod("computers.helper", { agent: "kit" });
  assert.equal(r.data.url, `http://127.0.0.1:${cd.port}`);
  assert.equal(r.data.token, s.h.pool.row("kit").helper_token);
  const kit = (await s.cli("computers.get", { agent: "kit" })).data;
  assert.equal(kit.state, "running");
  assert.equal(kit.screen, null, "the helper took a screen");
  // Frozen after its idle clock, and thawed again by the next file request, still without a screen.
  s.clock.t += 15_000; await s.h.sweep();
  assert.equal((await s.cli("computers.get", { agent: "kit" })).data.state, "frozen");
  await s.mod("computers.helper", { agent: "kit" });
  assert.equal((await s.cli("computers.get", { agent: "kit" })).data.state, "running");
  // Touched: the freeze clock starts over from the request.
  s.clock.t += 10_000; await s.h.sweep();
  assert.equal((await s.cli("computers.get", { agent: "kit" })).data.state, "running");
  assert.deepEqual(s.events().map(e => e.type), ["computer.created", "computer.frozen", "computer.thawed"]);
  const blob = JSON.stringify(s.d.events.since(0, { limit: 1000 })) + s.logs.join("\n");
  assert.ok(!blob.includes(r.data.token), "the helper token reached an event or a log line");
  assert.match((await s.mod("computers.helper", { agent: "juno" })).error.message, /juno has no computer/);
});

test("computers.shield: refuses reads and input, tells computerd, and ends with the take-over", async t => {
  const cd = await fakeComputerd(t);
  const s = await boot(t, cd.port);
  assert.deepEqual((await s.mod("computers.may-act", { agent: "kit", tool: "hands-desktop.tree", read: true })).data, { ok: true });
  await s.cli("computers.takeover", { agent: "kit", surface: "capsule:mac" });
  // A take-over holds the keyboard, not the eyes: reads still pass, input does not.
  assert.equal((await s.mod("computers.may-act", { agent: "kit", tool: "hands-desktop.tree", read: true })).data.ok, true);
  assert.equal((await s.mod("computers.may-act", { agent: "kit", tool: "chrome.click" })).data.holder, "capsule:mac");

  const on = await s.mod("computers.shield", { agent: "kit", on: true });
  assert.deepEqual(on.data, { agent: "kit", shielded: true, computerd: true });
  for (const [tool, read] of [["hands-desktop.screenshot", true], ["chrome.snapshot", false], ["chrome.type", false]]) {
    assert.deepEqual((await s.mod("computers.may-act", { agent: "kit", tool, read })).data, { ok: false, why: SHIELDED }, tool);
  }
  assert.equal(cd.told.length, 1);
  assert.deepEqual(cd.told[0].body, { on: true, reason: "person" });
  assert.equal(cd.told[0].auth, `Bearer ${s.h.pool.row("kit").helper_token}`);

  // The take-over ends: the shield comes down with it, and computerd hears so.
  await s.cli("computers.giveback", { agent: "kit", surface: "capsule:mac" });
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual((await s.mod("computers.may-act", { agent: "kit", tool: "chrome.click" })).data, { ok: true });
  assert.deepEqual(cd.told.map(x => x.body.on), [true, false]);
  const types = s.events().map(e => e.type).filter(x => /shield|handed/.test(x));
  assert.deepEqual(types, ["computer.shielded", "computer.handed-back", "computer.unshielded"]);
  assert.deepEqual(s.events().find(e => e.type === "computer.shielded").payload, { agent: "kit", reason: "person" });
  assert.equal((await s.cli("computers.shield", { agent: "kit", on: true })).error.code, "no_such_tool");
});

test("computers.shield: holds in vyred when computerd cannot be reached", async t => {
  const s = await boot(t, 1); // nothing listens on port 1
  const on = await s.mod("computers.shield", { agent: "kit", on: true });
  assert.equal(on.data.shielded, true);
  assert.equal(on.data.computerd, false);
  assert.ok(s.logs.some(l => /could not shield computerd for kit/.test(l)));
  assert.equal((await s.mod("computers.may-act", { agent: "kit", tool: "hands-desktop.tree", read: true })).data.why, SHIELDED);
  // hands-desktop's reads ask may-act first, so they are refused before computerd is reached.
  const tree = await s.d.registry.call("hands-desktop.tree", { agent: "kit" }, "mcp:agent:kit");
  assert.match(tree.error.message, /signing in/);
  assert.deepEqual((await s.mod("computers.shield", { agent: "kit", on: false })).data.shielded, false);
  assert.equal((await s.mod("computers.may-act", { agent: "kit", tool: "hands-desktop.tree", read: true })).data.ok, true);
});

test("computers.shield: hands-chrome drops its CDP connection to that computer", async t => {
  const cd = await fakeComputerd(t);
  const s = await boot(t, cd.port);
  const chrome = s.d.registry.modules.get("chrome");
  assert.equal(chrome?.state, "running", `hands-chrome did not start: ${chrome?.error}`);
  let closed = 0;
  chrome.handle.pool.byAgent.set("kit", { close: async () => { closed += 1; } });
  chrome.handle.pool.byAgent.set("pax", { close: async () => { closed += 10; } });
  await s.mod("computers.shield", { agent: "kit", on: true });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(closed, 1);
  assert.ok(!chrome.handle.pool.byAgent.has("kit"));
  assert.ok(chrome.handle.pool.byAgent.has("pax"), "another agent's connection was dropped");
  chrome.handle.pool.byAgent.delete("pax");
});

test("computers: capsule:<device> is a person's screen", async t => {
  const s = await boot(t);
  assert.equal((await s.cli("computers.takeover", { agent: "kit", surface: "capsule:mac-mini" })).data.surface, "capsule:mac-mini");
  assert.equal(s.h.keyboard.canType("kit", "capsule:mac-mini"), true);
  const w = await s.cli("computers.watch", { agent: "kit", surface: "capsule:mac-mini" });
  assert.equal(typeof w.data.ticket, "string");
  assert.match((await s.cli("computers.watch", { agent: "kit", surface: "capsule:" })).error.message, /capsule:<device>/);
});
