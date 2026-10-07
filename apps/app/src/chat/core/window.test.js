// @ts-check
// Windowed rendering, the pure part: heights, offsets, the mounted range, the anchor.

import "../../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  THRESHOLD, MAX_MOUNTED, createHeights, offsets, indexAt, windowRange, tailScroll, scrollFor, spacers,
  captureAnchor, restoreAnchor, isAtBottom, sameRange, rangeAround,
} from "./window.js";

const keysOf = n => Array.from({ length: n }, (_, i) => "r" + i);

test("heights: estimated by kind until measured, and set() says how much a slot changed", () => {
  const h = createHeights({ estimate: 50, estimates: { day: 20 } });
  assert.equal(h.get("a"), 50);
  assert.equal(h.get("a", "day"), 20);
  assert.equal(h.measured("a"), false);
  assert.equal(h.set("a", 80), 0, "a first measurement is not a change");
  assert.equal(h.set("a", 100), 20);
  assert.equal(h.get("a", "day"), 100, "a measurement wins over the estimate");
  assert.equal(h.set("a", NaN), 0, "nonsense is ignored");
  h.set("b", 10);
  h.prune(["a"]);
  assert.equal(h.size, 1);
  assert.equal(h.measured("b"), false);
});

test("offsets are prefix sums; indexAt finds the row holding a point", () => {
  const h = createHeights({ estimate: 10 });
  h.set("r1", 30);
  const offs = offsets(keysOf(4), h);
  assert.deepEqual([...offs], [0, 10, 40, 50, 60]);
  assert.equal(indexAt(offs, -5), 0);
  assert.equal(indexAt(offs, 0), 0);
  assert.equal(indexAt(offs, 10), 1);
  assert.equal(indexAt(offs, 39.9), 1);
  assert.equal(indexAt(offs, 40), 2);
  assert.equal(indexAt(offs, 1e9), 3);
  assert.equal(indexAt(new Float64Array(1), 5), 0);
});

test("at or below the threshold everything is mounted", () => {
  const offs = offsets(keysOf(THRESHOLD), createHeights());
  assert.deepEqual(windowRange({ offs, scrollTop: 0, viewport: 800 }), { start: 0, end: THRESHOLD, windowed: false });
});

test("above it, the viewport plus the margin, never more than the cap", () => {
  const offs = offsets(keysOf(2000), createHeights({ estimate: 50 }));
  const r = windowRange({ offs, scrollTop: 50_000, viewport: 800, margin: 400 });
  assert.equal(r.windowed, true);
  assert.equal(r.start, 992, "400 px above row 1000");
  assert.equal(r.end, 1025, "the viewport's 16 rows, 400 px below, and the row touching that edge");
  const tiny = offsets(keysOf(20_000), createHeights({ estimate: 2 }));
  const t = windowRange({ offs: tiny, scrollTop: 20_000, viewport: 800 });
  assert.equal(t.end - t.start, MAX_MOUNTED);
  assert.ok(t.start <= 10_000 && t.end >= 10_000 + 1, "the rows on screen stay in");
  const huge = windowRange({ offs: tiny, scrollTop: 0, viewport: 1e6 });
  assert.equal(huge.end - huge.start, MAX_MOUNTED, "a viewport taller than the cap: the cap");
});

test("the cap gives rows the top does not need to the bottom", () => {
  const offs = offsets(keysOf(5000), createHeights({ estimate: 4 }));
  const r = windowRange({ offs, scrollTop: 0, viewport: 100 });
  assert.equal(r.start, 0);
  assert.equal(r.end, MAX_MOUNTED);
  const end = windowRange({ offs, scrollTop: tailScroll(offs, 100), viewport: 100 });
  assert.equal(end.end, 5000);
  assert.equal(end.end - end.start, MAX_MOUNTED);
});

test("the tail: the last rows, whatever the scroll position says", () => {
  const offs = offsets(keysOf(500), createHeights({ estimate: 40 }));
  assert.equal(tailScroll(offs, 800), 500 * 40 - 800);
  const r = windowRange({ offs, scrollTop: tailScroll(offs, 800), viewport: 800 });
  assert.equal(r.end, 500);
  assert.equal(tailScroll(offsets(keysOf(3), createHeights({ estimate: 40 })), 800), 0, "shorter than the viewport");
});

test("spacers stand for the rows around the range", () => {
  const offs = offsets(keysOf(300), createHeights({ estimate: 10 }));
  assert.deepEqual(spacers(offs, 100, 150), { top: 1000, bottom: 1500 });
  assert.deepEqual(spacers(offs, 0, 300), { top: 0, bottom: 0 });
});

test("scrollFor and rangeAround: a deep link's row is mounted and centred", () => {
  const offs = offsets(keysOf(2000), createHeights({ estimate: 50 }));
  assert.equal(scrollFor(offs, 100, 800), 100 * 50 + 25 - 400);
  assert.equal(scrollFor(offs, 100, 800, "start"), 5000);
  assert.equal(scrollFor(offs, 0, 800), 0, "clamped at the top");
  assert.equal(scrollFor(offs, 1999, 800), tailScroll(offs, 800), "clamped at the bottom");
  const r = rangeAround(offs, 1200, 800);
  assert.ok(r.start <= 1200 && r.end > 1200);
  assert.equal(r.windowed, true);
});

test("the anchor: rows loaded above move the reading position down by exactly their height", () => {
  const h = createHeights({ estimate: 40 });
  let keys = keysOf(300).map(k => "new-" + k);
  let offs = offsets(keys, h);
  const scrollTop = 4321;
  const a = captureAnchor(keys, offs, scrollTop);
  assert.deepEqual(a, { key: "new-r108", into: 4321 - 108 * 40 });
  // A page of history above: 400 rows, some measured taller.
  const older = keysOf(400).map(k => "old-" + k);
  for (let i = 0; i < 400; i += 7) h.set(older[i], 90);
  keys = [...older, ...keys];
  offs = offsets(keys, h);
  const index = new Map(keys.map((k, i) => [k, i]));
  const added = offs[400];
  assert.equal(restoreAnchor(a, index, offs), scrollTop + added);
});

test("the anchor: a row above the viewport measured taller than its estimate keeps what is read in place", () => {
  const h = createHeights({ estimate: 40 });
  const keys = keysOf(500);
  const index = new Map(keys.map((k, i) => [k, i]));
  let offs = offsets(keys, h);
  const a = captureAnchor(keys, offs, 10_000);
  h.set("r10", 140); h.set("r11", 10);
  offs = offsets(keys, h);
  assert.equal(restoreAnchor(a, index, offs), 10_000 + 100 - 30);
  // Below the viewport: nothing moves.
  const b = captureAnchor(keys, offs, 5000);
  h.set("r400", 400);
  offs = offsets(keys, h);
  assert.equal(restoreAnchor(b, index, offs), 5000);
});

test("the anchor: gone, or none, is null", () => {
  assert.equal(restoreAnchor(null, new Map(), new Float64Array(1)), null);
  assert.equal(restoreAnchor({ key: "x", into: 3 }, new Map(), new Float64Array(1)), null);
  assert.equal(captureAnchor([], new Float64Array(1), 0), null);
});

test("sticky at the bottom: within the slack counts", () => {
  assert.equal(isAtBottom(1000, 800, 1800), true);
  assert.equal(isAtBottom(965, 800, 1800), true);
  assert.equal(isAtBottom(900, 800, 1800), false);
  assert.equal(sameRange({ start: 1, end: 2 }, { start: 1, end: 2 }), true);
  assert.equal(sameRange(null, { start: 1, end: 2 }), false);
});
