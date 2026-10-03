import { test } from "node:test";
import assert from "node:assert/strict";
import { mintId, isRecordId, idTime, _resetIds } from "./ids.js";

test("an id is a UUID with marker 4 and the variant bits set", () => {
  const id = mintId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(isRecordId(id));
  assert.ok(!isRecordId("01a101b0-a370-7000-b5d3-0f0df5924247"), "a true v7 marker is not ours");
});

test("the timestamp round-trips", () => {
  _resetIds();
  const t = Date.UTC(2026, 9, 3, 12, 0, 0);
  assert.equal(idTime(mintId({ now: () => t })), t);
});

test("ids minted in order sort in order, also within one millisecond and across a clock step back", () => {
  _resetIds();
  let t = 1_790_000_000_000;
  const ids = [];
  for (let i = 0; i < 5000; i++) ids.push(mintId({ now: () => t }));
  t -= 50; // the clock steps back
  for (let i = 0; i < 100; i++) ids.push(mintId({ now: () => t }));
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted);
  assert.equal(new Set(ids).size, ids.length);
});

test("counter overflow moves to the next millisecond instead of repeating", () => {
  _resetIds();
  const t = 1_790_000_000_000;
  const ids = [];
  for (let i = 0; i < 4200; i++) ids.push(mintId({ now: () => t }));
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(new Set(ids).size, ids.length);
});
