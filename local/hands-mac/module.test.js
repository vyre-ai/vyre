// @ts-check
// The module through the real Registry, with a fake app in place of the helper: the tools
// register under the names the manifest declares, act re-observes, and the event is recorded.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discover, Registry, validate } from "../../core/modules/index.js";
import { open } from "../../core/store/index.js";
import { Events } from "../../kernel/bus.js";
import { tempHome } from "../../test/helpers.js";
import { fakeApp } from "./fake.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("module: the manifest is valid under the loader's rules", () => {
  assert.deepEqual(validate(JSON.parse(fs.readFileSync(path.join(HERE, "module.json"), "utf8")), { firstParty: true }), []);
});

test("module: starts in the Registry, registers its tools, and act observes again", async t => {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const f = fakeApp({ texts: ["0"], elements: [{ path: "/0/0/7", role: "AXButton", name: "7", enabled: true }] },
    (req, s) => { s.texts = ["7"]; return { acted: true }; });
  const reg = new Registry({ db, events: new Events(db), log: () => {},
    config: { role: "local", hands: { runner: f.run, sleep: async () => {} } } });
  const found = discover([path.dirname(HERE)]).filter(m => m.dir === HERE);
  await reg.start(found, { role: "local" });
  assert.equal(reg.status().find(m => m.name === "hands")?.state, "running");
  assert.deepEqual(reg.listTools().map(x => x.name).sort(), ["hands.act", "hands.commit", "hands.find", "hands.grant.add", "hands.grant.list", "hands.grant.remove", "hands.indicator", "hands.observe", "hands.pause", "hands.resume", "hands.stop"]);

  const seen = await reg.call("hands.observe", {}, "cli");
  assert.deepEqual(seen.data.elements[0].selector, { role: "AXButton", name: "7", path: "/0/0/7" });

  const r = await reg.call("hands.act", { selector: seen.data.elements[0].selector, kind: "press" }, "cli");
  assert.equal(r.data.verified, true, JSON.stringify(r));
  const cmds = f.calls.map(c => c.cmd);
  assert.deepEqual(cmds.slice(cmds.indexOf("act")), ["act", "snap"], "act did not re-observe");
  const ev = reg.deps.events.since(0).filter(e => e.type === "hands.acted");
  assert.equal(ev.length, 1);
});

test("module: bad input is refused by the Registry's schema check", async t => {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const f = fakeApp({ elements: [] });
  const reg = new Registry({ db, events: new Events(db), log: () => {}, config: { role: "local", hands: { runner: f.run } } });
  await reg.start(discover([path.dirname(HERE)]).filter(m => m.dir === HERE), { role: "local" });
  assert.equal((await reg.call("hands.act", { selector: { role: "AXButton" }, kind: "drag" }, "cli")).error.code, "bad_input");
  assert.equal(f.calls.length, 0);
});

test("module: hands.acted carries the thread, tool call and agent of the call that caused it", async t => {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const f = fakeApp({ texts: ["0"], elements: [{ path: "/0/0/7", role: "AXButton", name: "7", enabled: true }] },
    (req, s) => { s.texts = ["7"]; return { acted: true }; });
  const reg = new Registry({ db, events: new Events(db), log: () => {},
    config: { role: "local", hands: { runner: f.run, sleep: async () => {} } } });
  await reg.start(discover([path.dirname(HERE)]).filter(m => m.dir === HERE), { role: "local" });
  // kit needs the one grant before it may drive this Mac at all (reviewer-2 H2).
  assert.ok((await reg.call("hands.grant.add", { agent: "kit" }, "cli")).data.granted);
  const selector = { role: "AXButton", name: "7", path: "/0/0/7" };
  const r = await reg.call("hands.act", { selector, kind: "press" }, "mcp:agent:kit", { thread: "t-kit-1", call: "toolu_07" });
  assert.equal(r.data.verified, true, JSON.stringify(r));
  const [e] = reg.deps.events.since(0).filter(x => x.type === "hands.acted");
  assert.equal(e.payload.thread, "t-kit-1");
  assert.equal(e.payload.call, "toolu_07");
  assert.equal(e.payload.agent, "kit");
  assert.equal(e.thread, "t-kit-1", "scoped to the thread");
  await reg.call("hands.act", { selector, kind: "press" }, "cli");
  const plain = reg.deps.events.since(0).filter(x => x.type === "hands.acted")[1];
  assert.equal(plain.payload.thread, undefined, "a call with no thread labels nothing");
});

async function setup(/** @type {any} */ t) {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const f = fakeApp({ texts: ["0"], elements: [{ path: "/0/0/7", role: "AXButton", name: "7", enabled: true }] });
  const reg = new Registry({ db, events: new Events(db), log: () => {}, config: { role: "local", hands: { runner: f.run, sleep: async () => {} } } });
  await reg.start(discover([path.dirname(HERE)]).filter(m => m.dir === HERE), { role: "local" });
  return { reg };
}

