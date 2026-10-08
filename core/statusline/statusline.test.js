// @ts-check
// The statusline module against fake gate, threads, wink and agents modules in a temp home.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { compose } from "./index.js";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../../kernel/bus.js";
import { tempHome, writeModule } from "../../test/helpers.js";

const wait = ms => new Promise(r => setTimeout(r, ms));

test("compose: each part only when there is something to say", () => {
  assert.equal(compose({}), "vyre");
  assert.equal(compose({ held: [{}], asks: [{}], link: { role: "local", linked: true, reachable: true }, agents: [{ name: "kit", kind: "agent", doing: "working" }, { name: "juno", kind: "assistant", doing: "idle" }] }),
    "vyre · 2 need you · box ok · juno idle");
  assert.equal(compose({ held: [{}] }), "vyre · 1 needs you");
  assert.equal(compose({ link: { role: "local", linked: true, reachable: false } }), "vyre · box away");
  assert.equal(compose({ link: { role: "local", linked: false, reachable: false } }), "vyre", "not linked says nothing");
  assert.equal(compose({ link: { role: "box", peers: 1 } }), "vyre", "the box has no box to report");
  assert.equal(compose({ agents: [{ name: "juno", kind: "assistant", doing: "waiting on your answer" }] }), "vyre · juno waits on you");
  assert.equal(compose({ agents: [{ name: "kit", kind: "agent", doing: "idle" }] }), "vyre", "only the assistant is shown");
  // waiting.count is the one count every surface shows; it wins over the two lists.
  assert.equal(compose({ waiting: { count: 3 }, held: [{}] }), "vyre · 3 need you");
  assert.equal(compose({ waiting: { count: 0 }, held: [{}], asks: [{}] }), "vyre");
  assert.equal(compose({ waiting: null, held: [{}], asks: [{}] }), "vyre · 2 need you", "no waiting module: held plus asks");
});

async function world(t, fakes = [], role = "local") {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  for (const [name, tools, src] of fakes) writeModule(root, name, { roles: ["box", "local"], does: { tools }, watches: { emits: [`${name}.changed`] } }, src);
  const db = open(path.join(home, "vyre.db"));
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role }, paths: { root: home }, log: () => {}, firstPartyRoots: [root] });
  const core = discover([path.join(path.dirname(new URL(import.meta.url).pathname), "..")]).filter(f => f.manifest?.name === "statusline");
  await reg.start([...core, ...discover([root], { firstPartyRoots: [root] })], { role });
  t.after(async () => { await reg.stop?.(); db.close(); });
  return { reg, events, home, file: path.join(home, "statusline") };
}

// A fake whose answers the test can change: globalThis.fake is shared with the module it loads.
const FAKES = [
  ["gate", ["gate.held"], `export default { async start(ctx) { ctx.tool("gate.held", { effect: "read", run: async () => globalThis.fake.held }); return {}; } };`],
  ["threads", ["threads.asks"], `export default { async start(ctx) { ctx.tool("threads.asks", { effect: "read", run: async () => globalThis.fake.asks }); return {}; } };`],
  ["wink", ["wink.server.home"], `export default { async start(ctx) { ctx.tool("wink.server.home", { effect: "read", run: async () => globalThis.fake.link }); return {}; } };`],
  ["agents", ["agents.list"], `export default { async start(ctx) {
    ctx.tool("agents.list", { effect: "read", run: async () => globalThis.fake.agents });
    ctx.tool("agents.poke", { effect: "read", run: async () => { ctx.events.emit("agents.changed", {}); return true; } });
    return {}; } };`],
];
FAKES[3][1].push("agents.poke");

test("statusline: with nothing else running the line is just vyre", async t => {
  const { reg, file } = await world(t);
  assert.deepEqual((await reg.call("statusline.line", {}, "cli")).data, { line: "vyre" });
  assert.deepEqual(fs.readFileSync(file, "utf8").split("\n"), [String(process.pid), "vyre", ""]);
});

test("statusline: reads every part, follows events after a debounce, writes only on change, removes the file on stop", async t => {
  /** @type {any} */ (globalThis).fake = { held: [{ id: "g1" }], asks: [{ id: "a1" }], link: { role: "local", linked: true, reachable: true },
    agents: [{ name: "juno", kind: "assistant", doing: "idle" }] };
  t.after(() => { delete /** @type {any} */ (globalThis).fake; });
  const { reg, file } = await world(t, FAKES);
  // The first line waits a second for other modules to start.
  await wait(1300);
  assert.equal(fs.readFileSync(file, "utf8"), `${process.pid}\nvyre · 2 need you · box ok · juno idle\n`);

  const before = fs.statSync(file).mtimeMs;
  await reg.call("agents.poke", {});
  await wait(1300);
  assert.equal(fs.statSync(file).mtimeMs, before, "same text, no write");

  Object.assign(/** @type {any} */ (globalThis).fake, { held: [], asks: [], link: { role: "local", linked: true, reachable: false },
    agents: [{ name: "juno", kind: "assistant", doing: "waiting on your answer" }] });
  await reg.call("agents.poke", {});
  assert.match(fs.readFileSync(file, "utf8"), /2 need you/, "not before the debounce");
  await wait(1300);
  assert.equal(fs.readFileSync(file, "utf8").split("\n")[1], "vyre · box away · juno waits on you");

  await reg.stop?.();
  assert.equal(fs.existsSync(file), false);
});

test("statusline: the need count is waiting.count's, the same one push and the Capsule show", async t => {
  /** @type {any} */ (globalThis).fake = { held: [{ id: "g1" }], asks: [], link: null, agents: [] };
  t.after(() => { delete /** @type {any} */ (globalThis).fake; });
  const waiting = ["waiting", ["waiting.count"], `export default { async start(ctx) { ctx.tool("waiting.count", { effect: "read", run: async () => ({ count: 4, by_kind: { ask: 1, draft: 1, reminder: 1, pairing: 1 } }) }); return {}; } };`];
  const { reg } = await world(t, [...FAKES, waiting], "box");
  assert.equal((await reg.call("statusline.line", {}, "cli")).data.line, "vyre · 4 need you", "a reminder and a pairing request count too");
});

test("statusline: a failing tool drops only its own part", async t => {
  const broken = [
    ["gate", ["gate.held"], `export default { async start(ctx) { ctx.tool("gate.held", { effect: "read", run: async () => { throw new Error("gate broke"); } }); return {}; } };`],
    ["agents", ["agents.list"], `export default { async start(ctx) { ctx.tool("agents.list", { effect: "read", run: async () => [{ name: "juno", kind: "assistant", doing: "working" }] }); return {}; } };`],
  ];
  const { reg } = await world(t, broken, "box");
  assert.equal((await reg.call("statusline.line", {}, "cli")).data.line, "vyre · juno working");
});
