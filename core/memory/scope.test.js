// @ts-check
// Scope: what a correction, a folder or a caller reaches (docs/adr/0007-intelligence.md,
// decisions 1 and 4). A correction for everywhere applies in a room only to what that room's own
// sessions know; a folder belongs to the most specific project that holds it; only the user's
// surfaces and agents granted everything read the main graph. Fictional data only.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../store/index.js";
import { SESSIONS, HOME, seedRecall } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";
import { fakeReachCall } from "../../test/fixtures/fake-reach.js";
import { Curator } from "./curator.js";
import { Graph } from "./graph.js";
import memory from "./index.js";

const W = `${HOME}/Work`;
const T0 = Date.parse("2026-09-01T09:00:00Z");
const DAY = 86_400_000;
const DANA = "name:Dana Reyes", HARLOW = "name:Harlow Legal";
const WORKS = `${DANA}|works_at|${HARLOW}`;
const ROOMS = [
  { slug: "harlow", name: "Harlow Legal", folders: [`${W}/harlow-site`, `${W}/harlow-intake`], threads: [] },
  { slug: "northwind", name: "Northwind", folders: [`${W}/northwind`], threads: [] },
];
let n = 0;
const S = (dir, turns, start) => ({
  id: `77777777-eeee-4000-8000-${String(++n).padStart(12, "0")}`, cwd: `${W}/${dir}`, start,
  turns: turns.map(text => ({ role: /** @type {"user"} */ ("user"), text })),
});

async function world(t, { sessions = SESSIONS, rooms = ROOMS } = {}) {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, sessions);
  const now = () => T0 + 20 * DAY;
  const curator = new Curator(db, { me: { domains: ["riverastudio.com"] }, now });
  curator.setRooms(rooms);
  await curator.curate();
  const graph = new Graph(db, curator, { now });
  /** What memory.correct does, without the module. */
  const correct = async (input, scope = "*") => {
    const x = graph.target(input, scope === "*" ? null : graph.view([], scope));
    const c = curator.correct({ action: input.action, src: x.src, rel: x.rel, dst: x.dst, object: x.object, at: input.at ?? null, scope, note: input.note ?? null });
    await curator.curate({ force: true });
    return c;
  };
  return { db, curator, graph, correct };
}
const facts = (db, room, src) => db.prepare("SELECT rel, dst, origin, valid_to FROM memory_edges WHERE room = ? AND src = ? AND rel != 'mentioned_in' ORDER BY rel, dst").all(room, src);

test("scope: a correction for everywhere reaches a room only through what the room knows, and its note stays where it was made", async t => {
  const { db, graph, correct } = await world(t);
  assert.deepEqual(facts(db, "northwind", DANA), [], "the fixture: Northwind's own sessions never name Dana");
  await correct({ fact: WORKS, action: "confirm" });
  await correct({ subject: "Dana Reyes", rel: "has_title", object: "office manager", action: "add", note: "she said so on the phone" });
  // Rooms that do not know her get nothing: no fact, no node, no prompt.
  for (const room of ["northwind", "unfiled"]) {
    assert.deepEqual(facts(db, room, DANA), [], `a correction for everywhere reached ${room}`);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM memory_room_nodes WHERE room = ? AND id IN (?, ?)").get(room, DANA, "title:office manager")?.n, 0, room);
    assert.deepEqual(graph.relevant({ text: "email Dana Reyes about the office manager", room }), [], room);
  }
  // The room whose sessions know her has both.
  const harlow = facts(db, "harlow", DANA);
  assert.deepEqual(harlow.filter(f => f.rel === "works_at").map(f => [f.dst, f.origin]), [[HARLOW, "confirmed"]]);
  assert.deepEqual(harlow.filter(f => f.rel === "has_title").map(f => [f.dst, f.origin]), [["title:office manager", "user"]]);
  // The note is read only where the correction was made: everywhere, not in a project.
  const title = (room) => graph.facts({ about: "Dana Reyes", room }).facts.find(f => f.rel === "has_title");
  assert.equal(title(undefined)?.correction?.note, "she said so on the phone");
  assert.equal(title("harlow")?.correction?.action, "add");
  assert.equal(title("harlow")?.correction?.note, null, "a note for everywhere showed in a project");
  const why = room => graph.why({ fact: `${DANA}|has_title|title:office manager`, room }).corrections;
  assert.equal(why(undefined)[0]?.note, "she said so on the phone");
  assert.equal(why("harlow")[0]?.note, null, "memory.why showed a note for everywhere in a project");
  // A project's own correction shows its note there.
  await correct({ subject: "Harlow Legal", rel: "deadline", object: "30 october", action: "add", note: "the new launch" }, "harlow");
  const due = graph.facts({ about: "Harlow Legal", room: "harlow" }).facts.find(f => f.rel === "deadline" && f.object.id === "date:2026-10-30");
  assert.equal(due?.correction?.note, "the new launch");
  // Wrong for everywhere still removes what a room derived itself.
  await correct({ fact: `${DANA}|has_email|email:dana@harlowlegal.com`, action: "wrong" });
  assert.deepEqual(facts(db, "harlow", DANA).filter(f => f.rel === "has_email"), []);
});