test("grant: every caller shape that claims an agent name is gated, and a caller that is not the person is refused outright", async t => {
  const { reg } = await setup(t);
  for (const caller of ["mcp:agent:kit", "harness:agent:kit", "cli:agent:kit", "module:agent:kit"]) {
    const r = await reg.call("hands.observe", {}, caller);
    assert.equal(r.error && r.error.code, "denied", caller);
  }
  for (const caller of ["tailnet-guest:sam", "module:newthing", "harness"]) {
    const r = await reg.call("hands.observe", {}, caller);
    assert.equal(r.error && r.error.code, "denied", caller);
  }
  assert.equal((await reg.call("hands.grant.add", { agent: "kit" }, "cli")).data.granted, true, "the person grants with no proof");
  assert.equal((await reg.call("hands.observe", {}, "harness:agent:kit")).error, undefined, "then every route by that name works");
  assert.equal((await reg.call("hands.grant.add", { agent: "kit" }, "mcp:agent:kit")).error.code, "denied", "an agent cannot grant itself");
});

test("release: only what hands itself held can be released; an agent's own gate card runs nothing", async t => {
  const { reg } = await setup(t);
  const r = await reg.call("hands.release", { id: "forged-1", content: { app: "Mail", control: "Attach", input: { selector: { role: "AXButton", name: "Send" }, kind: "press" } } }, "module:gate");
  assert.ok(r.error, "a forged card releases nothing: " + JSON.stringify(r));
  const direct = await reg.call("hands.release", { id: "x", content: {} }, "mcp:agent:kit");
  assert.ok(direct.error);
});

test("step cap: a granted agent that has acted stepCap times with no word from the person is asked to check in; the person, a stop or resume:true start the count again", async t => {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const f = fakeApp({ texts: ["0"], elements: [{ path: "/0/0/7", role: "AXButton", name: "7", enabled: true }] }, (req, s) => { s.texts = ["7"]; return { acted: true }; });
  let clock = 1_000_000;
  const reg = new Registry({ db, events: new Events(db), log: () => {}, config: { role: "local", hands: { runner: f.run, sleep: async () => {}, stepCap: 3, now: () => clock } } });
  await reg.start(discover([path.dirname(HERE)]).filter(m => m.dir === HERE), { role: "local" });
  assert.ok((await reg.call("hands.grant.add", { agent: "kit" }, "cli")).data.granted);
  const sel = { role: "AXButton", name: "7", path: "/0/0/7" };
  const act = (/** @type {any} */ extra = {}, caller = "mcp:agent:kit") => reg.call("hands.act", { selector: sel, kind: "press", ...extra }, caller);
  for (let i = 0; i < 3; i++) assert.equal((await act()).error, undefined, `act ${i + 1}`);
  const capped = await act();
  assert.equal(capped.error.code, "step_cap");
  assert.match(capped.error.message, /3 acts in a row/);
  assert.equal((await act({}, "cli")).error, undefined, "the person is never capped");
  assert.equal((await act({ resume: true })).error, undefined, "resume:true after asking the person starts the count again");
  for (let i = 0; i < 2; i++) await act();
  assert.equal((await act()).error.code, "step_cap");
  clock += 31 * 60_000;
  assert.equal((await act()).error, undefined, "an idle half hour starts it again");
  for (let i = 0; i < 2; i++) await act();
  assert.equal((await act()).error.code, "step_cap");
  await reg.call("hands.stop", {}, "cli");
  assert.equal((await act({ resume: true })).error, undefined, "a stop, then resume");
});

test("panel: hands.pause holds like a stop and says hands.paused, hands.resume is the person's and carries on; every hands event carries run", async t => {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const f = fakeApp({ texts: ["0"], elements: [{ path: "/0/0/7", role: "AXButton", name: "7", enabled: true }] }, (req, s) => { s.texts = ["7"]; return { acted: true }; });
  const reg = new Registry({ db, events: new Events(db), log: () => {}, config: { role: "local", hands: { runner: f.run, sleep: async () => {} } } });
  await reg.start(discover([path.dirname(HERE)]).filter(m => m.dir === HERE), { role: "local" });
  assert.ok((await reg.call("hands.grant.add", { agent: "kit" }, "cli")).data.granted);
  const sel = { role: "AXButton", name: "7", path: "/0/0/7" };
  assert.equal((await reg.call("hands.pause", {}, "mcp:agent:kit")).error.code, "denied", "the model cannot pause or resume for the person");
  assert.equal((await reg.call("hands.resume", {}, "mcp:agent:kit")).error.code, "denied");
  assert.equal((await reg.call("hands.act", { selector: sel, kind: "press" }, "mcp:agent:kit", { thread: "t7" })).error, undefined);
  assert.equal((await reg.call("hands.pause", {}, "cli")).data.paused, true);
  assert.equal((await reg.call("hands.act", { selector: sel, kind: "press" }, "mcp:agent:kit", { thread: "t7" })).error.code, "stopped");
  assert.equal((await reg.call("hands.resume", {}, "cli")).data.ok, true);
  assert.equal((await reg.call("hands.act", { selector: sel, kind: "press" }, "mcp:agent:kit", { thread: "t7" })).error, undefined, "carries on without resume:true once the person resumed");
  const ev = reg.deps.events.since(0).filter(x => /^hands\./.test(x.type));
  assert.ok(ev.some(e => e.type === "hands.paused") && ev.some(e => e.type === "hands.resumed"), ev.map(e => e.type).join());
  assert.equal(ev.find(e => e.type === "hands.acted").payload.run, "t7");
});

