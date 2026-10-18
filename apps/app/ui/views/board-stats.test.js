// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { closingFilter, forecastFromStats, monthWindow, noteFromStats, sumName } from "./board-stats.js";

const def = { fields: [{ name: "stage", kind: "stage", options: ["Lead", "Won", "Lost"] }, { name: "amount", kind: "number" }, { name: "weighted_value", kind: "number" }, { name: "close_date", kind: "date" }] };

test("a column note says the count and the total", () => {
  assert.equal(sumName(def), "amount");
  assert.equal(noteFromStats(def, { key: "Lead", count: 3, amount: 31000 }), "3 · $31,000");
  assert.equal(noteFromStats(def, { key: "Lead", count: 2, amount: 0 }), "2");
  assert.equal(noteFromStats(def, undefined), undefined);
});

test("the forecast leaves out Won and Lost", () => {
  const all = { groups: [{ key: "Lead", weighted_value: 1000, amount: 4000 }, { key: "Won", weighted_value: 9000, amount: 9000 }, { key: "Lost", weighted_value: 5, amount: 5 }] };
  const closing = { groups: [{ key: "Lead", amount: 2500 }, { key: "Won", amount: 9000 }] };
  assert.equal(forecastFromStats(def, all, closing), "$1,000 weighted · $2,500 closing this month");
  assert.equal(forecastFromStats({ fields: [] }, all, closing), "");
  assert.equal(forecastFromStats(def, undefined, closing), "");
});

test("the month window is this month, the end exclusive", () => {
  const w = monthWindow(new Date(2026, 9, 18).getTime());
  assert.equal(w.from, "2026-10-01");
  assert.equal(w.to, "2026-11-01");
  assert.deepEqual(closingFilter(new Date(2026, 11, 5).getTime()).and.map((c) => c.value), ["2026-12-01", "2027-01-01"]);
});
