// @ts-check
// The undo module against fake planner, mail, threads and agents modules in a temp home. The
// recording module is played by calling undo.record as "module:watchers", the label vyred gives a
// built-in module; a fake home module could not call it at all (reach "modules" is Vyre's own).

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { prune, isPerson, sameActor, KEEP_MS } from "./index.js";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";

const g = /** @type {any} */ (globalThis);

const PLANNER = ["planner", { does: { tools: ["planner.add", "planner.remove", "planner.person", "planner.present"] } },
  `export default { async start(ctx) {
    ctx.tool("planner.add", { run: async i => { globalThis.items.add(i.title); return { item: i.title }; } });
    ctx.tool("planner.remove", { run: async i => { globalThis.removed.push(i); if (globalThis.breakRemove) throw new Error("the planner is busy"); globalThis.items.delete(i.item); return { ok: true }; } });
    ctx.tool("planner.person", { callers: ["cli", "deck"], run: async () => ({}) });
    ctx.tool("planner.present", { presence: true, run: async () => ({}) });
    return {}; } };`];
const MAIL = ["mail", { does: { tools: [{ name: "mail.unsend", reach: "asked", outward: "send" }] } },
  `export default { async start(ctx) { ctx.tool("mail.unsend", { run: async () => ({}) }); return {}; } };`];
const THREADS = ["threads", { does: { tools: ["threads.answer"] } },
  `export default { async start(ctx) { ctx.tool("threads.answer", { run: async () => ({}) }); return {}; } };`];
const AGENTS = ["agents", { does: { tools: ["agents.list"] } },
  `export default { async start(ctx) { ctx.tool("agents.list", { run: async () => { globalThis.agentCalls++; return [{ name: "juno", kind: "assistant" }, { name: "kit", kind: "agent" }]; } }); return {}; } };`];

async function world(t, fakes = [PLANNER, MAIL, THREADS, AGENTS]) {
  g.items = new Set(); g.removed = []; g.breakRemove = false; g.agentCalls = 0;
  const home = tempHome(t);
  const root = path.join(home, "mods");
  for (const [name, manifest, src] of fakes) writeModule(root, name, { roles: ["box", "local"], watches: { emits: [] }, ...manifest }, src);
  const db = open(path.join(home, "vyre.db"));
  const events = new Events(db);
  const heard = [];
  events.on("undo.*", e => heard.push({ type: e.type, ...e.payload }));
  const reg = new Registry({ db, events, config: { role: "box" }, paths: { root: home }, log: () => {} });
  const core = discover([path.join(path.dirname(new URL(import.meta.url).pathname), "..")]).filter(f => f.manifest?.name === "undo");
  await reg.start([...core, ...discover([root])], { role: "box" });
  t.after(async () => { await reg.stop?.(); db.close(); });
  const call = async (tool, input = {}, caller = "cli") => reg.call(tool, input, caller);
  const record = (extra = {}, caller = "module:watchers") => call("undo.record", { tool: "planner.add", input: { title: "Call alex" },
    summary: "Added a reminder to call alex", inverse: { tool: "planner.remove", input: { item: "Call alex" } }, ...extra }, caller);
  return { db, heard, call, record };
}

test("record, list and run: the stored inverse runs once and the row says undone", async t => {
  const w = await world(t);
  g.items.add("Call alex");
  const r = await w.record({ actor: "mcp:agent:kit", why: { said: "s1", junk: "x" } });
  assert.ok(r.data && /^u_/.test(r.data.id), JSON.stringify(r));
  const id = r.data.id;

  const [row] = (await w.call("undo.list")).data.rows;
  assert.deepEqual(row, { id, at: row.at, actor: "mcp:agent:kit", actor_kind: "agent", tool: "planner.add", summary: "Added a reminder to call alex",
    state: "done", why: { said: "s1" }, can_undo: true });
  assert.ok(!("inverse_input" in row) && !("input" in row), "list never hands out the inputs");

  const done = await w.call("undo.run", { id }, "deck");
  assert.deepEqual(done.data, { id, state: "undone" });
  assert.deepEqual(g.removed, [{ item: "Call alex" }]);
  assert.ok(!g.items.has("Call alex"));
  const after = (await w.call("undo.list")).data.rows[0];
  assert.equal(after.state, "undone");
  assert.equal(after.can_undo, false);
  const stored = /** @type {any} */ (w.db.prepare("SELECT undone_by, undone_at FROM undo_acted WHERE id = ?").get(id));
  assert.equal(stored.undone_by, "deck");
  assert.ok(stored.undone_at > 0);
  assert.deepEqual(w.heard.map(e => e.type), ["undo.recorded", "undo.done"]);
  assert.deepEqual(w.heard[0], { type: "undo.recorded", id, actor_kind: "agent", tool: "planner.add" });

  // Idempotent: a second tap runs nothing.
  assert.deepEqual((await w.call("undo.run", { id }, "capsule")).data, { id, state: "undone", already: true });
  assert.equal(g.removed.length, 1);
});

