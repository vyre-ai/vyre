// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { editInput, isMine, noteOf } from "./note-model.js";

test("a note reads from either answer shape", () => {
  const n = { id: "n1", title: "Call", body: "Ask about Q4", visibility: "space", record: { urn: "u/deal/1" }, owner: "person:a" };
  assert.deepEqual(noteOf({ item: n }), { id: "n1", title: "Call", body: "Ask about Q4", visibility: "space", record: "u/deal/1", owner: "person:a" });
  assert.equal(noteOf(n)?.id, "n1");
  assert.equal(noteOf(null), null);
  assert.equal(noteOf({ item: {} }), null);
});

test("only the writer's own note is mine", () => {
  assert.equal(isMine({ owner: "person:a" }, "a"), true);
  assert.equal(isMine({ owner: "person:a" }, "person:a"), true);
  assert.equal(isMine({ owner: "person:b" }, "a"), false);
  assert.equal(isMine({}, "a"), false);
  assert.equal(isMine({ owner: "person:a" }, undefined), false);
});

test("an edit sends only what changed", () => {
  const was = { id: "n1", title: "Call", body: "x" };
  assert.deepEqual(editInput(was, { title: "Call", body: "y" }), { item: "n1", body: "y" });
  assert.deepEqual(editInput(was, { title: "Meet", body: "x" }), { item: "n1", title: "Meet" });
  assert.equal(editInput(was, { title: "Call", body: "x" }), null);
});
