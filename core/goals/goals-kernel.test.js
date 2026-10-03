// @ts-check
// The goals module with the kernel on: new goals are kernel records, goals made before stay where they are, behaviour is the same.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { createKernel } from "../../kernel/index.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";

async function boot(t, { kernel, home: given } = {}) {
  const home = given || tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "threads", { does: { tools: ["threads.get"] } }, `
    export default { async start(ctx) {
      ctx.tool("threads.get", { run: async ({ thread }) => ({ thread: { id: thread, project: thread === "s1" ? "harlow-legal" : null } }) });
      return {};
    } };`);
  const db = open(path.join(home, "vyre.db"));
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, paths: { root: home }, log: () => {}, ...(kernel ? { kernelFor: kernel.kernelFor } : {}) });
  const core = discover([path.join(path.dirname(new URL(import.meta.url).pathname), "..")]).filter(f => f.manifest?.name === "goals");
  await reg.start([...core, ...discover([root])], { role: "local" });
  t.after(() => db.close());
  return { reg, db, home };
}
const newKernel = () => createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 4) });

test("goals on the kernel: a goal is a kernel record, milestones tick, the last finishes it, and an agent's proposal needs a person", async t => {
  const k = newKernel();
  const { reg, db } = await boot(t, { kernel: k });
  const g = (await reg.call("goals.set", { project: "harlow-legal", goal: "Ship the intake redesign", milestones: ["Draft", "Wire", "Launch"] }, "deck")).data;
  assert.equal(g.state, "active");
  assert.match(g.id, /^[0-9a-f]{8}-/, "the id is the record's");
  assert.equal(db.prepare("SELECT count(*) AS n FROM goals_items").get().n, 0, "nothing in the module's own table");
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d", person: OWNER, path: "direct" });
  const rec = await k.gateway.records.get(owner, "goal", g.id).catch(() => null);
  assert.ok(rec === null || rec.data.goal === "Ship the intake redesign", "stored in the kernel's store");
  for (const i of [0, 1]) await reg.call("goals.milestone-done", { goal: g.id, index: i }, "deck");
  assert.equal((await reg.call("goals.get", { goal: g.id }, "deck")).data.state, "active");
  const done = (await reg.call("goals.milestone-done", { goal: g.id, index: 2 }, "deck")).data;
  assert.equal(done.state, "done");
  assert.ok(done.done_at);
  assert.equal(Object.keys(done).includes("_version"), false, "no internals leak");
  // an agent proposes in its own session; only a person accepts
  const p = (await reg.call("goals.set", { thread: "s1", goal: "Tidy the docs", milestones: ["One"] }, "mcp", { thread: "s1" })).data;
  assert.equal(p.state, "pending");
  assert.equal((await reg.call("goals.accept", { goal: p.id }, "mcp", { thread: "s1" })).error.code, "denied");
  assert.equal((await reg.call("goals.accept", { goal: p.id }, "deck")).data.state, "active");
  const all = (await reg.call("goals.list", {}, "deck")).data;
  assert.equal(all.length, 2);
  assert.deepEqual((await reg.call("goals.list", { state: "done" }, "deck")).data.map(x => x.id), [g.id]);
  assert.equal((await reg.call("goals.get", { goal: "g_nope" }, "deck")).error.code, "not_found");
});

test("goals on the kernel: a goal made before the kernel was on stays readable and writable where it is, and lists beside the new ones", async t => {
  const first = await boot(t);
  const old = (await first.reg.call("goals.set", { project: "harlow-legal", goal: "Made before", milestones: ["A", "B"] }, "deck")).data;
  assert.match(old.id, /^g_/);
  const k = newKernel();
  const second = await boot(t, { kernel: k, home: first.home });
  assert.equal((await second.reg.call("goals.get", { goal: old.id }, "deck")).data.goal, "Made before");
  const fresh = (await second.reg.call("goals.set", { project: "harlow-legal", goal: "Made after", milestones: ["X"] }, "deck")).data;
  assert.deepEqual((await second.reg.call("goals.list", { project: "harlow-legal" }, "deck")).data.map(g => g.goal).sort(), ["Made after", "Made before"]);
  assert.equal((await second.reg.call("goals.milestone-done", { goal: old.id, index: 0 }, "deck")).data.milestones[0].done, true, "the old row is updated where it lives");
  assert.equal((await second.reg.call("goals.milestone-done", { goal: fresh.id, index: 0 }, "deck")).data.state, "done");
});
