// A step's people: an assignee, an optional approver and followers, each with a box of their own. Tags in a box are references, resolved when the step runs.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX, BOB } from "./testing/world.js";
import { tagsIn, resolveTags, parseUrn } from "./tags.js";
import { checkFlow } from "./schema.js";

const base = (steps) => ({ format: 1, name: "t", label: "T", authorship: "human", trigger: { on: "manual" }, steps });

test("tags are found and read back as written", () => {
  assert.deepEqual(tagsIn("See [[record:vyre://s/matter/m1]], [[field:this#client]], [[records:matter]] and [[file:docs/a.pdf]].").map(t => t.kind), ["record", "field", "records", "file"]);
  assert.deepEqual(parseUrn("vyre://s/matter/m1"), { type: "matter", id: "m1" });
});

test("tags resolve to the record as it is now; one that cannot be read says so and never throws", async () => {
  const io = { here: "vyre://s/matter/m1", read: async (t, id) => (id === "m1" ? { data: { client: "Jane", stage: "Intake" } } : null), query: async () => [{ id: "m1", data: { client: "Jane" } }] };
  assert.equal(await resolveTags("Client: [[field:this#client]]", io), "Client: Jane");
  assert.match(await resolveTags("[[record:this]]", io), /^matter m1: client: Jane; stage: Intake$/);
  assert.match(await resolveTags("[[record:vyre://s/matter/gone]]", io), /\[unavailable: /);
  assert.match(await resolveTags("[[records:matter]]", io), /^- m1: client: Jane$/);
  assert.equal(await resolveTags("[[file:a/b.txt]]", io), "[file: a/b.txt]");
});

test("the schema takes followers, notes, a brief and an agent step's checker, and refuses the rest", () => {
  const ok = base([{ id: "a", kind: "agent", assistant: "teammate:research", title: "t", instructions: "x [[record:this]]", output: { kind: "note" }, checker: "role:attorney", followers: ["person:per_bob", "role:manager"], notes: { approver: "check it", followers: "fyi" } },
    { id: "b", kind: "assign", to: "role:attorney", title: "t", output: { kind: "note" }, brief: "do [[field:this#client]]", followers: ["teammate:intake"] }]);
  assert.deepEqual(checkFlow(ok), []);
  const bad = base([{ id: "a", kind: "assign", to: "role:attorney", title: "t", output: { kind: "note" }, followers: ["everyone"], notes: { other: "x" } }]);
  assert.match(JSON.stringify(checkFlow(bad)), /followers are up to 10/);
  assert.match(JSON.stringify(checkFlow(bad)), /notes\.other/);
});

test("at run, the boxes are resolved from the live record and each follower gets a note task", async () => {
  const w = await world();
  const chain = w.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: w.cat.space });
  const m = await w.kernel.records.create(chain, "matter", { client: "Jane", stage: "Intake" });
  const { id } = await install(w, base([{ id: "go", kind: "assign", to: "person:" + BOB.id, title: "Call", output: { kind: "note" }, brief: "Call [[field:this#client]] today.", notes: { followers: "Heads up on [[field:this#client]]" }, followers: ["person:" + ALEX.id], record: m.urn }]));
  await w.runner.start(id, {}, w.kernel.as(ALEX));
  await settle(w);
  await w.kernel.pump();
  const rows = w.kernel.tasks;
  const main = rows.find(t => t.title === "Call"), follow = rows.find(t => t.title === "Following: Call");
  assert.ok(main, "the assignee has the task");
  assert.match(main.form.brief, /^Call Jane today\.$/);
  assert.ok(follow, "the follower has a Now item: " + JSON.stringify((await w.runner.listRuns({ flow: id })).map(r => r.steps)).slice(0, 900));
  assert.equal(follow.doer.id, ALEX.id);
  assert.match(follow.form.brief, /Heads up on Jane/);
});

test("each box is resolved for its own reader: a record the assignee cannot read is not handed to them through the follower's reach", async () => {
  const w = await world();
  const chain = w.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: w.cat.space });
  const m = await w.kernel.records.create(chain, "matter", { client: "Jane", stage: "Intake" });
  const { id } = await install(w, base([{ id: "go", kind: "assign", to: "person:" + BOB.id, title: "Call", output: { kind: "note" }, brief: "Call [[field:this#client]]", notes: { followers: "FYI [[field:this#client]]" }, followers: ["person:" + ALEX.id], record: m.urn }]));
  // BOB's chain may not read the record (the kernel answers denied), everyone else's may
  const get = w.kernel.records.get.bind(w.kernel.records);
  w.kernel.records.get = async (c, ...rest) => { if (c.hops.at(-1).actor.id === BOB.id && c.hops[0].actor.kind === "automation") throw Object.assign(new Error("not allowed"), { code: "denied" }); return get(c, ...rest); };
  await w.runner.start(id, {}, w.kernel.as(ALEX));
  await settle(w);
  await w.kernel.pump();
  const rows = w.kernel.tasks;
  const main = rows.find(t => t.title === "Call"), follow = rows.find(t => t.title === "Following: Call");
  assert.ok(main && follow, "both tasks exist");
  assert.match(main.form.brief, /\[unavailable: /, "the assignee cannot read it, so the tag is not resolved for them");
  assert.match(follow.form.brief, /FYI Jane/, "the follower can, so theirs is");
});

