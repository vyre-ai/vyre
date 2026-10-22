// A caption names the day only when the next message is on a later day. The same day, and a row with no time, add nothing.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { withDayRows } from "./day-rows.js";

const DAY = 86400000;
/** @param {string} key @param {string} [kind] */
const row = (key, kind = "text") => ({ type: "item", key, kind });
/** @param {number} a @param {number} b */
const same = (a, b) => Math.floor(a / DAY) === Math.floor(b / DAY);
/** @param {number} ms */
const label = (ms) => (Math.floor(ms / DAY) === 0 ? "Thursday, 1 January" : "Friday, 2 January");

test("a later day gets one caption before its first message", () => {
  /** @type {Record<string, number>} */
  const at = { u1: 1000, a1: 2000, u2: DAY + 1000, a2: DAY + 5000 };
  const rows = [row("u1", "user"), row("a1"), row("t1", "tool"), row("u2", "user"), row("a2")];
  const out = withDayRows(rows, (r) => at[r.key], label, same);
  assert.deepEqual(out.map((r) => (r.kind === "day" ? `day:${r.text}` : r.key)), ["u1", "a1", "t1", "day:Friday, 2 January", "u2", "a2"]);
  assert.equal(out.find((r) => r.kind === "day")?.key, "d:u2");
});

test("one day has no caption", () => {
  const out = withDayRows([row("u1", "user"), row("a1")], () => 1000, label, same);
  assert.deepEqual(out.map((r) => r.key), ["u1", "a1"]);
});

test("a row with no time does not start a day", () => {
  const out = withDayRows([row("n", "notice"), row("u1", "user")], (r) => (r.key === "u1" ? 5 : undefined), label, same);
  assert.deepEqual(out.map((r) => r.key), ["n", "u1"]);
});