test("scope: a correction for everywhere never brings a new organisation into a room that knows the person", async t => {
  // Northwind's own sessions name Dana once, so the room keeps her, but never Harlow Legal.
  const cross = [1, 2, 3].map(i => S("northwind", [`The bakery asked Dana Reyes about lunch order ${i}.`], T0 + (2 + i) * DAY));
  const { db, correct } = await world(t, { sessions: [...SESSIONS, ...cross] });
  assert.ok(db.prepare("SELECT 1 FROM memory_room_nodes WHERE room = 'northwind' AND id = ?").get(DANA), "the fixture: Northwind keeps Dana");
  await correct({ subject: "Dana Reyes", rel: "works_at", object: "Harlow Legal", action: "add" });
  assert.deepEqual(facts(db, "northwind", DANA).filter(f => f.rel === "works_at"), [], "Harlow Legal was carried into Northwind");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM memory_room_nodes WHERE room = 'northwind' AND id = ?").get(HARLOW)?.n, 0);
  // A title, a value the correction names itself, does reach a room that keeps her.
  await correct({ subject: "Dana Reyes", rel: "has_title", object: "office manager", action: "add" });
  assert.deepEqual(facts(db, "northwind", DANA).filter(f => f.rel === "has_title").map(f => f.dst), ["title:office manager"]);
});

test("scope: nested project folders open the most specific project", async t => {
  const rooms = [{ slug: "acme", name: "Acme", folders: [W], threads: [] }, { slug: "b-northwind", name: "Northwind", folders: [`${W}/northwind`], threads: [] }];
  const { graph } = await world(t, { rooms });
  assert.equal(graph.view([`${W}/northwind`])?.room, "b-northwind");
  assert.equal(graph.view([`${W}/northwind/app`])?.room, "b-northwind");
  assert.equal(graph.view([`${W}/harlow-site`])?.room, "acme");
  assert.equal(graph.view([W])?.room, "acme");
  // Both folders: only acme holds both.
  assert.equal(graph.view([W, `${W}/northwind`])?.room, "acme");
  const texts = graph.facts({ project_cwds: [`${W}/northwind`] }).facts.map(f => f.text);
  assert.ok(texts.some(x => x.includes("Sam Okafor")) && !texts.some(x => x.includes("Harlow")), texts.join("\n"));
  // A room Memory has not read yet, with its folders: the folders still say where it is.
  assert.equal(graph.view([`${W}/northwind`], "brand-new")?.room, "b-northwind");
  assert.throws(() => graph.view([], "brand-new"), /no project brand-new/);
});

