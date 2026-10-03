import test from "node:test";
import assert from "node:assert/strict";
import { COPY, SOFTWARE_KEY, deviceSub, deviceLine, lastStep, lendState, list, removeText, stepCount, stepLine, stepWords, wordsStep } from "./wink.js";

test("a phone or computer has four steps and a server three", () => {
  assert.equal(stepCount("phone"), 4);
  assert.equal(stepCount("computer"), 4);
  assert.equal(stepCount("server"), 3);
  assert.equal(lastStep("phone"), 3);
  assert.equal(wordsStep("phone"), 2);
  assert.equal(wordsStep("server"), 1);
});

test("there is no typed-code path left", async () => {
  const w = await import("./wink.js");
  assert.equal("canFallback" in w, false);
  assert.equal("pick" in w, false);
  for (const k of ["phone", "computer", "server"]) for (let i = 0; i < stepCount(k); i++) {
    assert.doesNotMatch(stepLine(i, k) + stepWords(k, i), /type the code|enter the code|typed it|pick the number|WINK-/i);
  }
});

test("the step line says what happens", () => {
  assert.equal(stepLine(1, "phone"), "Step 2 of 4 · scan, then confirm three words");
  assert.equal(stepLine(0, "server"), "Step 1 of 3 · scan or paste, then confirm three words");
});

test("every step has words", () => {
  for (const k of ["phone", "computer", "server"]) for (let i = 0; i < stepCount(k); i++) assert.ok(stepWords(k, i));
  assert.match(stepWords("server", 0), /A short typed code is not accepted/);
  assert.match(stepWords("computer", 0), /new computer shows its code/);
});

test("the words ask for a match and name who is asking", () => {
  assert.match(COPY.pick, /one of the three choices, or type all three words/);
  assert.equal(COPY.askLine("Alex's iPhone"), "Alex's iPhone is asking to pair. Both screens show these three words.");
  assert.match(COPY.rejected, /Nothing was paired/);
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

test("a device row says its key is in software only when it is", () => {
  assert.deepEqual(deviceSub("Phone", "Now", false), ["Phone, last used Now"]);
  assert.deepEqual(deviceSub("Phone", "Now", undefined), ["Phone, last used Now"]);
  assert.deepEqual(deviceSub("Server", "Now", true), ["Server, last used Now", "This device keeps its key in software"]);
  assert.equal(SOFTWARE_KEY, "This device keeps its key in software");
});
