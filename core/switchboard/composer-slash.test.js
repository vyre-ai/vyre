// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import "../../scripts/mac-test-guard.mjs";
import { routeComposerLine } from "../../lib/thread-composer-route.js";

test("threads.slash routing agrees with routeComposerLine for remember and model", () => {
  assert.equal(routeComposerLine("/remember tabs").tool, "threads.remember");
  assert.equal(routeComposerLine("/model sonnet").input.model, "sonnet");
  assert.equal(routeComposerLine("!pwd").tool, "threads.shell");
});

test("threads.slash routing for planner, recall, roll and session slashes", () => {
  assert.equal(routeComposerLine("/later at 5pm x").tool, "planner.add");
  assert.equal(routeComposerLine("/find lease").tool, "recall.search");
  assert.equal(routeComposerLine("/roll").tool, "threads.roll");
  assert.equal(routeComposerLine("/effort low").tool, "threads.effort");
  assert.equal(routeComposerLine("/rewind").tool, "threads.rewind");
  assert.equal(routeComposerLine("/compact").tool, "threads.send");
  assert.equal(routeComposerLine("/permissions").sendAsMessage, true);
});
