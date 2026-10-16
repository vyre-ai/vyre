// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import "../../../../scripts/mac-test-guard.mjs";
import { laterNoteFromLine, rewindPointsFromStore, secondOpinionTargets } from "./capabilities-model.js";

test("rewindPointsFromStore lists person messages newest first", () => {
  const store = {
    rows: () => [{ key: "u:a" }, { key: "u:b" }],
    item: (k) => (k === "u:a" ? { kind: "user", text: "first" } : k === "u:b" ? { kind: "user", text: "second" } : null),
  };
  assert.deepEqual(rewindPointsFromStore(store).map((p) => p.uuid), ["b", "a"]);
});

test("laterNoteFromLine parses /later", () => {
  assert.deepEqual(laterNoteFromLine('/later "at 5pm" check inbox'), { title: "check inbox", when: "at 5pm" });
});

test("secondOpinionTargets skips the author", () => {
  const t = secondOpinionTargets([{ id: "assistant:juno", name: "juno", family: "assistant" }, { id: "assistant:kit", name: "kit", family: "assistant" }], "assistant:juno");
  assert.equal(t.length, 1);
  assert.equal(t[0].id, "assistant:kit");
});
