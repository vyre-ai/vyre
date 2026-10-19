// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSample, sampleCount, isDayOne } from "./first-visit.js";

test("a record is sample data when the box tagged it so, in its labels or its data", () => {
  assert.equal(isSample({ labels: { sample: true } }), true);
  assert.equal(isSample({ data: { sample: true } }), true);
  assert.equal(isSample({ data: { sample: "yes" } }), false);
  assert.equal(isSample({ data: {} }), false);
  assert.equal(isSample(undefined), false);
});

test("sample data is counted across every type", () => {
  const world = { byType: { contact: [{ data: { sample: true } }, { data: {} }], deal: [{ labels: { sample: true } }] } };
  assert.equal(sampleCount(world), 2);
  assert.equal(sampleCount(undefined), 0);
});

test("day one: a handful of records and no sample data; a busy Space or one with samples is not", () => {
  assert.equal(isDayOne({ byType: { contact: [{}, {}, {}], organization: [{}] } }), true);
  assert.equal(isDayOne({ byType: { contact: Array.from({ length: 7 }, () => ({})) } }), false);
  assert.equal(isDayOne({ byType: { contact: [{ data: { sample: true } }] } }), false);
  assert.equal(isDayOne({ byType: {} }), true);
  assert.equal(isDayOne(undefined), true);
});
