import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { edgePath, edgeWords, extent, listOrder, metrics, place } from "./layout.js";

const m = metrics(48);
const nodes = [{ id: "t", lane: 0, y: 0 }, { id: "d", lane: 0, y: 1 }, { id: "n", lane: 1, y: 2 }, { id: "e", lane: 2, y: 3 }];

test("metrics are multiples of one unit, so density redraws the graph", () => {
  assert.deepEqual(metrics(48), { w: 288, h: 108, gx: 24, gy: 24 });
  assert.equal(metrics(40).w, 240);
});

test("a node sits at its lane and its row", () => {
  const p = place(nodes, m);
  assert.deepEqual([p[2].left, p[2].top], [312, 264]);
  assert.deepEqual(extent(nodes, m), { width: 3 * 288 + 2 * 24, height: 4 * 108 + 3 * 24 });
});

test("an edge leaves the bottom middle and arrives at the top middle", () => {
  const p = place(nodes, m);
  assert.match(edgePath(p[0], p[1], m), /^M 144 108 C 144 \d+, 144 \d+, 144 132$/);
});

test("lane words and the phone order", () => {
  assert.equal(edgeWords("then"), "If yes");
  assert.equal(edgeWords("next"), "");
  assert.deepEqual(listOrder([...nodes].reverse()).map((n) => n.id), ["t", "d", "n", "e"]);
});
