// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";

/** A vyred in a temp home with core/goals and a fake threads module for scope checks. */
async function boot(t) {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  // Fake threads.get: session "s1" is in project "harlow-legal", "s2" in "northwind".
  writeModule(root, "threads", { does: { tools: ["threads.get"] } }, `
    export default { async start(ctx) {
      ctx.tool("threads.get", { run: async ({ thread }) => ({ thread: { id: thread, project: thread === "s1" ? "harlow-legal" : thread === "s2" ? "northwind" : null } }) });
      return {};
    } };`);
  const db = open(path.join(home, "vyre.db"));
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "local" }, paths: { root: home }, log: () => {} });
  const core = discover([path.join(path.dirname(new URL(import.meta.url).pathname), "..")]).filter(f => f.manifest?.name === "goals");
  await reg.start([...core, ...discover([root])], { role: "local" });
  t.after(() => db.close());
  return { reg, events };
}

test("goals: a person's own goal is active at once; milestones tick in order and the last one finishes it", async t => {
  const { reg, events } = await boot(t);
  const g = (await reg.call("goals.set", { project: "harlow-legal", goal: "Ship the intake redesign", milestones: ["Draft the form", "Wire the API", "Ship it"] }, "deck")).data;
  assert.equal(g.state, "active");
  assert.equal(g.created_by, "person");
  assert.deepEqual(g.milestones.map(m => m.done), [false, false, false]);
  assert.equal((await reg.call("goals.milestone-done", { goal: g.id, index: 0 }, "deck")).data.milestones[0].done, true);
  const m1 = events.since(0).find(e => e.type === "goal.milestone");
  assert.deepEqual([m1.payload.goal, m1.payload.index, m1.payload.text], [g.id, 0, "Draft the form"]);
  assert.equal((await reg.call("goals.milestone-done", { goal: g.id, index: 0 }, "deck")).data.milestones[0].done, true, "no error re-ticking one already done");
  assert.equal(events.since(0).filter(e => e.type === "goal.milestone").length, 1, "and no second event for it");
  await reg.call("goals.milestone-done", { goal: g.id, index: 1 }, "deck");
  assert.equal((await reg.call("goals.get", { goal: g.id }, "deck")).data.state, "active", "not done until the last one");
  const done = (await reg.call("goals.milestone-done", { goal: g.id, index: 2 }, "deck")).data;
  assert.equal(done.state, "done");
  assert.ok(done.done_at);
  assert.ok(events.since(0).some(e => e.type === "goal.done" && e.payload.goal === g.id));
});

test("goals: an agent's goal is a proposal until a person's goals.accept - never its own", async t => {
  const { reg } = await boot(t);
  const g = (await reg.call("goals.set", { thread: "s1", goal: "Refactor the booking flow", milestones: ["Plan it"] }, "mcp:agent:kit", { thread: "s1" })).data;
  assert.equal(g.state, "pending");
  assert.equal(g.created_by, "mcp:agent:kit");
  assert.equal((await reg.call("goals.milestone-done", { goal: g.id, index: 0 }, "mcp:agent:kit", { thread: "s1" })).error.code, "bad_state", "not active yet");
  const accepted = (await reg.call("goals.accept", { goal: g.id }, "deck")).data;
  assert.equal(accepted.state, "active");
  assert.ok(accepted.accepted_at);
  assert.equal((await reg.call("goals.accept", { goal: g.id }, "deck")).error.code, "bad_state", "accepting twice refuses");
});

test("goals: milestone-done is scoped to the goal's own session or project - an agent elsewhere is refused, a person never is", async t => {
  const { reg } = await boot(t);
  const byThread = (await reg.call("goals.set", { thread: "s1", goal: "Fix the flaky test", milestones: ["Find it", "Fix it"] }, "deck")).data;
  // An agent in the same thread: fine.
  assert.equal((await reg.call("goals.milestone-done", { goal: byThread.id, index: 0 }, "mcp:agent:kit", { thread: "s1" })).data.milestones[0].done, true);
  // An agent in a different thread: refused.
  assert.equal((await reg.call("goals.milestone-done", { goal: byThread.id, index: 1 }, "mcp:agent:kit", { thread: "s2" })).error.code, "denied");
  // A person, from anywhere (no thread at all): always allowed.
  assert.equal((await reg.call("goals.milestone-done", { goal: byThread.id, index: 1 }, "deck")).data.milestones[1].done, true);

  const byProject = (await reg.call("goals.set", { project: "harlow-legal", goal: "Launch the campaign", milestones: ["Draft copy"] }, "deck")).data;
  // An agent whose own thread resolves to the same project: fine.
  assert.equal((await reg.call("goals.milestone-done", { goal: byProject.id, index: 0 }, "mcp:agent:kit", { thread: "s1" })).data.milestones[0].done, true);
});

