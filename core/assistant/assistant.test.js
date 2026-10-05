// @ts-check
// The assistant module against fake waiting, agents, memory, settings and context modules in a
// temp home. Nothing here reads real memory, real agents or a real clock.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { allowed, recent, patterns, phrase } from "./index.js";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../../kernel/bus.js";
import { tempHome, writeModule } from "../../test/helpers.js";

const AGENTS = `export default { async start(ctx) {
  ctx.tool("agents.list", { effect: "read", run: async () => globalThis.__agents || [{ name: "juno", kind: "assistant", doing: "idle" }] });
  return {};
} };`;

const WAITING = `export default { async start(ctx) {
  ctx.tool("waiting.count", { effect: "read", run: async () => globalThis.__waiting || { count: 0, by_kind: { ask: 0, draft: 0, reminder: 0, pairing: 0 } } });
  return {};
} };`;

const MEMORY = `export default { async start(ctx) {
  ctx.tool("memory.facts", { effect: "read", run: async () => ({ facts: globalThis.__facts || [] }) });
  return {};
} };`;

const SETTINGS = `export default { async start(ctx) {
  ctx.tool("settings.get", { effect: "read", run: async ({ key }) => ({ value: globalThis.__settings ? globalThis.__settings[key] : undefined }) });
  return {};
} };`;

const CONTEXT = `export default { async start(ctx) {
  ctx.tool("context.now", { effect: "read", run: async () => globalThis.__now || { day: null, tz: null, localTime: null } });
  return {};
} };`;

async function world(t, { mods = ["agents", "waiting", "memory", "settings", "context"], home: given } = {}) {
  const home = given || tempHome(t);
  const root = path.join(home, "mods");
  const specs = { agents: AGENTS, waiting: WAITING, memory: MEMORY, settings: SETTINGS, context: CONTEXT };
  const tools = { agents: ["agents.list"], waiting: ["waiting.count"], memory: ["memory.facts"], settings: ["settings.get"], context: ["context.now"] };
  for (const m of mods) writeModule(root, m, { roles: ["box", "local"], does: { tools: tools[m] } }, specs[m]);
  const db = open(path.join(home, "vyre.db"));
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "local" }, paths: { root: home }, log: () => {} });
  const core = discover([path.join(path.dirname(new URL(import.meta.url).pathname), "..")]).filter(f => f.manifest?.name === "assistant");
  await reg.start([...core, ...discover([root])], { role: "local" });
  const seen = [];
  events.on("assistant.briefed", e => seen.push(e));
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await reg.stop?.(); } };
  t.after(async () => {
    await stop(); db.close();
    for (const k of ["__agents", "__waiting", "__facts", "__settings", "__now"]) delete globalThis[k];
  });
  const call = async (tool, input = {}, caller = "cli", meta = {}) => reg.call(tool, input, caller, meta);
  return { reg, events, call, seen, stop, home };
}

test("allowed: person surfaces, the user's own session, and the assistant itself; never a project agent", async t => {
  const { call } = await world(t);
  globalThis.__agents = [{ name: "juno", kind: "assistant" }, { name: "kit", kind: "agent" }];
  const c = (tool, input) => call(tool, input, "module:test");
  for (const caller of ["cli", "local", "deck", "capsule", "mcp", "mcp:thread:abc123"]) assert.equal(await allowed(caller, c), true, caller);
  // The daemon's vouched meta decides, not the label text (RC-1).
  assert.equal(await allowed("mcp:thread:abc123", c, { thread: "abc123" }), true, "a vouched session");
  assert.equal(await allowed("mcp:thread:fake", c, { agent: "kit" }), false, "a vouched named agent that is not the assistant");
  assert.equal(await allowed("mcp:agent:kit", c, { thread: "t1" }), true, "an agent label no one vouched for claims nothing: it is the session itself");
  assert.equal(await allowed("mcp:agent:juno", c), true, "the assistant");
  assert.equal(await allowed("mcp:agent:kit", c), false, "a project-scoped agent");
  assert.equal(await allowed("tailnet:alex@example.com", c), false);
  assert.equal(await allowed("mcp:agent:nobody", c), false);
});

test("recent: minutes and hours always, days within a week, weeks/months/years never", () => {
  for (const age of ["1 minute", "40 minutes", "3 hours", "1 day", "7 days"]) assert.equal(recent(age), true, age);
  for (const age of ["8 days", "2 weeks", "3 months", "1 year", "", "some time"]) assert.equal(recent(age), false, age);
});

