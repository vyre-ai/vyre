import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { rowFacts, movedWords, kindWord, orderProjects } from "./project-row.js";

const DAY = 86_400_000, NOW = Date.parse("2026-10-18T12:00:00");
const actors = [{ id: "me", name: "Alex", family: "person" }, { id: "dana", name: "Dana Marsh", family: "person" }, { id: "kit", name: "Kit", family: "assistant" }];
const world = (tasks) => ({ me: "me", actors, tasks, now: NOW });
const item = (data = {}, updated_at = NOW - 30 * DAY) => ({ def: { fields: [{ name: "owner", kind: "actor" }] }, row: { urn: "vyre://s/project/p1", id: "p1", updated_at, data: { owner: { actor: "dana" }, ...data } } });
const task = (o) => ({ id: o.id || "t", record: "vyre://s/project/p1", title: "Write the brief", state: "ready", doer: "dana", updated_at: NOW - 5 * DAY, ...o });

test("the next line says what waits on the reader first, then what is under way, then what comes next", () => {
  assert.equal(rowFacts(world([task({ doer: "me", title: "Sign off the logo round" })]), item()).next, "Waiting on you: sign off the logo round");
  assert.equal(rowFacts(world([task({ doer: "me", title: "Sign off the logo round" })]), item()).needsYou, true);
  assert.equal(rowFacts(world([task({ state: "working", doer: "kit", title: "Draft the launch email" })]), item()).next, "Kit is working on draft the launch email");
  assert.equal(rowFacts(world([task({ state: "waiting", title: "Review the landing page draft" })]), item()).next, "Next: review the landing page draft");
  assert.equal(rowFacts(world([task({ state: "done" })]), item()).next, "Nothing open");
  assert.equal(rowFacts(world([]), item()).next, "No to-dos yet");
});

test("progress is done over all to-dos, the team is the owner then the others, at most four, and a project with no to-dos has no progress", () => {
  const f = rowFacts(world([task({ id: "a", state: "done" }), task({ id: "b", state: "ready", doer: "kit" }), task({ id: "c", state: "skipped" })]), item());
  assert.deepEqual([f.done, f.total], [2, 3]);
  assert.deepEqual(f.team.slice(0, 2), ["dana", "kit"], "the owner first");
  assert.equal(rowFacts(world([]), item()).total, 0);
  assert.ok(rowFacts(world([]), item()).team.length <= 4);
});

test("when it last moved is the newest of the project and its to-dos, in plain words", () => {
  assert.equal(rowFacts(world([task({ updated_at: NOW - 3 * 3_600_000 })]), item()).moved, "Moved today");
  assert.equal(movedWords(NOW - 20 * 3_600_000, NOW), "Moved today");
  assert.equal(movedWords(NOW - 30 * 3_600_000, NOW), "Moved yesterday");
  assert.equal(movedWords(NOW - 4 * DAY, NOW), "Moved 4 days ago");
  assert.equal(movedWords(NOW - 10 * DAY, NOW), "Moved last week");
  assert.equal(movedWords(NOW - 45 * DAY, NOW), "Moved over a month ago");
  assert.equal(movedWords(0, NOW), "");
});

test("a row names its kind in a word; a project with none is Simple and the Personal one is Private", () => {
  assert.equal(kindWord({ kind: "stages" }), "Stages");
  assert.equal(kindWord({ kind: "client" }), "Client");
  assert.equal(kindWord({ kind: "ongoing" }), "Ongoing");
  assert.equal(kindWord({}), "Simple");
  assert.equal(kindWord(undefined), "Simple");
  assert.equal(kindWord({ personal_of: "per_x", kind: "stages" }), "Private");
});

test("the list puts the Personal project first and the rest by the newest change, ties by name", () => {
  const it = (name, updated_at, data = {}) => ({ def: { fields: [] }, row: { urn: `vyre://s/project/${name}`, id: name, updated_at, data: { name, ...data } } });
  const w = world([task({ record: "vyre://s/project/Old", updated_at: NOW - 40 * DAY }), task({ record: "vyre://s/project/Busy", updated_at: NOW - 1 * DAY })]);
  const list = [it("Old", NOW - 50 * DAY), it("Zed", NOW - 20 * DAY), it("Personal", NOW - 90 * DAY, { personal_of: "per_me" }), it("Busy", NOW - 30 * DAY), it("Abe", NOW - 20 * DAY)];
  assert.deepEqual(orderProjects(w, list).map((i) => i.row.id), ["Personal", "Busy", "Abe", "Zed", "Old"]);
  assert.deepEqual(list.map((i) => i.row.id), ["Old", "Zed", "Personal", "Busy", "Abe"], "the input is not changed");
  assert.deepEqual(orderProjects(w, []), []);
});

test("the Personal project reads as pinned and private, whatever its to-dos say", () => {
  const f = rowFacts(world([task({ doer: "me", title: "Buy milk" })]), item({ personal_of: "me" }));
  assert.equal(f.next, "Notes, drafts and chats that are just yours");
  assert.equal(f.moved, "Pinned");
  assert.equal(f.needsYou, false, "nothing in Personal asks the team for anything");
  assert.deepEqual(f.team, []);
});