test("scope: a new object is named exactly, never guessed, and gets the kind its relation holds", async t => {
  const { graph } = await world(t);
  const replace = object => graph.target({ fact: WORKS, action: "replace", object }, null).object;
  assert.equal(replace("North"), "name:North", "a partial name matched an existing node");
  assert.equal(replace("northwind bakery"), "name:Northwind Bakery", "an exact label, in any case, is that node");
  assert.equal(replace("name:Northwind Bakery"), "name:Northwind Bakery");
  const add = (subject, rel, object) => graph.target({ subject, rel, object, action: "add" }, null).dst;
  assert.equal(add("Dana Reyes", "has_title", "Office Manager"), "title:office manager");
  assert.equal(add("Harlow Legal", "deadline", "2 october"), "date:2026-10-02");
  assert.throws(() => add("Harlow Legal", "deadline", "soonish"), /not a date/);
  assert.equal(add("Sam Okafor", "prefers", "PDF invoices"), "pref:pdf invoices");
  assert.equal(add("Harlow Legal", "has_domain", "harlowlegal.com"), "domain:harlowlegal.com");
  assert.equal(add("Dana Reyes", "has_email", "Dana@HarlowLegal.com"), "email:dana@harlowlegal.com");
  assert.equal(graph.target({ subject: "Har", rel: "works_at", object: "Harlow Legal", action: "add" }, null).src, "name:Har", "a partial subject matched");
});

test("scope: what the user confirmed is never closed by the rooms' disagreement", async t => {
  const rooms = [...ROOMS.slice(0, 1), { slug: "bramble", name: "Bramble Dental", folders: [`${W}/bramble`], threads: [] }];
  // Months later, another Dana at another firm: far enough apart to be an update, not a question.
  const bramble = [1, 2].map(i => S("bramble", [`Dana Reyes at Bramble Dental sent the x-ray forms, batch ${i}.`], T0 + (150 + i) * DAY));
  const { db, correct } = await world(t, { sessions: [...SESSIONS, ...bramble], rooms });
  await correct({ fact: WORKS, action: "confirm" });
  const open = db.prepare("SELECT dst, origin FROM memory_edges WHERE room = '*' AND src = ? AND rel = 'works_at' AND valid_to IS NULL").all(DANA);
  assert.deepEqual(open.map(r => [r.dst, r.origin]), [[HARLOW, "confirmed"]], "a newer room's vote closed a confirmed fact");
  // Confirmed in its own room, the older belief is not closed in the main graph either.
  const two = await world(t, { sessions: [...SESSIONS, ...bramble], rooms });
  await two.correct({ fact: WORKS, action: "confirm" }, "harlow");
  const closed = two.db.prepare("SELECT dst FROM memory_edges WHERE src = ? AND rel = 'works_at' AND origin = 'confirmed' AND valid_to IS NOT NULL").all(DANA);
  assert.deepEqual(closed, [], "derive closed a confirmed fact");
});

test("scope: many lessons about one thing derive in linear time", async t => {
  const timed = async count => {
    const db = open(path.join(tempHome(t), "vyre.db"));
    t.after(() => db.close());
    seedRecall(db, SESSIONS);
    const c = new Curator(db, { me: { domains: ["riverastudio.com"] } });
    for (let i = 0; i < count; i++) {
      c.teach("watch", "item", { key: "k" + i, subject: { name: "Harlow Legal", kind: "org" }, rel: "has_domain", object: { domain: "harlowlegal.com" }, text: "item " + i, at: 1000 + i });
      c.teach("watch", "note", { key: "n" + i, subject: "Harlow Legal", text: "note " + i, at: 1000 + i });
    }
    const a = process.hrtime.bigint();
    await c.curate({ force: true });
    return Number(process.hrtime.bigint() - a) / 1e6;
  };
  await timed(200);   // warm
  const small = await timed(1500), big = await timed(6000);
  // Four times the lessons: about four times the work, not sixteen.
  assert.ok(big / small < 8, `1500 lessons ${small.toFixed(0)} ms, 6000 lessons ${big.toFixed(0)} ms`);
});

