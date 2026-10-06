import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { newId, newPrefixedId, isUuid, timeOf } from "./id.js";

test("new ids are time-ordered uuids: they sort by creation, say when they were made, and keep the v4 marker Twenty and Claude Code accept", () => {
  const a = newId(1_700_000_000_000), b = newId(1_700_000_000_001), c = newId(1_700_000_100_000);
  assert.ok(isUuid(a) && isUuid(b) && isUuid(c));
  assert.ok(a < b && b < c, "text order is creation order");
  assert.equal(timeOf(a), 1_700_000_000_000);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(newPrefixedId("ap"), /^ap_[0-9a-f-]{36}$/);
  assert.notEqual(newId(), newId());
});
