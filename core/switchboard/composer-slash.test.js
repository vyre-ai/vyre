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