// ------------------------------------------------------------------ the module

/** The memory module against a stand-in for vyred: these projects and agents, events recorded. */
async function module_(t, { projects, agents = [], sessions = SESSIONS }) {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, sessions);
  const tools = new Map(), events = [];
  const ctx = {
    name: "memory", config: { me: { domains: ["riverastudio.com"] } }, paths: {}, store: { db, migrate: () => {} }, log: () => {},
    events: { on: () => () => {}, emit: (type, payload) => events.push({ type, payload }), since: () => [], prune: () => 0 },
    call: async (tool, input) => fakeReachCall(tool, input, { agents, projects }),
    tool: (name, def) => tools.set(name, def),
  };
  const handle = await memory.start(ctx);
  t.after(() => handle.stop());
  /** A tool's answer, or { error } with its message. */
  const call = async (name, input, caller) => {
    try { return { data: await tools.get(name).run(input, { caller }) }; } catch (e) { return { error: /** @type {Error} */ (e).message }; }
  };
  await call("memory.curate", {}, "cli");
  return { call, events, db };
}

test("scope: agents are granted projects, not folders under them; a project with only picked threads is its own room", async t => {
  // A thread in no project's folder, picked into a project that has no folders of its own.
  const scratch = { ...S("x", ["Sam Okafor at Northwind Bakery asked for the bread order totals.", "Sent Sam Okafor the bread order totals for Northwind Bakery."], T0 + 4 * DAY), cwd: `${HOME}/Scratch` };
  const projects = [
    { slug: "acme", name: "Acme", home: W },
    { slug: "northwind", name: "Northwind", home: `${W}/northwind` },
    { slug: "pantry", name: "Pantry", threads: [scratch.id] },
  ];
  const agents = [{ name: "kit", projects: ["northwind"] }, { name: "ace", projects: ["acme"] }, { name: "pip", projects: ["pantry"] }];
  const { call } = await module_(t, { projects, agents, sessions: [...SESSIONS, scratch] });
  const kit = await call("memory.facts", { project_cwds: [`${W}/northwind`] }, "mcp:agent:kit");
  assert.ok(!kit.error, kit.error);
  const texts = kit.data.facts.map(f => f.text);
  assert.ok(texts.some(x => x.includes("Sam Okafor")) && !texts.some(x => x.includes("Harlow")), texts.join("\n"));
  // ace holds ~/Work, which holds northwind's folder; northwind is still not ace's.
  assert.match((await call("memory.facts", { project_cwds: [`${W}/northwind`] }, "mcp:agent:ace")).error || "", /not granted/);
  assert.match((await call("memory.facts", { room: "northwind" }, "mcp:agent:ace")).error || "", /not granted/);
  assert.ok(!(await call("memory.facts", { room: "acme" }, "mcp:agent:ace")).error);
  // A project with no folders: read by slug, granted by slug, never the main graph.
  const pip = await call("memory.facts", { room: "pantry" }, "mcp:agent:pip");
  assert.ok(!pip.error, pip.error);
  // What its one picked thread says, and nothing from anywhere else.
  const pt = pip.data.facts.map(f => f.text);
  assert.ok(pt.some(x => x.includes("Sam Okafor")) && !pt.some(x => /Harlow|Dana/.test(x)), pt.join("\n"));
  const plan = await call("memory.graph", { room: "pantry" }, "deck");
  assert.equal(plan.data?.scope, "project");
  assert.equal(plan.data.rooms[0].label, "Pantry");
  assert.match((await call("memory.facts", { room: "pantry" }, "mcp:agent:kit")).error || "", /not granted/);
});

