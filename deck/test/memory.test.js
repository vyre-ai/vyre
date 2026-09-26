// @ts-check
// Memory's plain logic (deck/views/memory-data.js) and the shapes of its fixtures. The views
// themselves are checked by screenshot (deck/test/shoot.js); this is what can run in node.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  turnHref, splitFact, graphCursor, projectsFrom, byRoom, scopeWords, countsLine, groupLessons, verdictOf,
  lowerLevels, presenceText, checkWords,
} from "../views/memory-data.js";

const DECK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = name => JSON.parse(fs.readFileSync(path.join(DECK, "fixtures", name), "utf8"));

test("a fact's source links to the exact turn, in its project when known", () => {
  assert.equal(turnHref({ session: "s1", seq: 4 }), "/threads/s1?seq=4");
  assert.equal(turnHref({ session: "s1", seq: 4 }, s => (s === "s1" ? "harlow-legal" : undefined)), "/projects/harlow-legal/s1?seq=4");
  assert.equal(turnHref({ session: "a b" }), "/threads/a%20b");
  assert.equal(turnHref(null), null);
  assert.equal(turnHref({ session: "" }), null);
});

test("the object becomes the field in its own sentence", () => {
  assert.deepEqual(splitFact("Dana Reyes works at Harlow Legal", "Harlow Legal"), { before: "Dana Reyes works at ", object: "Harlow Legal", after: "" });
  assert.deepEqual(splitFact("harlow/site is Harlow Legal's", "Harlow Legal"), { before: "harlow/site is ", object: "Harlow Legal", after: "'s" });
  // Not in the sentence: the field follows it.
  assert.deepEqual(splitFact("A note", "x"), { before: "A note: ", object: "x", after: "" });
});

/** A fake vyred for the cursor: counts fetches and draws. */
function rig({ hidden = false } = {}) {
  const io = { hidden, fetches: /** @type {any[]} */ ([]), draws: 0, updated: 10, next: /** @type {any} */ (null) };
  const cursor = graphCursor({
    hidden: () => io.hidden,
    fetch: async since => {
      io.fetches.push(since);
      if (io.next) { const n = io.next; io.next = null; return n; }
      return since === io.updated ? { updated: io.updated, unchanged: true } : { updated: io.updated, rooms: [], nodes: [], edges: [] };
    },
    draw: () => { io.draws++; },
  });
  return { io, cursor };
}

test("graph cursor: one fetch, then since; unchanged never repaints", async () => {
  const { io, cursor } = rig();
  await cursor.request(true);
  assert.deepEqual(io.fetches, [undefined]);
  assert.equal(io.draws, 1);
  await cursor.request();
  assert.deepEqual(io.fetches, [undefined, 10]);
  assert.equal(io.draws, 1, "{unchanged: true} does not repaint");
  // A graph that answers with the same cursor (a fixture, say) does not repaint either.
  io.next = { updated: 10, rooms: [], nodes: [], edges: [] };
  await cursor.request();
  assert.equal(io.draws, 1);
});

test("graph cursor: memory.curated with the drawn `updated` does nothing", async () => {
  const { io, cursor } = rig();
  await cursor.request(true);
  await cursor.curated({ updated: 10 });
  assert.equal(io.fetches.length, 1);
  io.updated = 11;
  await cursor.curated({ updated: 11 });
  assert.deepEqual(io.fetches, [undefined, 10]);
  assert.equal(io.draws, 2);
});

test("graph cursor: a hidden tab only marks dirty, and fetches once on visibilitychange", async () => {
  const { io, cursor } = rig();
  await cursor.request(true);
  io.hidden = true;
  io.updated = 12;
  await cursor.curated({ updated: 11 });
  await cursor.curated({ updated: 12 });
  assert.equal(io.fetches.length, 1, "nothing fetched while hidden");
  assert.equal(cursor.state.dirty, true);
  await cursor.visible();
  assert.equal(io.fetches.length, 1, "still hidden");
  io.hidden = false;
  await cursor.visible();
  assert.deepEqual(io.fetches, [undefined, 10]);
  assert.equal(io.draws, 2);
  await cursor.visible();
  assert.equal(io.fetches.length, 2, "clean after the one fetch");
});

test("graph cursor: events during a fetch coalesce into one more", async () => {
  let release = () => {};
  let calls = 0;
  const cursor = graphCursor({
    hidden: () => false,
    fetch: () => { calls++; return new Promise(r => { release = () => r({ updated: calls, rooms: [], nodes: [], edges: [] }); }); },
    draw: () => {},
  });
  const first = cursor.request(true);
  cursor.curated({ updated: 99 });
  cursor.curated({ updated: 100 });
  release();
  await new Promise(r => setImmediate(r));
  release();
  await first;
  assert.equal(calls, 2);
});

test("graph cursor: a scope change mid-fetch throws the old answer away and fetches fresh", async () => {
  const seen = [];
  let scope = "everything";
  const gates = [];
  const cursor = graphCursor({
    hidden: () => false,
    fetch: since => { const asked = scope; seen.push([asked, since]); return new Promise(r => gates.push(() => r({ updated: 5, scope: asked, rooms: [], nodes: [], edges: [] }))); },
    draw: g => seen.push(["drew", g.scope]),
  });
  const first = cursor.request(true);
  scope = "harlow";
  cursor.request(true);
  gates.shift()();
  await new Promise(r => setImmediate(r));
  gates.shift()();
  await first;
  assert.deepEqual(seen, [["everything", undefined], ["harlow", undefined], ["drew", "harlow"]]);
});

