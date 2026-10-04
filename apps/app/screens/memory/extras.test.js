// @ts-check
// Memory's graph, pins, corrections and Ask against a fake box: tool names and inputs, and the lines the screen shows.
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

const GRAPH = { rooms: [{ id: "harlow", name: "Harlow Legal", kind: "project", nodes: 2, facts: 3 }, { id: "unfiled", nodes: 0, facts: 0 }, { id: "shared", nodes: 1, facts: 1 }], truncated: true, counts: { nodes: 40, facts: 4, drawn: 4 }, edges: [],
  nodes: [
    { id: "per:kit", kind: "person", label: "Kit", weight: 3, pinned: false, muted: false, role: null, room: "harlow", last: 1 },
    { id: "per:jane", kind: "person", label: "Jane Doe", weight: 1, pinned: true, muted: false, role: null, room: "harlow", last: 1 },
    { id: "fact:1", kind: "fact", label: "a note", weight: 1, pinned: false, muted: false, role: null, room: "harlow", last: 1 },
    { id: "org:northwind", kind: "org", label: "Northwind Bakery", weight: 2, pinned: false, muted: true, role: null, room: "shared", last: 1 },
  ] };

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (tool === "memory.graph") return { data: GRAPH };
    if (tool === "memory.corrections") return { data: [
      { id: 2, action: "replace", src: "per:jane", rel: "prefers", dst: "note:1", object: "phone calls", scope: "*", note: null, created: 200, undone: null },
      { id: 1, action: "wrong", src: "per:kit", rel: "works_at", dst: "org:northwind", object: null, scope: "*", note: null, created: 100, undone: null },
      { id: 0, action: "ended", src: "per:kit", rel: "lives_in", dst: "place:porto", object: null, scope: "*", note: null, created: 50, undone: 60 },
    ] };
    if (tool === "memory.ask") return o.ask ?? { data: { answer: "Kit works on the Harlow intake.", confidence: 0.9, abstained: false, known: [], sources: [{ session: "s1", name: "Intake call", quote: "Kit takes the intake", ts: 1 }] } };
    return { data: {} };
  };
  return { call, seen };
}

test("the map: rooms with their entities, pinned first, a muted one last, rooms with nothing drawn left out", { skip: !strip }, async () => {
  const { memoryExtras } = await import("./extras-source.ts");
  const { roomsOf } = await import("./extras-model.ts");
  const b = box();
  const g = await memoryExtras(b.call).graphReal();
  assert.deepEqual(b.seen, [{ tool: "memory.graph", input: { limit: 150 } }]);
  const rooms = roomsOf(g);
  assert.deepEqual(rooms.map((r) => [r.name, r.counts, r.nodes.map((n) => n.label)]), [["Harlow Legal", "2 things, 3 facts", ["Jane Doe", "Kit"]], ["Shared", "1 thing, 1 fact", ["Northwind Bakery"]]]);
});

test("pin and mute are one call each on a node, everywhere; off reverses it", { skip: !strip }, async () => {
  const { memoryExtras } = await import("./extras-source.ts");
  const b = box();
  const m = memoryExtras(b.call);
  await m.steerReal("pin", "per:kit", false);
  await m.steerReal("mute", "org:northwind", true);
  assert.deepEqual(b.seen, [{ tool: "memory.pin", input: { node: "per:kit", scope: "*", off: false } }, { tool: "memory.mute", input: { node: "org:northwind", scope: "*", off: true } }]);
});

test("corrections: standing ones newest first, as lines, and Undo is memory.uncorrect by id", { skip: !strip }, async () => {
  const { memoryExtras } = await import("./extras-source.ts");
  const { standing, correctionLine } = await import("./extras-model.ts");
  const b = box();
  const m = memoryExtras(b.call);
  const rows = standing(await m.correctionsReal());
  assert.deepEqual(rows.map(correctionLine), ["jane prefers: now phone calls", "kit works at northwind was never true"]);
  await m.uncorrectReal(2);
  assert.deepEqual(b.seen.at(-1), { tool: "memory.uncorrect", input: { id: 2 } });
});

test("Ask shows the answer with its sources, and an honest nothing when Memory abstains", { skip: !strip }, async () => {
  const { memoryExtras } = await import("./extras-source.ts");
  const { asked } = await import("./extras-model.ts");
  const b = box();
  const a = asked(await memoryExtras(b.call).askReal("Who is Kit?"));
  assert.deepEqual(b.seen, [{ tool: "memory.ask", input: { question: "Who is Kit?" } }]);
  assert.deepEqual(a, { kind: "answer", text: "Kit works on the Harlow intake.", sources: [{ name: "Intake call", quote: "Kit takes the intake" }] });
  const none = asked(await memoryExtras(box({ ask: { data: { answer: null, confidence: 0, abstained: true, known: [], sources: [] } } }).call).askReal("x"));
  assert.deepEqual(none, { kind: "none", text: "Nothing remembered about that yet." });
});

test("a box error keeps its code", { skip: !strip }, async () => {
  const { memoryExtras } = await import("./extras-source.ts");
  const m = memoryExtras(async () => ({ error: { code: "not_available", message: "memory is off" } }));
  await assert.rejects(m.graphReal(), (/** @type {any} */ e) => e.code === "not_available" && /memory is off/.test(e.message));
});
