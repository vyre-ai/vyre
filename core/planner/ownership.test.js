// The planner files a to-do with its own service chain, so the ownership rule judges the writer as the person the to-do is for (kernel/gateway/ownership.js actingForOf): a member's to-do goes only into a
// project she is on, an owner's anywhere. A real kernel, the planner's own tools.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, memberFacts, OWNER, MEMBERS, SPACE } from "./testing.js";
import { PROJECT } from "../../records/core-types.js";

const MEMBER = MEMBERS[0];
const person = (/** @type {string} */ id, /** @type {string} */ space) => ({ actor: { kind: "person", id, space } });

async function rig(/** @type {any} */ t) {
  const w = await world(t);
  const R = w.k.gateway.records;
  await R.define(w.owner, { add_types: [{ ...PROJECT, fields: PROJECT.fields.filter((/** @type {any} */ f) => f.name !== "client") }] });
  const space = SPACE;
  const theirs = await R.create(w.owner, "project", { name: "Owner's", slug: "owners", owner: person(OWNER, space) });
  const mine = await R.create(w.owner, "project", { name: "Hers", slug: "hers", owner: person(MEMBER, space) });
  return { w, theirs, mine };
}
const asMember = (/** @type {any} */ w, /** @type {string} */ tool, /** @type {any} */ input) => w.callAs(memberFacts(MEMBER), tool, input);

// MEASURED GAP, not fixed here (core/planner is rc1-b's tonight): the planner files EVERY to-do as the Space owner's (doer = K.owner, assigned_by = service:planner), whoever called it, so the ownership rule sees
// the owner as the writer and a member's planner.add reaches the owner's project. The planner has to refuse a project the CALLING person is not on before it writes; these two are the tests for that.
const GAP = { todo: "the planner files every to-do as the owner's: it must judge the calling member (rc1-b)" };
test("a member's to-do through the planner goes only into a project she is on", {}, async t => {
  const { w, theirs, mine } = await rig(t);
  const refused = await asMember(w, "planner.add", { kind: "todo", title: "into the owner's project", project: theirs.urn });
  assert.ok(refused.error, "refused: " + JSON.stringify(refused).slice(0, 200));
  assert.match(String(refused.error.message), /project you are on/);
  assert.ok((await asMember(w, "planner.add", { kind: "todo", title: "into hers", project: mine.urn })).data, "her own project");
  assert.ok((await asMember(w, "planner.add", { kind: "todo", title: "no project" })).data, "no project");
  assert.ok((await w.call("planner.add", { kind: "todo", title: "owner anywhere", project: theirs.urn })).data, "the owner files under any project");
});

test("a member cannot move her to-do into the owner's project with planner.update either", {}, async t => {
  const { w, theirs, mine } = await rig(t);
  const made = (await asMember(w, "planner.add", { kind: "todo", title: "hers", project: mine.urn })).data;
  assert.ok(made && made.id, "control: she made one in her project");
  const moved = await asMember(w, "planner.update", { item: made.id, project: theirs.urn });
  assert.ok(moved.error, "refused: " + JSON.stringify(moved).slice(0, 200));
  const back = await asMember(w, "planner.update", { item: made.id, title: "renamed" });
  assert.ok(back.data, "she still edits her own item: " + JSON.stringify(back).slice(0, 160));
});

test("a member's to-do is filed FOR HER, never as the owner's; another member cannot change, finish or remove it, the owner can", async t => {
  const { w, mine } = await rig(t);
  const OTHER = MEMBERS[1];
  const made = (await asMember(w, "planner.add", { kind: "todo", title: "hers", project: mine.urn })).data;
  assert.ok(made && made.id);
  const task = await w.k.gateway.ask.get(w.owner, made.id);
  assert.equal(task.doer && task.doer.id, MEMBER, "the doer is the calling member, not the Space owner");
  assert.notEqual(task.doer && task.doer.id, OWNER);
  const other = (tool, input) => w.callAs(memberFacts(OTHER), tool, input);
  for (const [tool, input] of [["planner.update", { item: made.id, title: "mine now" }], ["planner.delete", { item: made.id }]]) {
    const r = await other(tool, input);
    assert.equal(r.error?.code, "denied", `${tool} by another member: ${JSON.stringify(r).slice(0, 160)}`);
    assert.match(String(r.error?.message), /someone else's/);
  }
  assert.ok((await w.call("planner.update", { item: made.id, title: "owner edits" })).data, "the owner changes any to-do");
  assert.ok((await asMember(w, "planner.update", { item: made.id, title: "she edits" })).data, "and she still changes her own");
  assert.ok(!(await asMember(w, "planner.delete", { item: made.id })).error, "and removes it");
});

test("a member's planner reads show her own items, not the owner's or another member's; the owner sees all", async t => {
  const { w } = await rig(t);
  const OTHER = MEMBERS[1];
  const as2 = (/** @type {string} */ tool, /** @type {any} */ input) => w.callAs(memberFacts(OTHER), tool, input);
  const at = "2027-01-01T10:00:00Z";
  await w.call("planner.add", { kind: "reminder", title: "OWNER reminder", at });
  await w.call("planner.add", { kind: "note", title: "OWNER note" });
  await w.call("planner.add", { kind: "todo", title: "OWNER todo" });
  const hers = (await asMember(w, "planner.add", { kind: "note", title: "HER note" })).data;
  const herTodo = (await asMember(w, "planner.add", { kind: "todo", title: "HER todo" })).data;
  await as2("planner.add", { kind: "reminder", title: "THIRD reminder", at });
  const titles = async (/** @type {any} */ r) => (r.data || []).map((/** @type {any} */ x) => x.title).sort();
  assert.deepEqual(await titles(await asMember(w, "planner.list", { state: "all" })), ["HER note", "HER todo"], "she lists only hers");
  assert.deepEqual(await titles(await as2("planner.list", { state: "all" })), ["THIRD reminder"]);
  assert.equal((await titles(await w.call("planner.list", { state: "all" }))).length, 6, "the owner sees every item");
  const others = (await w.call("planner.list", { state: "all" })).data.find((/** @type {any} */ x) => x.title === "OWNER note");
  const peek = await asMember(w, "planner.get", { item: others.id });
  assert.ok(peek.error, "planner.get of the owner's note refused: " + JSON.stringify(peek).slice(0, 160));
  assert.ok((await asMember(w, "planner.get", { item: hers.id })).data, "and her own is readable");
  assert.ok(herTodo.id);
  const up = await asMember(w, "planner.upcoming", { hours: 72 });
  assert.ok(!JSON.stringify(up).includes("OWNER"), "upcoming holds none of the owner's");
});

test("a member's reminder goes only on a chat she is in", async t => {
  const { w } = await rig(t);
  const r = await asMember(w, "planner.add", { kind: "reminder", title: "into the owner's chat", at: "2027-01-01T10:00:00Z", thread: "thr_not_hers" });
  assert.ok(r.error, "refused: " + JSON.stringify(r).slice(0, 200));
  assert.match(String(r.error.message), /chat you are in/);
  assert.ok((await w.call("planner.add", { kind: "reminder", title: "owner may", at: "2027-01-01T10:00:00Z", thread: "thr_any" })).data, "the owner is not held to it");
});
