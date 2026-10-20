// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { idle, moved, refused, sent, workingLine } from "./working-model.js";

test("a send shows the line at once, before the box says anything", () => {
  const a = sent("waiting");
  assert.equal(workingLine({ busy: false, connection: "live", awaiting: a.on }), "Working on it");
});

test("the line stays through the turn and goes when it ends", () => {
  let a = sent("waiting");
  a = moved(a, { busy: false, state: "waiting" });
  assert.equal(a.on, true, "no news yet");
  a = moved(a, { busy: true, state: "working" });
  assert.equal(a.on, true);
  a = moved(a, { busy: false, state: "waiting" });
  assert.equal(a.on, false);
});

test("a failure that comes before any working ends it", () => {
  const a = moved(sent("waiting"), { busy: false, state: "failed" });
  assert.equal(a.on, false);
});

test("a refused send puts nothing up", () => {
  assert.deepEqual(refused(), idle());
  assert.equal(moved(idle(), { busy: true, state: "working" }).on, false);
});

test("a kept copy that says working is not shown until the link is live", () => {
  assert.equal(workingLine({ busy: true, connection: "connecting", awaiting: false }), "");
  assert.equal(workingLine({ busy: true, connection: "live", awaiting: false }), "Working on it");
  assert.equal(workingLine({ busy: false, connection: "live", awaiting: false }), "");
});
