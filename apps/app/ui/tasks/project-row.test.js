import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { rowFacts, movedWords, kindWord } from "./project-row.js";

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
