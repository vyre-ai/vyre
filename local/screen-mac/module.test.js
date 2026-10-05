// @ts-check
// The module through the real Registry, with the fake helper binary in place of sight: the tools
// register under the names the manifest declares, tailnet callers are refused, and nothing read
// from the screen reaches the log or an event.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { discover, Registry, validate } from "../../core/modules/index.js";
import { open } from "../../core/store/index.js";
import { Events } from "../../kernel/bus.js";
import { tempHome } from "../../test/helpers.js";
import { makeHelper } from "./runner.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "fake-sight.js");
const SECRET = "hunter2-test-only";
const scenario = state => ({
  state,
  where: { app: { name: "Notes", bundle: "com.apple.Notes", pid: 4242 }, window: { title: "Northwind Bakery order" }, url: null },
  context: {
    app: { name: "Notes", bundle: "com.apple.Notes", pid: 4242 }, window: { title: "Northwind Bakery order" },
    focused: { role: "AXTextField", subrole: "AXSecureTextField", value: SECRET }, secure: true,
    text: "Northwind Bakery opens at seven", truncated: false,
  },
});

async function registry(t, screen) {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  /** @type {string[]} */
  const logged = [];
  const log = (m, x) => { logged.push(JSON.stringify([m, x ?? null])); };
  const reg = new Registry({ db, events: new Events(db), log, config: { role: "local", screen: screen(home) } });
  t.after(() => reg.stop());
  await reg.start(discover([path.dirname(HERE)]).filter(m => m.dir === HERE), { role: "local" });
  return { reg, logged };
}

test("module: the manifest is valid under the loader's rules", () => {
  assert.deepEqual(validate(JSON.parse(fs.readFileSync(path.join(HERE, "module.json"), "utf8"))), []);
});

test("module: starts in the Registry, registers both tools, and answers redacted", async t => {
  const { reg, logged } = await registry(t, home => ({ helper: makeHelper({ bin: FAKE, platform: "darwin", env: { ...process.env, FAKE_SIGHT: JSON.stringify(scenario(home)) } }) }));
  assert.equal(reg.status().find(m => m.name === "screen")?.state, "running");
  assert.deepEqual(reg.listTools("mcp").map(x => x.name).sort(), ["screen.context", "screen.shot"]);

  const r = await reg.call("screen.context", {}, "cli");
  assert.equal(r.data.text, "Northwind Bakery opens at seven");
  assert.equal(r.data.secure, true);
  assert.equal(JSON.stringify(r).includes(SECRET), false);

  // Privacy: nothing screen-derived in the log, and no events at all.
  await reg.call("screen.shot", {}, "cli");
  const all = logged.join("\n");
  for (const bit of ["Northwind", "Notes", SECRET]) assert.equal(all.includes(bit), false, `the log carried ${bit}`);
  assert.deepEqual(reg.deps.events.since(0).filter(e => String(e.type).startsWith("screen")), []);
  assert.equal(JSON.stringify(reg.deps.events.since(0)).includes("Northwind"), false);
});

test("module: refuses tailnet callers and callers outside its list", async t => {
  const { reg } = await registry(t, home => ({ helper: makeHelper({ bin: FAKE, platform: "darwin", env: { ...process.env, FAKE_SIGHT: JSON.stringify(scenario(home)) } }) }));
  for (const tool of ["screen.context", "screen.shot"]) {
    const r = await reg.call(tool, {}, "mcp", { peer: { node: "juno", user: "alex" } });
    assert.equal(r.error?.code, "local_only", JSON.stringify(r));
    assert.match(r.error.message, /stays on this Mac/);
  }
  assert.equal((await reg.call("screen.context", {}, "hook")).error?.code, "no_such_tool");
  assert.equal((await reg.call("screen.context", {}, "surface")).error?.code, "denied");
});

test("module: a helper path in config or VYRE_SCREEN_BIN is used, and a missing one says how to build it", async t => {
  const prev = process.env.VYRE_SCREEN_BIN;
  process.env.VYRE_SCREEN_BIN = path.join(HERE, "no-such-helper");
  t.after(() => { if (prev === undefined) delete process.env.VYRE_SCREEN_BIN; else process.env.VYRE_SCREEN_BIN = prev; });
  const { reg } = await registry(t, () => ({}));
  const r = await reg.call("screen.context", {}, "cli");
  assert.equal(r.error?.code, process.platform === "darwin" ? "not_built" : "unsupported");
  if (process.platform === "darwin") assert.match(r.error.message, /build\.sh/);
  assert.equal((await reg.call("screen.context", { textMax: "lots" }, "cli")).error?.code, "bad_input");
});