test("goals: a goal needs a project or a thread; list filters by each", async t => {
  const { reg } = await boot(t);
  assert.equal((await reg.call("goals.set", { goal: "x", milestones: ["a"] }, "deck")).error.code, "bad_input");
  await reg.call("goals.set", { project: "harlow-legal", goal: "A", milestones: ["a"] }, "deck");
  await reg.call("goals.set", { thread: "s2", goal: "B", milestones: ["b"] }, "deck");
  assert.deepEqual((await reg.call("goals.list", { project: "harlow-legal" }, "deck")).data.map(g => g.goal), ["A"]);
  assert.deepEqual((await reg.call("goals.list", { thread: "s2" }, "deck")).data.map(g => g.goal), ["B"]);
  assert.equal((await reg.call("goals.list", {}, "deck")).data.length, 2);
});

test("goals: a bare mcp caller (a model in the person's own session) is not the person - its goals.set is a proposal", async t => {
  const { reg } = await boot(t);
  const g = (await reg.call("goals.set", { thread: "s1", goal: "Whatever a session's own model asks for", milestones: ["a"] }, "mcp", { thread: "s1" })).data;
  assert.equal(g.state, "pending", "a bare mcp caller is a model, not the person - it proposes too");
  // Nor may it accept its own proposal, or read outside its own session.
  assert.equal((await reg.call("goals.accept", { goal: g.id }, "mcp")).error.code, "denied");
  assert.equal((await reg.call("goals.list", { project: "northwind" }, "mcp", { thread: "s1" })).error.code, "denied");
});

test("goals: an mcp:thread caller cannot tick, propose into or read another thread's goal", async t => {
  const { reg } = await boot(t);
  const mine = (await reg.call("goals.set", { thread: "s1", goal: "Mine", milestones: ["a"] }, "deck")).data;
  const theirs = (await reg.call("goals.set", { thread: "s2", goal: "Theirs", milestones: ["a"] }, "deck")).data;
  const asS1 = (name, input) => reg.call(name, input, "mcp:thread:s1", { thread: "s1" });
  assert.equal((await asS1("goals.milestone-done", { goal: theirs.id, index: 0 })).error.code, "denied");
  assert.equal((await asS1("goals.get", { goal: theirs.id })).error.code, "denied");
  assert.equal((await asS1("goals.set", { thread: "s2", goal: "Sneaking in", milestones: ["a"] })).error.code, "denied");
  // Its own is fine.
  assert.equal((await asS1("goals.milestone-done", { goal: mine.id, index: 0 })).data.milestones[0].done, true);
  assert.equal((await asS1("goals.get", { goal: mine.id })).data.id, mine.id);
});

test("goals: an agent cannot list another project's goals, and gets only its own scope by default", async t => {
  const { reg } = await boot(t);
  await reg.call("goals.set", { project: "harlow-legal", goal: "Harlow's", milestones: ["a"] }, "deck");
  await reg.call("goals.set", { project: "northwind", goal: "Northwind's", milestones: ["a"] }, "deck");
  const asKitInS1 = input => reg.call("goals.list", input, "mcp:agent:kit", { thread: "s1" }); // s1 is in harlow-legal
  assert.equal((await asKitInS1({ project: "northwind" })).error.code, "denied");
  assert.deepEqual((await asKitInS1({})).data.map(g => g.goal), ["Harlow's"], "neither given: its own project by default, never every one");
  assert.deepEqual((await asKitInS1({ project: "harlow-legal" })).data.map(g => g.goal), ["Harlow's"]);
  // No thread at all (a bare module, no session context): nothing is its own.
  assert.deepEqual((await reg.call("goals.list", {}, "module:learn")).data, []);
});