test("two taps at once run the inverse once", async t => {
  const w = await world(t);
  const { id } = (await w.record()).data;
  const [a, b] = await Promise.all([w.call("undo.run", { id }, "deck"), w.call("undo.run", { id }, "capsule")]);
  assert.equal(g.removed.length, 1);
  assert.deepEqual([a.data.already, b.data.already].sort(), [true, undefined].sort());
});

test("undo.record refuses an inverse it could not safely replay", async t => {
  const w = await world(t);
  const bad = async (tool, why) => {
    const r = await w.record({ inverse: { tool, input: {} } });
    assert.equal(r.error?.code, "bad_input", `${tool}: ${JSON.stringify(r)}`);
    assert.match(r.error.message, why, tool);
  };
  await bad("planner.nothing", /no tool planner\.nothing/);
  await bad("mail.unsend", /outside \(send\)/);
  await bad("threads.answer", /person's own/);
  await bad("gate.approve", /person's own/);                // HUMAN_ONLY, by name, whether or not it runs here
  await bad("planner.person", /not open to modules/);         // callers of the person's surfaces alone
  await bad("planner.present", /needs the person present/);
  await bad("undo.run", /undo's own/);
  assert.equal((await w.record({ summary: "  " })).error?.code, "bad_input");
  assert.equal((await w.call("undo.list")).data.rows.length, 0, "nothing refused was kept");
});

test("undo.record is Vyre's modules' only: a model, a surface and an agent never see it", async t => {
  const w = await world(t);
  for (const caller of ["mcp:agent:juno", "mcp", "harness:agent:kit", "cli", "deck"]) {
    assert.equal((await w.record({}, caller)).error?.code, "no_such_tool", caller);
  }
  // An added module (here the fake planner, from the home) is refused by the loader's default-deny.
  assert.equal((await w.record({}, "module:planner")).error?.code, "not_declared");
});

test("actor_kind: assistant and agent from agents.list, cached; module and person from the label", async t => {
  const w = await world(t);
  const kind = async actor => {
    const { id } = (await w.record(actor ? { actor } : {})).data;
    return /** @type {any} */ (w.db.prepare("SELECT actor, actor_kind FROM undo_acted WHERE id = ?").get(id));
  };
  assert.deepEqual({ ...(await kind("mcp:agent:juno")) }, { actor: "mcp:agent:juno", actor_kind: "assistant" });
  assert.equal((await kind("harness:agent:juno")).actor_kind, "assistant");
  assert.equal(g.agentCalls, 1, "the second lookup was a cache hit");
  assert.equal((await kind("mcp:agent:kit")).actor_kind, "agent");
  assert.deepEqual({ ...(await kind(undefined)) }, { actor: "module:watchers", actor_kind: "module" }, "no actor: the recording module's own");
  assert.equal((await kind("deck")).actor_kind, "person");
  assert.equal((await kind("mcp:thread:t1")).actor_kind, "agent");
  const rows = (await w.call("undo.list", { actor_kind: "assistant" })).data.rows;
  assert.deepEqual(rows.map(r => r.actor), ["harness:agent:juno", "mcp:agent:juno"]);
  assert.equal((await w.call("undo.list", { actor: "deck" })).data.rows.length, 1);
  assert.equal((await w.call("undo.list", { limit: 2 })).data.rows.length, 2);
  assert.equal((await w.call("undo.list", { since: Date.now() + 60_000 })).data.rows.length, 0);
});

test("without the agents module an agent is still recorded, as an agent", async t => {
  const w = await world(t, [PLANNER]);
  const { id } = (await w.record({ actor: "mcp:agent:juno" })).data;
  assert.equal((await w.call("undo.list")).data.rows[0].actor_kind, "agent");
  assert.equal((await w.call("undo.run", { id }, "mcp:agent:juno")).data.state, "undone");
});

test("an agent undoes only its own rows; the person any; a module its own", async t => {
  const w = await world(t);
  const kits = (await w.record({ actor: "mcp:agent:kit" })).data.id;
  const junos = (await w.record({ actor: "mcp:agent:juno" })).data.id;
  const watchers = (await w.record()).data.id;
  assert.equal((await w.call("undo.run", { id: junos }, "mcp:agent:kit")).error?.code, "denied");
  assert.equal((await w.call("undo.run", { id: kits }, "cli:agent:juno")).error?.code, "denied", "an agent naming a person's surface is still that agent");
  assert.equal((await w.call("undo.run", { id: kits }, "mcp")).error?.code, "denied", "a plain model session is not the person");
  assert.equal((await w.call("undo.run", { id: watchers }, "module:mail")).error?.code, "denied");
  assert.equal(g.removed.length, 0);
  assert.equal((await w.call("undo.run", { id: kits }, "harness:agent:kit")).data.state, "undone", "the same agent over another transport");
  assert.equal((await w.call("undo.run", { id: junos }, "mcp:agent:juno")).data.state, "undone", "the assistant, its own last action");
  assert.equal((await w.call("undo.run", { id: watchers }, "module:watchers")).data.state, "undone");
  assert.equal((await w.call("undo.run", { id: "u_none" }, "deck")).error?.code, "not_found");
});

test("a failing inverse marks the row failed, says so, and can be tried again", async t => {
  const w = await world(t);
  const { id } = (await w.record()).data;
  g.breakRemove = true;
  const r = await w.call("undo.run", { id }, "deck");
  assert.equal(r.error?.code, "undo_failed");
  assert.match(r.error.message, /the planner is busy/);
  const row = /** @type {any} */ (w.db.prepare("SELECT state, error FROM undo_acted WHERE id = ?").get(id));
  assert.deepEqual({ ...row }, { state: "failed", error: "the planner is busy" });
  assert.deepEqual(w.heard.map(e => e.type), ["undo.recorded", "undo.failed"]);
  assert.equal((await w.call("undo.list")).data.rows[0].can_undo, true);
  g.breakRemove = false;
  assert.equal((await w.call("undo.run", { id }, "deck")).data.state, "undone");
});

test("labels: who counts as the person, and the same actor across transports", () => {
  for (const c of ["cli", "local", "deck", "capsule", "mobile", "tailnet:alex-mbp"]) assert.ok(isPerson(c), c);
  for (const c of ["mcp", "mcp:agent:kit", "cli:agent:kit", "module:watchers", "hook", "tailnet:agent:kit", "tailnet-guest:x"]) assert.ok(!isPerson(c), c);
  assert.ok(sameActor("mcp:agent:kit", "harness:agent:kit"));
  assert.ok(!sameActor("mcp:agent:kit", "mcp:agent:juno"));
  assert.ok(sameActor("module:watchers", "module:watchers"));
  assert.ok(!sameActor("mcp", "mcp:agent:kit"));
});

test("retention: rows older than 30 days go at start and on the daily prune", async t => {
  const w = await world(t);
  const now = Date.now();
  const ins = w.db.prepare(`INSERT INTO undo_acted (id, at, actor, actor_kind, tool, summary, input, inverse_tool, inverse_input, state)
    VALUES (?, ?, 'module:watchers', 'module', 'planner.add', 'old', '{}', 'planner.remove', '{}', 'done')`);
  ins.run("u_old", now - KEEP_MS - 1000);
  ins.run("u_new", now - KEEP_MS + 60_000);
  assert.equal(prune(w.db, now), 1);
  assert.deepEqual(w.db.prepare("SELECT id FROM undo_acted").all().map(r => /** @type {any} */ (r).id), ["u_new"]);
});
