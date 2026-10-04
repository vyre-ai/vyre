// @ts-check
// Rooms (docs/adr/0007-intelligence.md, decision 1): each project's graph is computed from its own
// sessions and lessons, and nothing crosses between rooms. Fictional data only.
//
// The failure this guards is quiet: another client's sessions changing what a project believes,
// how sure it is, or what a short word means there. Every test builds a world where the naive,
// global answer is the wrong one for a room.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../store/index.js";
import { SESSIONS, HOME, seedRecall } from "../../test/fixtures/corpus.js";
import fs from "node:fs";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome } from "../../test/helpers.js";
import { Curator } from "./curator.js";
import { Graph } from "./graph.js";

const W = `${HOME}/Work`;
const T0 = Date.parse("2026-09-01T09:00:00Z");
const DAY = 86_400_000;
const PLANNING = SESSIONS[3].id;   // "Weekly planning", in the parent folder, names both clients
const ROOMS = [
  { slug: "harlow", name: "Harlow Legal", folders: [`${W}/harlow-site`, `${W}/harlow-intake`], threads: [PLANNING] },
  { slug: "northwind", name: "Northwind", folders: [`${W}/northwind`], threads: [PLANNING] },
];
let n = 0;
const S = (dir, turns, { start = T0 + 5 * DAY, name } = {}) => ({
  id: `44444444-dddd-4000-8000-${String(++n).padStart(12, "0")}`, cwd: `${W}/${dir}`, start, name,
  turns: turns.map(text => ({ role: /** @type {"user"} */ ("user"), text })),
});
// Dana comes up in Northwind's own work, so she is in both rooms.
const CROSSOVER = S("northwind", ["we asked Dana Reyes whether the bakery can cater the Friday lunch."]);
const CROSSOVER2 = S("northwind", ["the bakery quoted Dana Reyes for the Friday lunch."]);
const CROSSOVER3 = S("northwind", ["the lunch order for Dana Reyes is confirmed."]);
const UNFILED_ONE = S("misc", ["Pinecrest Dental wants a quote; Pinecrest Dental is on pinecrestdental.com."]);

async function world(t, { sessions = [...SESSIONS, CROSSOVER, CROSSOVER2, CROSSOVER3, UNFILED_ONE], rooms = ROOMS, me = { domains: ["riverastudio.com"] } } = {}) {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, sessions);
  const curator = new Curator(db, { me });
  curator.setRooms(rooms);
  await curator.curate();
  return { db, curator, graph: new Graph(db, curator, { now: () => T0 + 30 * DAY }), add: list => seedRecall(db, list) };
}

/** Everything a room has, without row ids or write times, in a fixed order. */
const roomDump = (db, room) => ({
  nodes: db.prepare("SELECT id, kind, key, label, role, sessions, mentions, first_seen, last_seen FROM memory_room_nodes WHERE room = ? ORDER BY id").all(room),
  edges: db.prepare("SELECT src, rel, dst, weight, valid_from, valid_to, confidence, seen, conflict, origin, rule FROM memory_edges WHERE room = ? ORDER BY src, rel, dst, valid_from").all(room),
  evidence: db.prepare("SELECT e.src, e.rel, e.dst, e.valid_from, v.session, v.seq FROM memory_evidence v JOIN memory_edges e ON e.id = v.edge WHERE e.room = ? ORDER BY 1, 2, 3, 4, 5, 6").all(room),
  lessons: db.prepare("SELECT e.src, e.rel, e.dst, l.module, l.kind, l.key FROM memory_lessons l JOIN memory_edges e ON e.id = l.edge WHERE e.room = ? ORDER BY 1, 2, 3, 4, 5, 6").all(room),
  forms: db.prepare("SELECT node, form, precision, sessions FROM memory_shortforms WHERE room = ? ORDER BY node, form").all(room),
});
const has = (db, room, id) => Boolean(db.prepare("SELECT 1 FROM memory_room_nodes WHERE room = ? AND id = ?").get(room, id));
const open_ = (db, room, src, rel) => db.prepare("SELECT dst, confidence, conflict, valid_from, valid_to FROM memory_edges WHERE room = ? AND src = ? AND rel = ? AND valid_to IS NULL").all(room, src, rel);