test("projects come from projects.list, else from the main graph's rooms", () => {
  assert.deepEqual(projectsFrom([{ slug: "a", name: "A", home: "/w/a", workspaces: [] }], null), [{ slug: "a", name: "A", folders: ["/w/a"] }]);
  const rooms = fixture("memory.json")["memory.graph"].cases["*"].rooms;
  assert.deepEqual(projectsFrom(null, rooms).map(p => p.slug), ["harlow-legal", "northwind-bakery"]);
});

test("nodes are grouped by room; an unknown room falls to the first", () => {
  const g = { rooms: [{ id: "r1" }, { id: "r2" }], nodes: [{ id: "a", room: "r2" }, { id: "b", room: "nowhere" }] };
  const m = byRoom(g);
  assert.deepEqual(m.get("r1").map(n => n.id), ["b"]);
  assert.deepEqual(m.get("r2").map(n => n.id), ["a"]);
});

test("lessons: scope in words, counts, groups, levels to relax to", () => {
  const names = new Map([["harlow-legal", "Harlow Legal"]]);
  assert.equal(scopeWords("all"), "Everywhere");
  assert.equal(scopeWords({ project: "harlow-legal" }, names), "Only in Harlow Legal");
  assert.equal(scopeWords({ project: "other" }, names), "Only in other");
  assert.equal(scopeWords({ agent: "kit" }), "Only for kit");
  assert.equal(countsLine({ applied: 14, caught: 3, broken: 1 }), "applied 14 · caught 3 · broken 1");
  assert.equal(countsLine({}), "applied 0 · caught 0 · broken 0");
  const g = groupLessons([{ status: "proposed" }, { status: "active" }, { status: "dormant" }, { status: "retired" }]);
  assert.deepEqual([g.proposed.length, g.active.length, g.retired.length], [1, 2, 1]);
  assert.deepEqual(lowerLevels("block"), ["remind", "ask"]);
  assert.deepEqual(lowerLevels("remind"), []);
  assert.equal(checkWords(null), null);
  assert.equal(checkWords({ kind: "text" }), "text check");
});

test("the effect verdict reads any of learn.stats's shapes", () => {
  assert.deepEqual(verdictOf([{ id: 3, verdict: "working", before: 4.2, after: 0.8 }], 3), { verdict: "working", text: "Working, 4.2 to 0.8 per 100 turns" });
  assert.deepEqual(verdictOf({ lessons: [{ lesson: 5, verdict: "measuring", turns: 31 }] }, 5), { verdict: "measuring", text: "Measuring, 31 turns so far" });
  assert.deepEqual(verdictOf({ 7: { effect: "not_working" } }, 7), { verdict: "not working", text: "Not working" });
  assert.equal(verdictOf(null, 1), null);
  assert.equal(verdictOf([], 1), null);
});

test("presence: the passkey when there is one, else the terminal and the Capsule", () => {
  assert.equal(presenceText("learn.accept", 7, true), "Confirm with your passkey");
  assert.equal(presenceText("learn.accept", 7, false), "Accept this in a terminal: vyre learn accept 7, or from the Capsule");
  assert.match(presenceText("learn.relax", 3, false), /vyre learn relax 3/);
  assert.match(presenceText("learn.skill_install", 1, false), /vyre learn skills install 1/);
});

test("fixtures: learn.json has core/learn's lesson shape", () => {
  const f = fixture("learn.json");
  const all = f["learn.lessons"].cases["*"];
  assert.ok(all.length >= 4);
  for (const l of all) {
    assert.ok(Number.isInteger(l.id), "ids are integers");
    assert.ok(l.scope === "all" || (typeof l.scope === "object" && (typeof l.scope.project === "string" || typeof l.scope.agent === "string")));
    assert.ok(["remind", "ask", "block"].includes(l.level));
    assert.ok(["proposed", "active", "retired"].includes(l.status));
    assert.ok(l.check === null || typeof l.check.kind === "string");
    assert.equal(typeof l.source.kind, "string");
    for (const k of ["applied", "caught", "broken"]) assert.equal(typeof l[k], "number");
    assert.equal(typeof l.rule, "string");
    assert.equal(typeof l.when, "string");
  }
  assert.deepEqual(f["learn.lessons"].cases.proposed.map(l => l.id), all.filter(l => l.status === "proposed").map(l => l.id));
});

test("fixtures: memory.graph matches core/memory/floor.js", () => {
  const g = fixture("memory.json")["memory.graph"];
  for (const graph of Object.values(g.cases)) {
    const rooms = new Set(graph.rooms.map(r => r.id));
    for (const r of graph.rooms) assert.ok(["project", "shared", "unfiled"].includes(r.kind));
    const ids = new Set(graph.nodes.map(n => n.id));
    for (const n of graph.nodes) assert.ok(rooms.has(n.room), `${n.id} is in a room that exists`);
    for (const e of graph.edges) {
      assert.equal(e.id, `${e.src}|${e.rel}|${e.dst}`);
      assert.ok(ids.has(e.src) && ids.has(e.dst), `${e.id} joins drawn nodes`);
    }
    assert.equal(typeof graph.updated, "number");
    for (const k of ["nodes", "facts", "drawn"]) assert.equal(typeof graph.counts[k], "number");
  }
  // Every fact the list shows is an edge the map can draw, so opening one from either finds it.
  const facts = fixture("memory.json")["memory.facts"].cases["*"].facts;
  const edges = new Set(g.cases["*"].edges.map(e => e.id));
  for (const f of facts) assert.ok(edges.has(f.id), f.id);
});
