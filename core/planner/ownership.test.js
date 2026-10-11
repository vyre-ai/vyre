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

test("a member's to-do through the planner goes only into a project she is on", async t => {
  const { w, theirs, mine } = await rig(t);
  const refused = await asMember(w, "planner.add", { kind: "todo", title: "into the owner's project", project: theirs.urn });
  assert.ok(refused.error, "refused: " + JSON.stringify(refused).slice(0, 200));
  assert.match(String(refused.error.message), /project you are on/);
  assert.ok((await asMember(w, "planner.add", { kind: "todo", title: "into hers", project: mine.urn })).data, "her own project");
  assert.ok((await asMember(w, "planner.add", { kind: "todo", title: "no project" })).data, "no project");
  assert.ok((await w.call("planner.add", { kind: "todo", title: "owner anywhere", project: theirs.urn })).data, "the owner files under any project");
});

test("a member cannot move her to-do into the owner's project with planner.update either", async t => {
  const { w, theirs, mine } = await rig(t);
  const made = (await asMember(w, "planner.add", { kind: "todo", title: "hers", project: mine.urn })).data;
  assert.ok(made && made.id, "control: she made one in her project");
  const moved = await asMember(w, "planner.update", { item: made.id, project: theirs.urn });
  assert.ok(moved.error, "refused: " + JSON.stringify(moved).slice(0, 200));
  const back = await asMember(w, "planner.update", { item: made.id, title: "renamed" });
  assert.ok(back.data, "she still edits her own item: " + JSON.stringify(back).slice(0, 160));
});