test("rooms: deleting every other room's sessions leaves a room's rows identical", async t => {
  const { db, curator } = await world(t);
  curator.teach("watchers", "watcher.item", { subject: "Northwind Bakery", text: "4 new invoices this week", project_cwds: [`${W}/northwind`] });
  curator.teach("projects", "project.person", { subject: "Dana Reyes", rel: "works_at", object: "Harlow Legal", project_cwds: [`${W}/harlow-site`] });
  await curator.curate();
  const before = { harlow: roomDump(db, "harlow"), northwind: roomDump(db, "northwind") };
  assert.ok(before.harlow.edges.length > 5 && before.northwind.edges.length > 3, "the fixture should give both rooms something to lose");
  for (const room of ["harlow", "northwind"]) {
    const mine = curator.roomSessions(room);
    const others = [...curator.membership().keys()].filter(s => !mine.has(s));
    assert.ok(others.length > 0);
    // Gone from Recall: the curator drops everything read from them on its next pass.
    for (const s of others) { db.prepare("DELETE FROM recall_turns WHERE session = ?").run(s); db.prepare("DELETE FROM recall_sessions WHERE id = ?").run(s); }
    await curator.curate({ force: true });
    assert.deepEqual(roomDump(db, room), before[room], `${room}'s rows changed when other rooms' sessions went`);
    // Put them back for the next room.
    db.prepare("DELETE FROM recall_turns").run(); db.prepare("DELETE FROM recall_sessions").run();
    seedRecall(db, [...SESSIONS, CROSSOVER, CROSSOVER2, CROSSOVER3, UNFILED_ONE]);
    await curator.curate({ force: true });
  }
});

test("rooms: a room's confidence never reflects another room's votes", async t => {
  const busy = [1, 2, 3].map(i => S("northwind", [`Dana Reyes and Northwind Bakery planned batch ${i} of the catering.`]));
  const quiet = await world(t);
  const loud = await world(t, { sessions: [...SESSIONS, CROSSOVER, CROSSOVER2, CROSSOVER3, UNFILED_ONE, ...busy] });
  const DANA = "name:Dana Reyes";
  const q = open_(quiet.db, "harlow", DANA, "works_at"), l = open_(loud.db, "harlow", DANA, "works_at");
  assert.equal(q[0]?.dst, "name:Harlow Legal");
  assert.deepEqual(l, q, "Northwind's sessions changed how sure Harlow's room is about Dana");
  assert.notEqual(open_(loud.db, "*", DANA, "works_at")[0]?.confidence, open_(quiet.db, "*", DANA, "works_at")[0]?.confidence, "the main graph does count every room");
});

test("rooms: a hub thread picked into two projects does not carry a client across", async t => {
  const { db, graph } = await world(t);
  // Weekly planning names Harlow Legal, Northwind Bakery, Dana and Sam, and is in both rooms.
  assert.ok(!has(db, "northwind", "name:Harlow Legal"), "the shared thread carried Harlow Legal into Northwind's room");
  assert.ok(!has(db, "harlow", "name:Northwind Bakery"), "the shared thread carried Northwind Bakery into Harlow's room");
  assert.ok(!has(db, "harlow", "name:Sam Okafor"));
  // Dana is Northwind's too (its own session names her), so the thread counts for her there.
  assert.ok(has(db, "northwind", "name:Dana Reyes"));
  assert.ok(!graph.relevant({ text: "ask Dana Reyes", room: "northwind" }).some(f => f.text.includes("Harlow")));
  assert.ok(!graph.facts({ room: "northwind" }).facts.some(f => f.text.includes("Harlow")));
  // And the main graph has everything.
  assert.ok(graph.facts({ about: "Harlow Legal" }).about);
});

test("rooms: unfiled never sees project-private facts, and reads only unfiled sessions", async t => {
  const { curator, graph } = await world(t);
  curator.teach("watchers", "watcher.item", { subject: "Northwind Bakery", text: "4 new invoices this week", project_cwds: [`${W}/northwind`] });
  await curator.curate();
  assert.deepEqual(graph.relevant({ text: "ask Sam Okafor about Northwind Bakery", room: "unfiled" }), []);
  assert.deepEqual(graph.relevant({ text: "the Harlow intake for Dana Reyes", room: "unfiled" }), []);
  const facts = graph.facts({ room: "unfiled" }).facts.map(f => f.text);
  assert.ok(facts.some(x => x.includes("Pinecrest Dental")), facts.join("\n"));
  assert.ok(!facts.some(x => /Northwind|Harlow|invoices/.test(x)), facts.join("\n"));
  assert.ok(graph.relevant({ text: "the Pinecrest Dental quote", room: "unfiled" }).length > 0);
  // A project's room has the lesson; the main graph too.
  assert.ok(graph.facts({ room: "northwind" }).facts.some(f => f.text.includes("4 new invoices")));
});