/** Stand-ins for the hands module's grant table and Chrome's plan check, so the agent guard can be driven both ways. */
function stubs(t, { granted = /** @type {string[]} */ ([]), planned = /** @type {string[]} */ ([]) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-scr-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mk = (name, tool, body) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, "module.json"), JSON.stringify({ name, version: "0.0.1", roles: ["local"], does: { tools: [{ name: tool, reach: "modules" }] } }));
    fs.writeFileSync(path.join(dir, name, "index.js"), `export default { async start(ctx) { ctx.tool(${JSON.stringify(tool)}, { internal: true, callers: ["module"], description: "stand-in", input: { type: "object" }, run: async (input) => (${body}) }); return { async stop() {} }; } };`);
  };
  mk("hands", "hands.grant.list", JSON.stringify(granted.map(agent => ({ agent }))));
  mk("chrome", "chrome.plan.check", `{ planned: ${JSON.stringify(planned)}.includes(String(input.agent)) }`);
  return dir;
}

async function guardedRegistry(t, o) {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const mods = stubs(t, o);
  const reg = new Registry({ db, events: new Events(db), log: () => {}, config: { role: "local", screen: { helper: makeHelper({ bin: FAKE, platform: "darwin", env: { ...process.env, FAKE_SIGHT: JSON.stringify(scenario(home)) } }) } } });
  t.after(() => reg.stop());
  const first = reg.isFirstParty.bind(reg);
  reg.isFirstParty = dir => dir.startsWith(mods) || first(dir);
  await reg.start([...discover([path.dirname(HERE)]).filter(m => m.dir === HERE), ...discover([mods])], { role: "local" });
  return reg;
}

test("module: an agent sees the person's screen only with the computer-use grant AND a posted plan; the person's own surfaces and session are not asked", async t => {
  for (const spelling of ["mcp:agent:kit", "cli agent:kit", "harness"]) {
    const reg = await guardedRegistry(t, { granted: [], planned: [] });
    for (const tool of ["screen.context", "screen.shot"]) {
      const r = await reg.call(tool, {}, spelling);
      assert.ok(r.error && /denied/.test(r.error.code), `${spelling} ${tool}: ${JSON.stringify(r).slice(0, 120)}`);
    }
  }
  const noPlan = await guardedRegistry(t, { granted: ["kit"], planned: [] });
  assert.equal((await noPlan.call("screen.context", {}, "mcp:agent:kit")).error?.code, "plan_first");
  assert.equal((await noPlan.call("screen.shot", {}, "mcp:agent:kit")).error?.code, "plan_first");
  const ok = await guardedRegistry(t, { granted: ["kit"], planned: ["kit"] });
  assert.equal((await ok.call("screen.context", {}, "mcp:agent:kit")).data.text, "Northwind Bakery opens at seven");
  const shot = await ok.call("screen.shot", {}, "mcp:agent:kit");
  assert.ok(!shot.error || !/^(denied|plan_first)$/.test(shot.error.code), "past the guard (the fake helper takes no real picture): " + JSON.stringify(shot).slice(0, 120));
  assert.equal((await ok.call("screen.context", {}, "mcp:agent:other")).error?.code, "denied", "another agent has no grant");
  // The person's own surfaces and their own model session are never asked (Lumen's "ask about my screen").
  const none = await guardedRegistry(t, { granted: [], planned: [] });
  for (const person of ["cli", "local"]) assert.ok(!(await none.call("screen.context", {}, person)).error, person);
});

test("module: a plain model session (mcp, no agent claim) needs the one-time grant, not a plan; with it the screen is hands-free", async t => {
  const ungranted = await guardedRegistry(t, { granted: [], planned: [] });
  for (const tool of ["screen.context", "screen.shot"]) {
    const r = await ungranted.call(tool, {}, "mcp");
    assert.equal(r.error?.code, "denied", `${tool}: ${JSON.stringify(r).slice(0, 120)}`);
    assert.match(r.error.message, /hands\.grant\.add/);
  }
  const granted = await guardedRegistry(t, { granted: ["mcp"], planned: [] });
  assert.equal((await granted.call("screen.context", {}, "mcp")).data.text, "Northwind Bakery opens at seven", "granted: no plan needed, no prompt");
  const shot = await granted.call("screen.shot", {}, "mcp");
  assert.ok(!shot.error || !/^(denied|plan_first)$/.test(shot.error.code));
  // an agent still needs its own grant and a plan, whatever the plain session was granted
  assert.equal((await granted.call("screen.context", {}, "mcp:agent:kit")).error?.code, "denied");
});
