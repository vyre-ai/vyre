import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { segmentsOf, textOf, splitToken, pillLabel, insertToken } from "./token-field-model.js";

test("text splits into words and tokens and comes back the same, doubled braces staying words", () => {
  const t = "Hi {steps.a.name}, your {{literal}} code is {trigger.code}.";
  const segs = segmentsOf(t);
  assert.deepEqual(segs.map((s) => ("token" in s ? `<${s.token}>` : s.text)), ["Hi ", "<steps.a.name>", ", your {{literal}} code is ", "<trigger.code>", "."]);
  assert.equal(textOf(segs), t);
  assert.deepEqual(segmentsOf(""), []);
});

test("a token's fallback is read apart from its path, with quotes taken off", () => {
  assert.deepEqual(splitToken("steps.x.id | someone"), { path: "steps.x.id", fallback: "someone" });
  assert.deepEqual(splitToken('steps.x.id | "a b"'), { path: "steps.x.id", fallback: "a b" });
  assert.deepEqual(splitToken("name"), { path: "name", fallback: null });
});

test("a pill says the option's words, or the path in label case, and shows its fallback", () => {
  const opts = [{ token: "{steps.f.rows}", label: "Contacts found" }, { token: "steps.p.email", label: "Person · Email" }];
  assert.equal(pillLabel("steps.p.email", opts), "Person · Email");
  assert.equal(pillLabel("steps.p.email | n/a", opts), "Person · Email (or n/a)");
  assert.equal(pillLabel("steps.create1.record.data.full_name", []), "Create1 · Record · Data · Full name");
  assert.equal(pillLabel("trigger.name", []), "Name");
});

test("a token is added at the end or at a place in the text", () => {
  assert.equal(insertToken("Hi ", "name"), "Hi {name}");
  assert.equal(insertToken("Hi !", "name", 3), "Hi {name}!");
  assert.equal(insertToken("x", "n", 99), "x{n}");
});
