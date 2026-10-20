// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { whoLabel, whoOfChat } from "./who-model.js";

const me = "person:me";
test("a one-to-one chat opens the other one's pane, a group opens the group's", () => {
  assert.deepEqual(whoOfChat([{ id: me, name: "You", family: "person" }, { id: "agent:kit", name: "kit", family: "assistant" }], me, "c1"), { kind: "agent", id: "kit" });
  assert.deepEqual(whoOfChat([{ id: me, name: "You", family: "person" }, { id: "person:dana", name: "Dana", family: "person" }], me, "c1"), { kind: "person", id: "person:dana" });
  assert.deepEqual(whoOfChat([{ id: me, name: "You", family: "person" }, { id: "agent:kit", name: "kit", family: "assistant" }, { id: "person:dana", name: "Dana", family: "person" }], me, "c9"), { kind: "group", id: "c9" });
});

test("nobody else, or only a model, opens nothing; labels are plain words", () => {
  assert.equal(whoOfChat([{ id: me, name: "You", family: "person" }], me, "c1"), null);
  assert.equal(whoOfChat([{ id: "model:x", name: "Claude", family: "model" }], me, "c1"), null);
  assert.equal(whoLabel("assistant"), "Your assistant");
  assert.equal(whoLabel("group"), "Group");
});