test("scope: a caller that names no agent and no room reads the main graph only from the user's own surfaces", async t => {
  const projects = [{ slug: "northwind", name: "Northwind", home: `${W}/northwind` }];
  const { call } = await module_(t, { projects });
  const reads = [["memory.facts", { about: "Dana Reyes" }], ["memory.relevant", { text: "email Dana Reyes" }], ["memory.why", { fact: "Dana Reyes" }], ["memory.stats", {}]];
  // "mcp" (a bare session) is the owner as far as projects.reach is concerned, so it still
  // reaches guard()'s own, more specific refusal; "harness" and "unknown" are refused earlier,
  // by projects.reach itself, before guard() gets a say (the swap onto the shared door, 35188a38
  // + 59d6833c: neither is scoped access any looser, only which refusal message fires first).
  for (const caller of ["mcp", "harness", "unknown"]) for (const [tool, input] of reads) {
    assert.match((await call(tool, input, caller)).error || "", /main graph|refused for/, `${tool} from ${caller}`);
  }
  for (const caller of ["deck", "cli", "local", "capsule", "module:projects"]) for (const [tool, input] of reads) {
    assert.ok(!(await call(tool, input, caller)).error, `${tool} from ${caller}`);
  }
  // With a scope the session reads its room.
  assert.ok(!(await call("memory.relevant", { text: "ask Sam Okafor", room: "northwind" }, "mcp")).error);
  assert.ok(!(await call("memory.relevant", { text: "ask Sam Okafor", project_cwds: [`${W}/northwind`] }, "mcp")).error);
  assert.ok(!(await call("memory.relevant", { text: "anything", room: "unfiled" }, "mcp")).error);
  // MS-1: steering and curating rebuild the WHOLE graph, so an unnamed model session may not (it may read the rooms it names); the person's surfaces still can.
  assert.ok((await call("memory.curate", {}, "mcp")).error);
  assert.ok(!(await call("memory.curate", {}, "cli")).error);
});

test("scope: the user's own tools refuse any caller that names an agent", async t => {
  const { call } = await module_(t, { projects: [] });
  for (const caller of ["deck agent:kit", "cli:agent:kit", "capsule agent:kit"]) {
    for (const [tool, input] of [["memory.correct", { fact: WORKS, action: "wrong" }], ["memory.corrections", {}], ["memory.uncorrect", { id: 1 }],
      ["memory.merge", { node: "Dana Reyes", into: "Sam Okafor" }], ["memory.split", { node: "Dana Reyes", other: "Sam Okafor" }]]) {
      assert.match((await call(tool, input, caller)).error || "", /agent/, `${tool} from ${caller}`);
    }
  }
  assert.ok(!(await call("memory.corrections", {}, "deck")).error);
});

test("scope: memory.correct answers at once, and memory.curated says when the graph has it", async t => {
  const { call, events, db } = await module_(t, { projects: [] });
  const openWorks = () => db.prepare("SELECT COUNT(*) n FROM memory_edges WHERE room = '*' AND src = ? AND rel = 'works_at' AND valid_to IS NULL").get(DANA)?.n;
  assert.equal(openWorks(), 1);
  const before = events.filter(e => e.type === "memory.curated").length;
  const r = await call("memory.correct", { fact: WORKS, action: "wrong" }, "deck");
  assert.ok(!r.error, r.error);
  assert.equal(r.data.pending, true);
  assert.equal(r.data.facts, undefined, "it waited for the derive");
  assert.equal(typeof r.data.correction.id, "number");
  // The derive runs behind the answer; curating now waits for it.
  await call("memory.curate", {}, "cli");
  assert.equal(openWorks(), 0);
  assert.ok(events.filter(e => e.type === "memory.curated").length > before, "no memory.curated after the correction");
  // wait: true answers after, with the fact as it reads.
  const w = await call("memory.correct", { subject: "Priya Anand", rel: "works_at", object: "Keel & Ash Architects", action: "add", wait: true }, "cli");
  assert.ok(!w.error, w.error);
  assert.equal(w.data.facts.find(f => f.rel === "works_at")?.text, "Priya Anand works at Keel & Ash Architects");
});
