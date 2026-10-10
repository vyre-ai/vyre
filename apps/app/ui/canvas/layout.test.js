import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { arrange, edgePath, edgeWords, extent, listOrder, metrics, place } from "./layout.js";

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
  assert.equal(edgeWords("lane"), "At the same time");
  assert.equal(edgeWords("join"), "When all are done");
  assert.equal(edgeWords("next"), "");
  assert.deepEqual(listOrder([...nodes].reverse()).map((n) => n.id), ["t", "d", "n", "e"]);
});

test("a parallel's lanes sit side by side from the same row, and the step after it is the join below the longest lane", () => {
  // the kernel's layout: every step on its own row, so the lanes are stacked
  const flow = [{ id: "t", kind: "trigger", lane: 0, y: 0 }, { id: "p", kind: "parallel", lane: 0, y: 1 },
    { id: "a1", kind: "branch", lane: 1, y: 2 }, { id: "a2", kind: "create", lane: 1, y: 3 }, { id: "b1", kind: "branch", lane: 2, y: 4 }, { id: "j", kind: "create", lane: 0, y: 5 }, { id: "z", kind: "create", lane: 0, y: 6 }];
  const edges = [{ from: "t", to: "p", kind: "next" }, { from: "p", to: "a1", kind: "lane" }, { from: "a1", to: "a2", kind: "next" }, { from: "p", to: "b1", kind: "lane" }, { from: "p", to: "j", kind: "next" }, { from: "j", to: "z", kind: "next" }];
  const r = arrange(flow, edges);
  const at = Object.fromEntries(r.nodes.map((n) => [n.id, [n.lane, n.y]]));
  assert.deepEqual(at, { t: [0, 0], p: [0, 1], a1: [1, 2], a2: [1, 3], b1: [2, 2], j: [0, 4], z: [0, 5] });
  assert.deepEqual(r.joins, ["j"]);
  assert.deepEqual(r.edges.filter((e) => e.kind === "join").map((e) => [e.from, e.to]), [["a2", "j"], ["b1", "j"]]);
  assert.deepEqual(r.nodes.map((n) => n.order), [0, 1, 2, 3, 4, 5, 6], "the phone keeps the kernel's order");
  assert.deepEqual(flow.map((n) => n.y), [0, 1, 2, 3, 4, 5, 6], "the input is not changed");
});

test("a lane with a decide inside keeps its own columns, so the next lane does not run into it", () => {
  const flow = [{ id: "p", kind: "parallel", lane: 0, y: 1 }, { id: "a1", kind: "decide", lane: 1, y: 2 }, { id: "a2", kind: "create", lane: 2, y: 3 }, { id: "b1", kind: "create", lane: 2, y: 4 }, { id: "j", kind: "create", lane: 0, y: 5 }];
  const edges = [{ from: "p", to: "a1", kind: "lane" }, { from: "a1", to: "a2", kind: "then" }, { from: "p", to: "b1", kind: "lane" }, { from: "p", to: "j", kind: "next" }];
  const r = arrange(flow, edges);
  const at = Object.fromEntries(r.nodes.map((n) => [n.id, [n.lane, n.y]]));
  assert.deepEqual([at.a1, at.a2, at.b1], [[1, 2], [2, 3], [3, 2]]);
  assert.deepEqual(at.j, [0, 4]);
});

test("a parallel with one lane, or none, is left alone", () => {
  const flow = [{ id: "p", kind: "parallel", lane: 0, y: 1 }, { id: "a", kind: "create", lane: 1, y: 2 }, { id: "j", kind: "create", lane: 0, y: 3 }];
  const r = arrange(flow, [{ from: "p", to: "a", kind: "lane" }, { from: "p", to: "j", kind: "next" }]);
  assert.deepEqual(r.nodes.map((n) => [n.lane, n.y]), [[0, 1], [1, 2], [0, 3]]);
  assert.deepEqual(r.joins, []);
});
