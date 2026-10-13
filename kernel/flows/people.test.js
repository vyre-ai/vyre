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
  w.kernel.rules.push({ match: i => i.action === "records.read" && i.chain.hops.at(-1).actor.id === BOB.id && i.chain.hops[0].actor.kind === "automation", effect: "deny", reason: "no access" });
  w.kernel.denied.add(BOB.id);
  await w.runner.start(id, {}, w.kernel.as(ALEX));
  await settle(w);
  await w.kernel.pump();
  const rows = w.kernel.tasks;
  const main = rows.find(t => t.title === "Call"), follow = rows.find(t => t.title === "Following: Call");
  assert.ok(main && follow, "both tasks exist");
  assert.match(main.form.brief, /\[unavailable: /, "the assignee cannot read it, so the tag is not resolved for them");
  assert.match(follow.form.brief, /FYI Jane/, "the follower can, so theirs is");
});
