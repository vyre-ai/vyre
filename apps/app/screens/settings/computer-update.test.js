// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { computerView } from "./system-model.ts";

const want = { image: "ghcr.io/vyre-ai/agent-computer:0.6.0", version: "0.6.0", layout: 2 };

test("a computer made from an older image says so and offers the update", () => {
  const v = computerView({ present: true, current: false, want, have: { image: "ghcr.io/vyre-ai/agent-computer:0.5.4", version: "0.5.4", layout: 1 } });
  assert.deepEqual(v?.rows, [["Image", "agent-computer:0.6.0"], ["Vyre version", "0.6.0"], ["Made from", "agent-computer:0.5.4 (Vyre 0.5.4)"]]);
  assert.equal(v?.canUpdate, true);
  assert.match(String(v?.line), /closes every agent's screen/);
});

test("a current computer, or none yet, offers no update", () => {
  assert.equal(computerView({ present: true, current: true, want, have: { image: want.image, version: "0.6.0", layout: 2 } })?.canUpdate, false);
  const none = computerView({ present: false, current: true, want, have: null });
  assert.equal(none?.canUpdate, false);
  assert.match(String(none?.line), /no agent computer yet/);
});

test("no answer, or a refusal, leaves the section out", () => {
  assert.equal(computerView(null), null);
  assert.equal(computerView({}), null);
});