test("the approver's box never rides on the doer's task: the doer who cannot read a record is not handed it through the approver, and the approver has a note task of their own", async () => {
  const w = await world();
  const chain = w.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: w.cat.space });
  const m = await w.kernel.records.create(chain, "matter", { client: "Jane-SECRET", stage: "Intake" });
  const { id } = await install(w, base([{ id: "go", kind: "assign", to: "person:" + BOB.id, title: "Call", output: { kind: "note" }, checker: "person:" + ALEX.id, notes: { approver: "CHK [[field:this#client]]" }, record: m.urn }]));
  const get = w.kernel.records.get.bind(w.kernel.records);
  w.kernel.records.get = async (c, ...rest) => { if (c.hops.at(-1).actor.id === BOB.id && c.hops[0].actor.kind === "automation") throw Object.assign(new Error("not allowed"), { code: "denied" }); return get(c, ...rest); };
  await w.runner.start(id, {}, w.kernel.as(ALEX));
  await settle(w);
  await w.kernel.pump();
  const doerTask = w.kernel.tasks.find(t => t.title === "Call"), checkTask = w.kernel.tasks.find(t => t.title === "To check: Call");
  assert.ok(doerTask && checkTask);
  assert.equal(JSON.stringify(doerTask).includes("Jane-SECRET"), false, "nothing of the record is on the doer's task");
  assert.equal(checkTask.doer.id, ALEX.id);
  assert.match(checkTask.form.brief, /CHK Jane-SECRET/);
});

test("an agent can be the approver of an internal step (not of a send)", async () => {
  const w = await world();
  w.kernel.agentMakers = { research: ALEX.id }; w.kernel.roleOfPerson = () => "admin"; // research was made by an admin
  const { id } = await install(w, base([{ id: "go", kind: "assign", to: "teammate:intake", title: "Draft notes", output: { kind: "note" }, checker: "teammate:research" }]));
  await w.runner.start(id, {}, w.kernel.as(ALEX));
  await settle(w);
  await w.kernel.pump();
  const t = w.kernel.tasks.find(x => x.title === "Draft notes");
  assert.ok(t, "the task was made");
  assert.deepEqual([t.checker.kind, t.checker.id], ["agent", "research"]);
});

test("an agent's approval never satisfies a human gate: the outward step after it still waits for a person's yes", async () => {
  const w = await world();
  w.kernel.agentMakers = { research: ALEX.id }; w.kernel.roleOfPerson = () => "admin";
  const { id } = await install(w, base([
    { id: "go", kind: "assign", to: "person:" + BOB.id, title: "Draft the notice", output: { kind: "note" }, checker: "teammate:research", await: true },
    { id: "send", kind: "call", action: "email.send", resource: `vyre://${w.cat.space}/message/outbox`, input: { to: "jane@example.test", subject: "Notice" } },
  ]));
  await w.runner.start(id, {}, w.kernel.as(ALEX));
  await settle(w);
  await w.kernel.pump();
  const t = w.kernel.tasks.find(x => x.title === "Draft the notice");
  assert.ok(t, "the task was made");
  await w.kernel.tasksApi.start(w.kernel.as(BOB), t.id);
  await w.kernel.tasksApi.complete(w.kernel.as(BOB), t.id, { note: "done", sources: ["https://example.test/a"] });
  const agent = w.kernel.chains.fromFacts({ kind: "agent_session", agent: "research", session: "s", thread: "t", vouched: true });
  const done = await w.kernel.tasksApi.decide(agent, t.id, { outcome: "approved" });
  assert.equal(done.state, "done");
  assert.equal(done.approved_by.kind, "agent");
  await settle(w);
  const [run] = await w.runner.listRuns({ flow: id });
  assert.equal(run.steps.go.status, "done", "the agent's approval finished the internal task");
  assert.equal(run.state, "waiting", JSON.stringify(run.error || run.steps.send));
  assert.equal(run.steps["send?ask"] && run.steps["send?ask"].status, "waiting", "the send waits for a person at the Gate: " + Object.keys(run.steps).join(","));
});

test("Try it: flows.simulate on a form Flow with sample data says which steps would run and does nothing", async () => {
  const w = await world();
  const { createFlows } = await import("./index.js");
  const t = createFlows({ kernel: w.kernel, chains: { forFlow: x => w.kernel.chainFor(x), forModule: x => w.kernel.moduleChain(x), forDoer: x => w.kernel.moduleChain({ module: "flows", approver: x.approver }) }, catalog: () => w.cat, store: w.store, clock: () => w.clock.t, emit: () => {}, ports: w.runner.ports });
  const flow = { format: 1, name: "try", authorship: "builder", trigger: { on: "web", path: "x" }, steps: [
    { id: "big", kind: "decide", if: "trigger.amount > 500", then: [{ id: "ask", kind: "ask", to: "role:attorney", title: "Approve" }], else: [{ id: "mk", kind: "create", type: "payment", set: { amount: 1 } }] }] };
  const made = await t.tools["flows.define"]({ hops: [{ actor: ALEX }] }, { flow });
  const out = await t.tools["flows.simulate"]({ hops: [{ actor: ALEX }] }, { id: made.id, samples: [{ amount: 600 }] });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.matched, 1);
  assert.ok(out.runs[0].ran.includes("big"));
  assert.equal(w.kernel.tasks.length, 0, "nothing was made");
});
