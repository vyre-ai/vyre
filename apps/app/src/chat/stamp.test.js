import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { metaOf } from "./stamp.js";
import { timeLineOf } from "../time/show.js";

test("a message says when, in the sender's zone and the viewer's when they differ", () => {
  const at = Date.UTC(2026, 9, 5, 1, 0);
  assert.equal(metaOf({ at, tz: "Asia/Kuala_Lumpur" }, (ms, z) => timeLineOf(ms, z, "America/Los_Angeles")), "9:00 am GMT+8 · 6:00 pm Sun your time");
  assert.equal(metaOf({ at, tz: "Asia/Kuala_Lumpur" }, (ms, z) => timeLineOf(ms, z, "Asia/Kuala_Lumpur")), "9:00 am");
  assert.equal(metaOf({ at, pickedUp: true }, () => "9:00 am"), "9:00 am \u00b7 picked up");
  assert.equal(metaOf({}, () => "x"), undefined);
});
