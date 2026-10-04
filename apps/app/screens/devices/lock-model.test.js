// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCK_CONTROL, LOCK_TITLE, lockOf, lockedToast, unlockLine, unlockRefusal } from "./lock-model.js";

const NOW = 1_800_000_000_000;

test("a locked device shows its lock until it ends, another device and an ended lock show nothing", () => {
  const answer = { locked: [{ device: "dev_a", until: NOW + 600_000 }, { device: "dev_b", until: NOW - 1 }] };
  assert.deepEqual(lockOf(answer, "dev_a", NOW), { until: NOW + 600_000 });
  assert.equal(lockOf(answer, "dev_b", NOW), null);
  assert.equal(lockOf(answer, "dev_c", NOW), null);
  assert.equal(lockOf({}, "dev_a", NOW), null);
  assert.equal(lockOf(null, "dev_a", NOW), null);
});

test("the row says when the lock lifts by itself, with the control's own name", () => {
  assert.match(unlockLine(NOW + 600_000, NOW), /^Unlocks by itself at .*, in 10 minutes\.$/);
  assert.match(unlockLine(NOW + 1000, NOW), /in 1 minute\.$/);
  assert.equal(LOCK_TITLE, "Locked after wrong answers");
  assert.equal(LOCK_CONTROL, "Let it sign in again");
  assert.equal(lockedToast("Mac"), "Mac can sign in again.");
});

test("a refused unlock says why in plain words: not the owner, no presence, no such tool", () => {
  assert.match(unlockRefusal("not_allowed"), /Only the owner/);
  assert.match(unlockRefusal("denied"), /Only the owner/);
  assert.match(unlockRefusal("presence_required"), /Approve on this device/);
  assert.match(unlockRefusal("no_such_tool"), /cannot lift a lock yet/);
  assert.match(unlockRefusal("on_phone"), /on your phone/);
  assert.equal(unlockRefusal("weird"), "That did not work. Nothing was changed.");
});

test("the control calls renew-allow with the device and nothing else", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("./RealLock.tsx", import.meta.url), "utf8");
  assert.match(src, /tool\("presence\.person\.renew-allow", \{ device \}\)/);
  assert.match(src, /tool<[^>]*>\("presence\.person\.locked"\)/);
  assert.match(src, /kind="hold"/);
});
