import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { arrange, build, edgePath, edgeWords, extent, listOrder, metrics, nodeHeight, place } from "./layout.js";

const m = metrics(48);
const nodes = [{ id: "t", lane: 0, y: 0 }, { id: "d", lane: 0, y: 1 }, { id: "n", lane: 1, y: 2 }, { id: "e", lane: 2, y: 3 }];

test("metrics are multiples of one unit, so density redraws the graph", () => {
  assert.deepEqual(metrics(48), { w: 264, h: 84, gx: 24, gy: 24 });
  assert.equal(metrics(40).w, 220);
});

test("a node sits at its lane and its row", () => {
  const p = place(nodes, m);
  assert.deepEqual([p[2].left, p[2].top], [288, 216]);
  assert.deepEqual(extent(nodes, m), { width: 3 * 264 + 2 * 24, height: 4 * 84 + 3 * 24 });
});

test("an edge leaves the bottom middle and arrives at the top middle", () => {
  const p = place(nodes, m);
  assert.match(edgePath(p[0], p[1], m), /^M 132 84 C 132 \d+, 132 \d+, 132 108$/);
});

test("lane words and the phone order", () => {
  assert.equal(edgeWords("then"), "If yes");
  assert.equal(edgeWords("lane"), "At the same time");
  assert.equal(edgeWords("next"), "");
  assert.deepEqual(listOrder([...nodes].reverse()).map((n) => n.id), ["t", "d", "n", "e"]);
  assert.deepEqual(listOrder([{ id: "a", y: 1, order: 5 }, { id: "b", y: 9, order: 2 }]).map((n) => n.id), ["b", "a"], "the phone keeps the kernel's order when the layout moved a step");
});


const PAR = () => ({
  nodes: [{ id: "t", kind: "trigger", lane: 0, y: 0, label: "When it starts" }, { id: "p", kind: "parallel", lane: 0, y: 1, label: "Do 2 things at the same time, then carry on" },
    { id: "a1", kind: "branch", lane: 1, y: 2, label: "review" }, { id: "a2", kind: "create", lane: 1, y: 3, label: "Give a task to a person" }, { id: "b1", kind: "branch", lane: 2, y: 4, label: "draft" }, { id: "b2", kind: "subflow", lane: 2, y: 5, label: "Run the Flow inner_note" },
    { id: "j", kind: "create", lane: 0, y: 6, label: "Create a filing note" }],
  edges: [{ from: "t", to: "p", kind: "next" }, { from: "p", to: "a1", kind: "lane" }, { from: "a1", to: "a2", kind: "next" }, { from: "p", to: "b1", kind: "lane" }, { from: "b1", to: "b2", kind: "next" }, { from: "p", to: "j", kind: "next" }],
});

test("a parallel's lanes sit side by side from the same row, and a join under the longest lane waits for all of them before the step after", () => {
  const { nodes, edges } = PAR();
  const r = arrange(nodes, edges);
  const at = Object.fromEntries(r.nodes.map((n) => [n.id, [n.lane, n.y]]));
  assert.deepEqual([at.a1, at.b1], [[1, 2], [2, 2]], "level");
  assert.deepEqual([at.a2, at.b2], [[1, 3], [2, 3]]);
  assert.deepEqual(at["p:join"], [0, 4], "the join is under the longest lane");
  assert.deepEqual(at.j, [0, 5], "the step after hangs from the join");
  assert.deepEqual(r.joins, ["p:join"]);
  assert.deepEqual(r.edges.filter((e) => e.to === "p:join").map((e) => e.from).sort(), ["a2", "b2"]);
  assert.ok(!r.edges.some((e) => e.from === "p" && e.to === "j"), "the parallel does not connect straight down to the step after");
  assert.deepEqual(r.edges.find((e) => e.from === "p:join"), { from: "p:join", to: "j", kind: "next" });
  assert.equal(r.nodes.find((n) => n.id === "p:join")?.label, "All 2 are done, then carry on");
  assert.deepEqual(listOrder(r.nodes).map((n) => n.id), ["t", "p", "a1", "a2", "b1", "b2", "p:join", "j"], "the phone's list reads in the kernel's order, the join after its lanes");
  assert.deepEqual(nodes.map((n) => n.y), [0, 1, 2, 3, 4, 5, 6], "the input is not changed");
});

test("a lane with a decide inside keeps its own columns, a parallel with one lane is left alone, and a parallel that nothing follows has no join", () => {
  const flow = [{ id: "p", kind: "parallel", lane: 0, y: 1 }, { id: "a1", kind: "decide", lane: 1, y: 2 }, { id: "a2", kind: "create", lane: 2, y: 3 }, { id: "b1", kind: "create", lane: 2, y: 4 }, { id: "j", kind: "create", lane: 0, y: 5 }];
  const edges = [{ from: "p", to: "a1", kind: "lane" }, { from: "a1", to: "a2", kind: "then" }, { from: "p", to: "b1", kind: "lane" }, { from: "p", to: "j", kind: "next" }];
  const at = Object.fromEntries(arrange(flow, edges).nodes.map((n) => [n.id, [n.lane, n.y]]));
  assert.deepEqual([at.a1, at.a2, at.b1], [[1, 2], [2, 3], [3, 2]]);
  const one = arrange([{ id: "p", kind: "parallel", lane: 0, y: 1 }, { id: "a", kind: "create", lane: 1, y: 2 }], [{ from: "p", to: "a", kind: "lane" }]);
  assert.deepEqual(one.joins, []);
  const last = arrange(flow.slice(0, 4), edges.slice(0, 3));
  assert.deepEqual(last.joins, []);
  assert.equal(last.nodes.length, 4);
});

/** The points of a path this module draws (M, L and Q only), so a test can walk it. */
const points = (d) => { const t = d.split(" "); const out = []; for (let i = 0; i < t.length; i++) { if (t[i] === "M" || t[i] === "L") { out.push([+t[i + 1], +t[i + 2]]); i += 2; } else if (t[i] === "Q") { out.push([+t[i + 1], +t[i + 2]], [+t[i + 3], +t[i + 4]]); i += 4; } } return out; };

test("every edge runs in the gaps and the columns, never across a card, and rows are only as tall as their steps", () => {
  const { nodes, edges } = PAR();
  const r = arrange(nodes, edges);
  const g = build(r.nodes, r.edges, m);
  for (const e of g.edges) {
    const pts = points(e.d);
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      for (const n of g.nodes) {
        if (n.id === e.from || n.id === e.to) continue;
        // sample the segment, and ask whether any sample is strictly inside the card
        for (let k = 0; k <= 20; k++) { const x = x1 + ((x2 - x1) * k) / 20, y = y1 + ((y2 - y1) * k) / 20; assert.ok(!(x > n.left + 1 && x < n.left + n.w - 1 && y > n.top + 1 && y < n.top + n.h - 1), `${e.from} to ${e.to} crosses ${n.id}`); }
      }
    }
  }
  const tall = Math.max(...g.nodes.filter((n) => n.kind !== "join").map((n) => n.h));
  assert.ok(tall < m.h * 1.6, "no step is the old tall empty card");
  assert.ok(nodeHeight({ label: "x" }, false, m.w) < nodeHeight({ label: "x", state: "done", who: "Dana" }, true, m.w), "a step with more to say is taller");
  assert.ok(g.nodes.find((n) => n.id === "p:join").h < 60, "the join is a pill, not a card");
  assert.ok(nodeHeight({ label: "x" }, false, m.w) >= 44, "a step is at least as tall as its icon");
});