test("hold: the destination string has control and bidi characters in a window title replaced (a hostile title cannot spoof an approval card)", async t => {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const seen = /** @type {any[]} */ ([]);
  const f = fakeApp({ app: "Messages", window: "juno\u202e\u0000\nSend all\u2028", texts: ["x"], elements: [{ path: "/0/0/1", role: "AXButton", name: "Send", enabled: true }] });
  const reg = new Registry({ db, events: new Events(db), log: () => {}, config: { role: "local", hands: { runner: f.run, sleep: async () => {} } } });
  const gateDir = path.join(home, "mods", "gate");
  fs.mkdirSync(gateDir, { recursive: true });
  fs.writeFileSync(path.join(gateDir, "module.json"), JSON.stringify({ name: "gate", version: "0.0.1", roles: ["local"], does: { tools: ["gate.offer", "gate.request"] } }));
  fs.writeFileSync(path.join(gateDir, "index.js"), `export default { async start(ctx) { ctx.tool("gate.offer", { effect: "read", description: "x", input: { type: "object" }, run: async () => ({ ok: true }) }); ctx.tool("gate.request", { effect: "read", description: "x", input: { type: "object" }, run: async i => { globalThis.__hto = i; return { id: "g1" }; } }); return {}; } };`);
  const found = [...discover([path.dirname(HERE)]).filter(m => m.dir === HERE), ...discover([path.join(home, "mods")])];
  const firstParty = reg.isFirstParty.bind(reg);
  reg.isFirstParty = (/** @type {string} */ d) => d.startsWith(path.join(home, "mods")) || firstParty(d);
  await reg.start(found, { role: "local" });
  assert.ok((await reg.call("hands.grant.add", { agent: "kit" }, "cli")).data.granted);
  await reg.call("hands.act", { selector: { role: "AXButton", name: "Send", path: "/0/0/1" }, kind: "press" }, "mcp:agent:kit");
  const req = /** @type {any} */ (globalThis).__hto;
  assert.ok(req, "the act was held through the Gate");
  assert.ok(!/[\u0000-\u001f\u2028\u2029\u202e]/.test(req.to), JSON.stringify(req.to));
  assert.match(req.to, /^Messages: juno/);
});

test("the link runs what the paired box asked without a second grant (link.computer.allow was the grant); an added module of any other name still needs one", async t => {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const f = fakeApp({ app: "Notes", texts: ["hello"], elements: [{ path: "/0/0/1", role: "AXButton", name: "New", enabled: true }] });
  const reg = new Registry({ db, events: new Events(db), log: () => {}, config: { role: "local", hands: { runner: f.run, sleep: async () => {} } } });
  for (const name of ["link", "stranger"]) {
    const dir = path.join(home, "mods", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "module.json"), JSON.stringify({ name, version: "0.0.1", roles: ["local"], does: { tools: [`${name}.probe`] } }));
    fs.writeFileSync(path.join(dir, "index.js"), `export default { async start(ctx) { ctx.tool("${name}.probe", { effect: "read", description: "x", input: { type: "object" }, run: async () => { const r = await ctx.call("hands.observe", { app: "Notes" }); return r.error ? { error: r.error.message } : { ok: true }; } }); } };`);
  }
  const found = [...discover([path.dirname(HERE)]).filter(m => m.dir === HERE), ...discover([path.join(home, "mods")])];
  const firstParty = reg.isFirstParty.bind(reg);
  reg.isFirstParty = (/** @type {string} */ d) => d.startsWith(path.join(home, "mods", "link")) || firstParty(d);
  await reg.start(found, { role: "local" });
  assert.deepEqual((await reg.call("link.probe", {}, "cli")).data, { ok: true });
  assert.match(String((await reg.call("stranger.probe", {}, "cli")).data.error), /not granted|no permission/);
});
