import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spaceSkills, toggledSkill } from "./skills-picker-model.js";

test("only the Space's skills are offered, by name, and a chosen one that is gone stays", () => {
  const data = { skills: [{ id: "space/voice", name: "Voice", level: "space", description: "Plain words" }, { id: "personal/mine", name: "Mine", level: "personal" }, { id: "vyre/base", name: "Base", level: "vyre" }, { id: "space/accuracy", name: "Accuracy", level: "space" }] };
  const list = spaceSkills(data, ["space/voice", "space/old"]);
  assert.deepEqual(list.map((s) => [s.id, s.on, !!s.gone]), [["space/accuracy", false, false], ["vyre/base", false, false], ["space/old", true, true], ["space/voice", true, false]]);
  assert.deepEqual(spaceSkills(null, []), []);
});

test("at most ten skills per slot", () => {
  const ten = Array.from({ length: 10 }, (_, i) => `space/s${i}`);
  assert.deepEqual(toggledSkill(ten, "space/x"), ten);
  assert.deepEqual(toggledSkill(["a"], "a"), []);
  assert.deepEqual(toggledSkill(["a"], "b"), ["a", "b"]);
});