test("rooms: a main client is not a hub when a project is named for it or it is taught as a client", async t => {
  const many = [];
  for (let i = 0; i < 10; i++) many.push(S("harlow-site", [`Harlow Legal round ${i}: the intake copy for Harlow Legal is ready.`]));
  const others = [1, 2].map(i => S("misc", [`Pinecrest Dental note ${i}.`]));
  const sessions = [...many, ...others];
  const role = (db, room) => db.prepare(room === "*" ? "SELECT role FROM memory_nodes WHERE id = ?" : "SELECT role FROM memory_room_nodes WHERE room = ? AND id = ?")
    .get(...(room === "*" ? [] : [room]), "name:Harlow Legal")?.role ?? null;
  // No project: past the session share, it is hidden as a hub. This is the failure being guarded.
  const bare = await world(t, { sessions, rooms: [] });
  assert.equal(role(bare.db, "*"), "hub", "the fixture must make the naive rule hide the main client");
  const named = await world(t, { sessions });
  assert.equal(role(named.db, "*"), null);
  assert.equal(role(named.db, "harlow"), null);
  const taught = await world(t, { sessions, rooms: [] });
  taught.curator.teach("projects", "project.client", { subject: { name: "Harlow Legal", kind: "org" }, rel: "client_of", object: { name: "Rivera Studio", kind: "org" } });
  await taught.curator.curate();
  assert.equal(role(taught.db, "*"), null, "a taught client is never a hub");
});

test("rooms: an org in many rooms is a hub of the main graph, not of any room", async t => {
  const rooms = ["a", "b", "c", "d"].map(x => ({ slug: `p${x}`, name: `Project ${x.toUpperCase()}`, folders: [`${W}/p${x}`], threads: [] }));
  const sessions = rooms.flatMap(r => [1, 2].map(i => S(r.slug, [`we filed the ${r.name} payroll with Summit Payroll Services, run ${i}.`])));
  const { db } = await world(t, { sessions, rooms });
  assert.equal(db.prepare("SELECT role FROM memory_nodes WHERE id = 'name:Summit Payroll Services'").get()?.role, "hub");
  assert.equal(db.prepare("SELECT role FROM memory_room_nodes WHERE room = 'pa' AND id = 'name:Summit Payroll Services'").get()?.role, null);
});

test("rooms: a short form means the claimant in view", async t => {
  const rooms = [
    { slug: "dental", name: "Dental site", folders: [`${W}/dental`], threads: [] },
    { slug: "roofing", name: "Roofing site", folders: [`${W}/roofing`], threads: [] },
  ];
  const sessions = [
    S("dental", ["Summit Dental wants the booking page on summitdental.com; the Summit patients asked for it."]),
    S("dental", ["the Summit reviews for Summit Dental are in; see summitdental.com/reviews."]),
    S("roofing", ["Summit Roofing sent quotes from summitroofing.com; the Summit crew starts Monday."]),
    S("roofing", ["the Summit estimate for Summit Roofing is on summitroofing.com/quote."]),
  ];
  const { db, graph } = await world(t, { sessions, rooms });
  const forms = db.prepare("SELECT room, node, precision FROM memory_shortforms WHERE form = 'summit' ORDER BY room, node").all();
  assert.ok(forms.filter(f => f.room === "*").length === 2, "the main graph keeps every claimant");
  const dental = graph.relevant({ text: "email the Summit team", room: "dental" });
  assert.ok(dental.length && dental.every(f => f.text.includes("Summit Dental")), dental.map(f => f.text).join("\n"));
  const roofing = graph.relevant({ text: "email the Summit team", room: "roofing" });
  assert.ok(roofing.length && roofing.every(f => f.text.includes("Summit Roofing")), roofing.map(f => f.text).join("\n"));
  // Folders a project owns are its room too.
  assert.ok(graph.relevant({ text: "email the Summit team", project_cwds: [`${W}/roofing`] }).every(f => f.text.includes("Summit Roofing")));
});

test("rooms: two rooms' different beliefs mark the main graph's row as a conflict when seen close together", async t => {
  const rooms = [...ROOMS, { slug: "bramble", name: "Bramble Dental", folders: [`${W}/bramble`], threads: [] }];
  const bramble = (start) => [1, 2].map(i => S("bramble", [`Dana Reyes at Bramble Dental sent the x-ray forms, batch ${i}.`], { start: start + i * DAY }));
  const close = await world(t, { sessions: [...SESSIONS, ...bramble(T0 + 10 * DAY)], rooms });
  const DANA = "name:Dana Reyes";
  assert.equal(open_(close.db, "harlow", DANA, "works_at")[0]?.dst, "name:Harlow Legal");
  assert.equal(open_(close.db, "bramble", DANA, "works_at")[0]?.dst, "name:Bramble Dental");
  assert.equal(open_(close.db, "harlow", DANA, "works_at")[0]?.conflict, 0, "a room's own row is never a conflict");
  const star = open_(close.db, "*", DANA, "works_at");
  assert.equal(star.length, 1);
  assert.equal(star[0].conflict, 1, "the main graph must ask, not pick");
  assert.equal(close.graph.facts({ about: "Dana Reyes" }).facts.find(f => f.rel === "works_at" && !f.until)?.conflict, true);
  // Seen far apart, it is a move: the newer room's belief holds in the main graph, the older is
  // closed there and stays open in its own room.
  const far = await world(t, { sessions: [...SESSIONS, ...bramble(T0 + 200 * DAY)], rooms });
  const s2 = open_(far.db, "*", DANA, "works_at");
  assert.deepEqual(s2.map(e => [e.dst, e.conflict]), [["name:Bramble Dental", 0]]);
  assert.equal(open_(far.db, "harlow", DANA, "works_at")[0]?.dst, "name:Harlow Legal");
  const closed = far.db.prepare("SELECT valid_to FROM memory_edges WHERE room = '*' AND src = ? AND rel = 'works_at' AND dst = 'name:Harlow Legal'").get(DANA);
  assert.ok(closed?.valid_to, "the older belief closes in the main graph");
});

