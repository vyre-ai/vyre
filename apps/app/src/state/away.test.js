// "While you were away": only a major change raises the card, only after a real absence, and what was seen never shows twice.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ABSENCE_MS, changesSince, isMajor, awayLines, wasAway, visited, readState, topSeq } from "./away.js";

const ev = (/** @type {string} */ type, /** @type {number} */ seq, data = {}) => ({ type, seq, data });

test("changes: new needs, finished and failed runs, signed documents and new members count; everything else does not", () => {
  const events = [ev("flow.finished", 5, { state: "done" }), ev("flow.finished", 6, { state: "failed" }), ev("flow.finished", 7, { state: "cancelled" }), ev("flow.stuck", 8), ev("documents.signed", 9), ev("member.added", 10), ev("member.added", 11),
    ev("record.updated", 12), ev("thread.text", 13), ev("task.created", 14), ev("flow.finished", 2, { state: "done" })];
  assert.deepEqual(changesSince(events, ["n1"], ["n1", "n2", "n3"], 4), { needs: 2, finished: 1, failed: 2, signed: 1, members: 2 }, "events at or before the cursor are not new; a cancelled run is not news");
  assert.deepEqual(changesSince([], [], [], 0), { needs: 0, finished: 0, failed: 0, signed: 0, members: 0 });
  assert.deepEqual(changesSince(null, ["a"], ["a"]), { needs: 0, finished: 0, failed: 0, signed: 0, members: 0 });
});

test("changes: an event from the modules' bus keeps its words under data.payload, and is read the same", () => {
  const wrapped = (/** @type {string} */ type, /** @type {number} */ seq, payload = {}) => ({ type, seq, data: { legacy: 1, source: "flows", payload } });
  assert.deepEqual(changesSince([wrapped("flow.finished", 3, { state: "done" }), wrapped("flow.finished", 4, { state: "failed" }), wrapped("flow.finished", 5, { state: "cancelled" })], [], [], 0), { needs: 0, finished: 1, failed: 1, signed: 0, members: 0 });
});

test("major: any one of the four raises it, nothing minor does", () => {
  assert.equal(isMajor({ needs: 0, finished: 0, failed: 0, signed: 0, members: 0 }), false);
  for (const k of ["needs", "finished", "failed", "signed", "members"]) assert.equal(isMajor({ needs: 0, finished: 0, failed: 0, signed: 0, members: 0, [k]: 1 }), true, k);
});

test("lines: plain words, one line each, the pressing ones first", () => {
  assert.deepEqual(awayLines({ needs: 3, finished: 1, failed: 2, signed: 1, members: 2 }), ["3 new things need you", "2 Flow runs did not finish", "1 Flow run finished", "1 document was signed", "2 new members joined"]);
  assert.deepEqual(awayLines({ needs: 1, finished: 0, failed: 0, signed: 0, members: 1 }), ["1 new thing needs you", "1 new member joined"]);
  assert.deepEqual(awayLines({ needs: 0, finished: 0, failed: 0, signed: 0, members: 0 }), []);
});

test("away: six hours or more is away; the first visit is not; a visit ends on where the log and the needs stood; a broken store is no store", () => {
  const t = 1_700_000_000_000;
  assert.equal(wasAway(null, t), false, "the first visit starts a baseline, it is not a return");
  assert.equal(wasAway(visited({ now: t - ABSENCE_MS + 1, seq: 5, needs: [] }), t), false);
  assert.equal(wasAway(visited({ now: t - ABSENCE_MS, seq: 5, needs: [] }), t), true);
  const s = visited({ now: t, seq: 42, needs: ["a", "b"] });
  assert.deepEqual(readState(JSON.stringify(s)), s);
  for (const bad of [null, "", "{", "[]", '{"at":"x"}']) assert.equal(readState(bad), null);
  assert.equal(topSeq([ev("a", 3), ev("b", 9), { type: "c" }]), 9);
  assert.equal(topSeq([]), 0);
});
