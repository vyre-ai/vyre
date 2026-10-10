// A quiet list says a state in plain text, and a state that needs the person is still a chip.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { accessoryAsChip } from "./list-rules.js";

test("list accessory: a tight list says it plainly unless it needs you; any other list draws a chip", () => {
  assert.equal(accessoryAsChip(true, undefined), false, "settings: the devices count stays plain text");
  assert.equal(accessoryAsChip(true, "plain"), false);
  assert.equal(accessoryAsChip(true, "ok"), false);
  for (const t of ["accent", "warn", "err"]) assert.equal(accessoryAsChip(true, t), true, `${t} is a chip in a tight list`);
  for (const t of [undefined, "plain", "ok", "warn"]) assert.equal(accessoryAsChip(false, t), true, "a default list draws a chip");
});
