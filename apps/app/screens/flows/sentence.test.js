import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { whenDo } from "./sentence.js";

test("a stored Flow reads as When X, do Y", () => {
  assert.equal(whenDo("A payment is received", ["Find or create the matter for the payer", "Set its stage to Intake"]), "When a payment is received, find or create the matter for the payer, then set its stage to Intake.");
});
test("more than three steps are counted, none is said", () => {
  assert.equal(whenDo("When a matter enters Intake", ["A", "B", "C", "D", "E"]), "When a matter enters Intake, A, then B, then C, then 2 more steps.");
  assert.equal(whenDo("", []), "When it starts, do nothing yet.");
});

test("the sentence in pieces joins to the same words and marks the trigger and steps", async () => {
  const { whenDo, sentenceParts } = await import("./sentence.js");
  for (const labels of [[], ["Send a note"], ["A", "B", "C", "D", "E"]]) {
    const parts = sentenceParts("When a form comes in", labels);
    assert.equal(parts.map((p) => p.text).join(""), whenDo("When a form comes in", labels));
  }
  assert.deepEqual(sentenceParts("A form comes in", ["Send a note"]).filter((p) => p.token).map((p) => p.text), ["a form comes in", "send a note"]);
});
