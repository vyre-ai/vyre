import test from "node:test";
import assert from "node:assert/strict";
import { canFallback, deviceLine, lastStep, lendState, list, pick, removeText, stepCount, stepLine, stepWords } from "./wink.js";

test("reverse scan has four steps and the code fallback three", () => {
  assert.equal(stepCount(false), 4);
  assert.equal(stepCount(true), 3);
  assert.equal(lastStep(false), 3);
});

test("only a computer can use a typed code", () => {
  assert.equal(canFallback("computer"), true);
  assert.equal(canFallback("phone"), false);
  assert.equal(canFallback("server"), false);
});

test("the step line says which way it is going", () => {
  assert.equal(stepLine(1, false), "Step 2 of 4 · reverse scan");
  assert.equal(stepLine(0, true), "Step 1 of 3 · using a code");
});

test("every step has words, both ways", () => {
  for (const fb of [false, true]) for (let i = 0; i < stepCount(fb); i++) assert.ok(stepWords("computer", i, fb));
  assert.match(stepWords("server", 0, false), /new server shows its ring/);
});

test("a wrong number fails", () => {
  assert.equal(pick("47").ok, true);
  assert.equal(pick("12").ok, false);
});

test("a computer is lent only when both sides say yes", () => {
  assert.equal(lendState({ spaceAllows: true, meAllows: false }), "waiting");
  assert.equal(lendState({ spaceAllows: true, meAllows: true }), "sharing");
  assert.equal(lendState({ spaceAllows: false, meAllows: true }), "waiting");
});

test("lists read like a sentence", () => {
  assert.equal(list(["Mine"]), "Mine");
  assert.equal(list(["Mine", "Harlow Legal"]), "Mine and Harlow Legal");
  assert.equal(list(["A", "B", "C"]), "A, B and C");
});

test("a device says which spaces it is in", () => {
  assert.equal(deviceLine("Alex's Mac", ["Mine", "Harlow Legal"]), "Alex's Mac is in Mine and Harlow Legal");
  assert.equal(deviceLine("Alex's Mac", []), "Alex's Mac is not in any space");
});

test("removal says what happens first", () => {
  assert.match(removeText("Device", "Alex's Mac"), /stops it opening anything of yours/);
  assert.match(removeText("Person", "Dana Reyes"), /Dana loses its projects and servers at once/);
});