test("patterns: a conflict always, a correction only within the last week and only wrong or replace", async t => {
  const { call } = await world(t);
  globalThis.__facts = [
    { id: "a", text: "Harlow Legal is at 12 Main St", conflict: true },
    { id: "b", text: "Northwind Bakery opens at 8am", conflict: false, correction: { action: "wrong", age: "2 days" } },
    { id: "c", text: "Alex prefers email", conflict: false, correction: { action: "wrong", age: "3 weeks" } },
    { id: "d", text: "Alex's number ends 0199", conflict: false, correction: { action: "confirm", age: "1 day" } },
    { id: "e", text: "no correction here", conflict: false, correction: null },
  ];
  const p = await patterns((tool, input) => call(tool, input, "module:test"));
  assert.deepEqual(p.map(x => x.fact).sort(), ["a", "b"]);
  assert.equal(p.find(x => x.fact === "a").kind, "conflict");
  assert.equal(p.find(x => x.fact === "b").kind, "corrected");
});

test("patterns: memory.facts failing or absent gives no patterns, never an error", async t => {
  const { call } = await world(t, { mods: ["agents", "waiting", "settings", "context"] });
  assert.deepEqual(await patterns((tool, input) => call(tool, input, "module:test")), []);
});

test("phrase: one paragraph, at most three patterns, singular and plural counts", () => {
  assert.equal(phrase({ waiting: { count: 0, by_kind: {} }, agentsBusy: 0, patterns: [] }), "Nothing waiting on you.");
  assert.equal(phrase({ waiting: { count: 1, by_kind: { ask: 1 } }, agentsBusy: 1, patterns: [] }),
    "1 thing waiting on you (1 ask). 1 agent working.");
  assert.equal(phrase({ waiting: { count: 3, by_kind: { ask: 2, draft: 1 } }, agentsBusy: 2, patterns: [{ text: "X." }, { text: "Y." }, { text: "Z." }, { text: "never shown." }] }),
    "3 things waiting on you (2 asks, 1 draft). 2 agents working. X. Y. Z.");
});

test("assistant.brief: composes waiting, agents and patterns; refuses a caller that is not the person or the assistant", async t => {
  const { call } = await world(t);
  globalThis.__waiting = { count: 2, by_kind: { ask: 1, draft: 1, reminder: 0, pairing: 0 } };
  globalThis.__agents = [{ name: "juno", kind: "assistant", doing: "idle" }, { name: "kit", kind: "agent", doing: "working" }];
  globalThis.__facts = [{ id: "a", text: "a fact", conflict: true }];

  const r = await call("assistant.brief", {}, "cli");
  assert.equal(r.data.text, "2 things waiting on you (1 ask, 1 draft). 1 agent working. a fact is unresolved: more than one project believes something different.");
  assert.equal(r.data.agents_busy, 1);

  const asAssistant = await call("assistant.brief", {}, "mcp:agent:juno");
  assert.equal(asAssistant.data.text, r.data.text);

  const denied = await call("assistant.brief", {}, "mcp:agent:kit");
  assert.equal(denied.error.code, "denied");
});

test("digest: fires once per local day when on, never when off, and again the next day", async t => {
  const { call, events, seen } = await world(t);
  const fire = (changed, surface = "phone") => events.emit("context", "context.changed", { changed, surface }, {});
  const wait = () => new Promise(r => setTimeout(r, 20));

  globalThis.__settings = { "assistant.digest_enabled": false };
  globalThis.__now = { day: "2026-09-28", tz: "America/Los_Angeles", localTime: "2026-09-28T00:00:05-07:00" };
  fire(["localTime"]);
  await wait();
  assert.equal(seen.length, 0, "off by default");

  globalThis.__settings = { "assistant.digest_enabled": true };
  fire(["localTime"]);
  await wait();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].payload.day, "2026-09-28");

  // The same day again, even from another surface: no second digest.
  fire(["tz"], "capsule");
  await wait();
  assert.equal(seen.length, 1);

  // A change that isn't the clock never triggers it.
  fire(["app"], "capsule");
  await wait();
  assert.equal(seen.length, 1);

  // The next day fires again.
  globalThis.__now = { day: "2026-09-29", tz: "America/Los_Angeles", localTime: "2026-09-29T00:00:05-07:00" };
  fire(["localTime"]);
  await wait();
  assert.equal(seen.length, 2);
  assert.equal(seen[1].payload.day, "2026-09-29");

  assert.ok(!(await call("assistant.brief", {}, "cli")).error, "still callable on demand");
});

test("digest: the fired-for day survives a restart, so a second start on the same day never fires twice", async t => {
  const first = await world(t);
  globalThis.__settings = { "assistant.digest_enabled": true };
  globalThis.__now = { day: "2026-09-28", tz: "America/Los_Angeles", localTime: "2026-09-28T09:00:00-07:00" };
  first.events.emit("context", "context.changed", { changed: ["localTime"], surface: "phone" }, {});
  await new Promise(r => setTimeout(r, 20));
  await first.stop();

  // A fresh registry over the same home: the fired-for day lives in the home's own vyre.db, so
  // this second start (as a real restart would) reads it back rather than firing again.
  const second = await world(t, { home: first.home });
  second.events.emit("context", "context.changed", { changed: ["localTime"], surface: "phone" }, {});
  await new Promise(r => setTimeout(r, 20));
  assert.equal(second.seen.length, 0, "same day, already fired, no restart double-fire");
});