test("rooms: rooms come and go with the project list, and a migration asks for one more derive", async t => {
  const { db, curator, graph } = await world(t, { rooms: [] });
  assert.deepEqual(curator.rooms(), []);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM memory_room_nodes WHERE room = 'harlow'").get()?.n, 0);
  assert.equal(curator.setRooms(ROOMS), true);
  assert.equal(curator.setRooms(ROOMS), false, "the same list twice is no change");
  await curator.curate();
  assert.ok(has(db, "harlow", "name:Dana Reyes"));
  assert.ok(graph.facts({ project_cwds: [`${W}/harlow-site`] }).facts.some(f => f.text === "Dana Reyes works at Harlow Legal"));
  assert.throws(() => graph.facts({ room: "nowhere" }), /no project nowhere/);
  curator.setRooms([]);
  await curator.curate();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM memory_edges WHERE room = 'harlow'").get()?.n, 0, "a room that is gone keeps no rows");
  // The flag the rooms migration sets: the next pass derives even with nothing new.
  const runs = () => Number(db.prepare("SELECT COUNT(*) n FROM memory_runs").get()?.n);
  const before = runs();
  await curator.curate();
  assert.equal(runs(), before, "nothing new and no flag: no derive");
  db.prepare("INSERT INTO memory_meta (k, v) VALUES ('rederive', 1)").run();
  await curator.curate();
  assert.equal(runs(), before + 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM memory_meta WHERE k = 'rederive'").get()?.n, 0, "the flag is spent once");
});

test("rooms: vyred keeps the rooms in step with Projects, picks included, and guards the unfiled room", async t => {
  const root = fs.realpathSync(tempHome(t));
  const work = path.join(root, "Work");
  const moved = [...SESSIONS, CROSSOVER, CROSSOVER2, CROSSOVER3, UNFILED_ONE].map(s => ({ ...s, cwd: s.cwd.replace(W, work) }));
  const db = open(path.join(root, "vyre.db")); seedRecall(db, moved); db.close();
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const opts = { root };
  assert.ok(!(await call("projects.create", { name: "Northwind", home: path.join(work, "northwind") }, opts)).error);
  assert.ok(!(await call("projects.create", { name: "Harlow", home: path.join(work, "harlow-site"), workspaces: [path.join(work, "harlow-intake")] }, opts)).error);
  assert.ok(!(await call("agents.create", { name: "kit", projects: ["northwind"] }, opts)).error);
  // memory's guard now also checks projects.access (Vyre Drive step 3): seed it from what
  // agents.create just set, the way an upgrade would, so kit's grant keeps working here.
  assert.ok(!(await call("projects.access.migrate", {}, opts)).error);
  await call("memory.curate", {}, opts);
  const nw = (await call("memory.facts", { room: "northwind" }, opts)).data.facts.map(f => f.text);
  assert.ok(nw.some(x => x.includes("Sam Okafor")) && !nw.some(x => x.includes("Harlow")), nw.join("\n"));
  const unfiled = (await call("memory.relevant", { text: "the Pinecrest Dental quote", room: "unfiled" }, opts)).data;
  assert.ok(unfiled.length > 0);
  assert.deepEqual((await call("memory.relevant", { text: "ask Sam Okafor", room: "unfiled" }, opts)).data, []);
  assert.match((await call("memory.relevant", { text: "Pinecrest Dental", room: "unfiled", agent: "kit" }, opts)).error?.message || "", /unfiled room/);
  assert.ok(!(await call("memory.facts", { room: "northwind", agent: "kit" }, opts)).error);
  assert.match((await call("memory.facts", { room: "harlow", agent: "kit" }, opts)).error?.message || "", /not granted/);
});
