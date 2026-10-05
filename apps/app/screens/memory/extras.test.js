// @ts-check
// Memory's graph, pins, corrections and Ask against a fake box: tool names and inputs, and the lines the screen shows.
import "../../../../scripts/mac-test-guard.mjs";
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

test("Learned today: facts seen since the start of the day, newest first; a fact with no time is not today; stats say how much is remembered", { skip: !strip }, async () => {
  const { learnedToday, newestSeen, startOfDay } = await import("./logic.js");
  const { pickStats, statsLine } = await import("./extras-model.ts");
  const noon = new Date("2026-10-05T12:00:00").getTime();
  const day = startOfDay(noon);
  assert.equal(new Date(day).getHours(), 0);
  const facts = [{ id: "a", seen: noon - 3600_000 }, { id: "b", seen: day - 1 }, { id: "c", seen: noon }, { id: "d" }, { id: "e", seen: day }];
  assert.deepEqual(learnedToday(facts, noon).map((f) => f.id), ["c", "a", "e"]);
  assert.deepEqual(learnedToday([], noon), []);
  assert.equal(newestSeen(facts), noon);
  assert.equal(newestSeen([]), 0);
  const s = pickStats({ facts: 12, sessions: 3, nodes: 40, lastRun: { at: 1, age: "2 hours ago" } });
  assert.deepEqual(s, { facts: 12, sessions: 3, nodes: 40, lastAge: "2 hours ago" });
  assert.equal(statsLine(s, null), "12 facts from 3 sessions. Last read 2 hours ago.");
  assert.equal(statsLine(s, 4), "12 facts from 3 sessions, 4 learned today. Last read 2 hours ago.");
  assert.equal(statsLine({ facts: 1, sessions: 1, nodes: 1, lastAge: "" }, 1), "1 fact from 1 session, 1 learned today.");
  assert.equal(pickStats(null), null);
  assert.equal(pickStats({ nodes: 1 }), null);
});

test("memory.stats is asked with no input, and a real fact carries when it was seen", { skip: !strip }, async () => {
  const { memoryExtras } = await import("./extras-source.ts");
  const { toFact } = await import("./real-model.ts");
  const seen = [];
  await memoryExtras(async (tool, input) => { seen.push([tool, input]); return { data: { facts: 1 } }; }).statsReal();
  assert.deepEqual(seen, [["memory.stats", {}]]);
  const f = toFact({ id: "f1", text: "x", subject: { id: "s", label: "S", kind: "person" }, object: { id: "o", label: "O", kind: "org" }, confidence: 1, age: "today", source: null, ref: null, evidence: 1, seen: 1_800_000_000_000 });
  assert.equal(f.seen, 1_800_000_000_000);
  assert.equal(toFact({ id: "f2", text: "x", subject: { id: "s", label: "S", kind: "person" }, object: { id: "o", label: "O", kind: "org" }, confidence: 1, age: null, source: null, ref: null, evidence: 0, since: 5 }).seen, 5);
});
