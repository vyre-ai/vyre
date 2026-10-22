// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterHistory, actorWords, QUICK, HISTORY_FILTERS, filtersFor } from "./history-model.js";

const person = { kind: "person", id: "p1", name: "Dana Marsh" };
const agent = { kind: "agent", id: "a1", name: "Assistant" };
const items = [
  { id: "1", kind: "email", actor: person, text: "Emailed the options", at: 100 },
  { id: "2", kind: "task", actor: agent, text: "Added a task", at: 300, undo: true },
  { id: "3", kind: "call", actor: person, text: "Logged a call", at: 200 },
  { id: "4", kind: "note", actor: agent, text: "Wrote a note", at: 400 },
];

test("filters keep their kind, newest first; notes include calls; agent actions are any kind an agent did", () => {
  assert.deepEqual(filterHistory(items, "all").map((i) => i.id), ["4", "2", "3", "1"]);
  assert.deepEqual(filterHistory(items, "email").map((i) => i.id), ["1"]);
  assert.deepEqual(filterHistory(items, "notes").map((i) => i.id), ["4", "3"]);
  assert.deepEqual(filterHistory(items, "agent").map((i) => i.id), ["4", "2"]);
  assert.deepEqual(filterHistory(items, "flow"), []);
  assert.deepEqual(filterHistory(undefined, "all"), []);
});

test("who did it: You for the person looking, the name for anyone else", () => {
  assert.equal(actorWords(person, "p1"), "You");
  assert.equal(actorWords(person, "p9"), "Dana Marsh");
  assert.equal(actorWords(agent, undefined), "Assistant");
  assert.equal(actorWords(/** @type {any} */ (undefined), "p1"), "Someone");
});

test("the filter row and the quick actions", () => {
  assert.equal(HISTORY_FILTERS[0][0], "all");
  assert.deepEqual(QUICK.map((q) => q.key), ["call", "meeting", "note"]);
  assert.deepEqual(QUICK.map((q) => q.label), ["Call", "Meeting", "Note"]);
  assert.deepEqual(QUICK.map((q) => q.sheet), ["Log a call", "Log a meeting", "Add a note"]);
});

test("only the filters that have something are offered", () => {
  assert.deepEqual(filtersFor(items).map(([k]) => k), ["all", "email", "task", "notes", "agent"]);
  assert.deepEqual(filtersFor([]).map(([k]) => k), ["all"]);
});
