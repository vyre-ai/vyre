// @ts-check
// The user corrects a fact (docs/adr/0007-intelligence.md, decision 4): wrong, ended, replace,
// confirm, add, and the merge and split of nodes. Applied in derive after the votes, so no
// transcript can derive them away; undoable; owner callers only. Fictional data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open } from "../store/index.js";
import { start } from "../daemon/index.js";
import { call, request } from "../daemon/client.js";
import { SESSIONS, HOME, seedRecall } from "../../test/fixtures/corpus.js";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../test/helpers.js";
import { Curator } from "./curator.js";
import { Graph } from "./graph.js";

const W = `${HOME}/Work`;
const T0 = Date.parse("2026-09-01T09:00:00Z");
const DAY = 86_400_000;
const DANA = "name:Dana Reyes", HARLOW = "name:Harlow Legal", NORTHWIND = "name:Northwind Bakery";
const WORKS = `${DANA}|works_at|${HARLOW}`;
let n = 0;
const S = (dir, turns, start) => ({
  id: `66666666-ffff-4000-8000-${String(++n).padStart(12, "0")}`, cwd: `${W}/${dir}`, start,
  turns: turns.map(text => ({ role: /** @type {"user"} */ ("user"), text })),
});

async function world(t, { sessions = SESSIONS, rooms = [] } = {}) {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, sessions);
  let clock = T0 + 20 * DAY;
  const curator = new Curator(db, { me: { domains: ["riverastudio.com"] }, now: () => clock });
  curator.setRooms(rooms);
  await curator.curate();
  const graph = new Graph(db, curator, { now: () => clock });
  /** What memory.correct does, without the module: resolve, record, derive. */
  const correct = async (input, scope = "*") => {
    const sc = scope === "*" ? null : graph.view([], scope);
    const x = graph.target(input, sc);
    const c = curator.correct({ action: input.action, src: x.src, rel: x.rel, dst: x.dst, object: x.object, at: input.at ?? null, scope, note: input.note ?? null });
    await curator.curate({ force: true });
    return c;
  };
  return { db, curator, graph, correct, add: list => seedRecall(db, list), at: ms => { clock = ms; } };
}
const rows = (db, src, rel, room = "*") => db.prepare("SELECT dst, valid_from, valid_to, confidence, origin, conflict FROM memory_edges WHERE room = ? AND src = ? AND rel = ? ORDER BY valid_from, dst").all(room, src, rel);
const openRows = (db, src, rel, room = "*") => rows(db, src, rel, room).filter(r => r.valid_to === null);
const dump = db => db.prepare("SELECT room, src, rel, dst, weight, valid_from, valid_to, confidence, seen, conflict, origin, rule FROM memory_edges ORDER BY 1, 2, 3, 4, 6").all();

test("correct: wrong is never true, and no pass derives it back", async t => {
  const { db, curator, correct, graph } = await world(t);
  assert.deepEqual(openRows(db, DANA, "works_at").map(r => r.dst), [HARLOW]);
  await correct({ fact: WORKS, action: "wrong" });
  assert.deepEqual(rows(db, DANA, "works_at"), []);
  await curator.curate({ full: true });
  assert.deepEqual(rows(db, DANA, "works_at"), [], "a full re-read derived a wrong fact back");
  assert.ok(!graph.relevant({ text: "ask Dana Reyes" }).some(f => f.text.includes("works at Harlow")));
  // Other facts about her stand.
  assert.equal(openRows(db, DANA, "has_email").length, 1);
  const again = dump(db);
  assert.equal(await curator.derive(), 0, "a correction must not make derive restless");
  assert.deepEqual(dump(db), again);
});

test("correct: ended closes the fact at its date; older evidence never reopens it, newer opens a new row", async t => {
  const { db, curator, correct, add } = await world(t);
  const end = T0 + 10 * DAY;
  await correct({ fact: WORKS, action: "ended", at: end });
  const [was] = rows(db, DANA, "works_at");
  assert.equal(was.dst, HARLOW);
  assert.equal(was.valid_to, end);
  assert.deepEqual(openRows(db, DANA, "works_at"), []);
  // More old talk changes nothing.
  add([S("misc", ["Dana Reyes (dana@harlowlegal.com) at Harlow Legal sent the old draft."], T0 + 2 * DAY)]);
  await curator.curate();
  assert.deepEqual(openRows(db, DANA, "works_at"), [], "evidence from before the end reopened it");
  // She comes back, later.
  add([1, 2].map(i => S("misc", [`Dana Reyes at Harlow Legal is back and sent file ${i}.`], T0 + (30 + i) * DAY)));
  await curator.curate();
  const back = openRows(db, DANA, "works_at");
  assert.deepEqual(back.map(r => r.dst), [HARLOW]);
  assert.ok(back[0].valid_from > end, "the new row starts after the end");
  assert.equal(rows(db, DANA, "works_at").filter(r => r.valid_to === end).length, 1, "the ended row is still there");
});

test("correct: replace ends the old fact and the user's row holds, sourced to them, never decaying", async t => {
  const { db, correct, graph, at, add, curator } = await world(t);
  const when = T0 + 12 * DAY;
  await correct({ fact: WORKS, action: "replace", object: "Northwind Bakery", at: when });
  assert.deepEqual(openRows(db, DANA, "works_at").map(r => [r.dst, r.confidence, r.origin]), [[NORTHWIND, 1, "user"]]);
  assert.equal(rows(db, DANA, "works_at").find(r => r.dst === HARLOW)?.valid_to, when);
  const f = graph.facts({ about: "Dana Reyes" }).facts.find(f => f.rel === "works_at" && !f.until);
  assert.equal(f?.source, "your correction");
  assert.equal(f?.origin, "user");
  assert.equal(f?.correction?.action, "replace");
  at(T0 + 900 * DAY);
  assert.equal(graph.facts({ about: "Dana Reyes" }).facts.find(f => f.rel === "works_at" && !f.until)?.fresh, 1, "what the user said does not decay");
  // Newer transcripts that disagree raise a conflict; they never change it.
  add([1, 2, 3].map(i => S("misc", [`Dana Reyes at Harlow Legal sent draft ${i} (dana@harlowlegal.com).`], T0 + (40 + i) * DAY)));
  await curator.curate();
  const now = openRows(db, DANA, "works_at");
  assert.deepEqual(now.map(r => [r.dst, r.origin, r.conflict]), [[NORTHWIND, "user", 1]]);
});

test("correct: confirm makes a fact sure and keeps it open; add is a new fact, even about a new thing", async t => {
  const { db, correct, graph, add, curator } = await world(t);
  await correct({ fact: WORKS, action: "confirm" });
  assert.deepEqual(openRows(db, DANA, "works_at").map(r => [r.dst, r.confidence, r.origin]), [[HARLOW, 1, "confirmed"]]);
  // A move the transcripts show later does not close a confirmed fact.
  add([1, 2, 3, 4].map(i => S("misc", [`Dana Reyes at Northwind Bakery sent batch ${i} (dana@northwindbakery.com).`], T0 + (25 + i) * DAY)));
  await curator.curate();
  const open_ = openRows(db, DANA, "works_at");
  assert.deepEqual(open_.map(r => [r.dst, r.origin, r.conflict]), [[HARLOW, "confirmed", 1]]);
  await correct({ subject: "Priya Anand", rel: "works_at", object: "Keel & Ash Architects", action: "add" });
  const f = graph.facts({ about: "Priya Anand" }).facts.find(f => f.rel === "works_at");
  assert.equal(f?.text, "Priya Anand works at Keel & Ash Architects");
  assert.equal(f?.source, "your correction");
  assert.ok(graph.relevant({ text: "ask Priya Anand" }).some(x => x.id === f.id));
});

test("correct: undo restores what derive believes", async t => {
  const { db, curator, correct } = await world(t);
  const before = dump(db);
  const c = await correct({ fact: WORKS, action: "wrong" });
  assert.equal(rows(db, DANA, "works_at").length, 0);
  curator.uncorrect(Number(c.id));
  await curator.curate();
  assert.deepEqual(dump(db), before);
  assert.throws(() => curator.uncorrect(Number(c.id)), /no correction/);
  assert.equal(curator.corrections().length, 0);
  assert.equal(curator.corrections({ all: true })[0].undone > 0, true);
});

test("correct: a project's correction stays in its room", async t => {
  const rooms = [{ slug: "harlow", name: "Harlow Legal", folders: [`${W}/harlow-site`, `${W}/harlow-intake`], threads: [] }];
  const { db, correct } = await world(t, { rooms });
  await correct({ fact: WORKS, action: "wrong" }, "harlow");
  assert.deepEqual(openRows(db, DANA, "works_at", "harlow"), []);
  assert.deepEqual(openRows(db, DANA, "works_at", "*").map(r => r.dst), [HARLOW], "a project's correction reached the main graph");
});

test("merge makes two nodes one, split by room makes one name two people, and split undoes a merge", async t => {
  const rooms = [
    { slug: "harlow", name: "Harlow Legal", folders: [`${W}/harlow-site`, `${W}/harlow-intake`], threads: [] },
    { slug: "bramble", name: "Bramble Dental", folders: [`${W}/bramble`], threads: [] },
  ];
  const bramble = [1, 2].map(i => S("bramble", [`Dana Reyes at Bramble Dental sent the x-ray forms, batch ${i}.`], T0 + (10 + i) * DAY));
  const { db, curator, graph } = await world(t, { sessions: [...SESSIONS, ...bramble], rooms });
  assert.equal(openRows(db, DANA, "works_at")[0]?.conflict, 1, "the fixture must start as a conflict");
  const split = curator.correct({ action: "split", src: DANA, object: "bramble" });
  await curator.curate();
  const other = `${DANA}#bramble`;
  assert.deepEqual(openRows(db, DANA, "works_at").map(r => [r.dst, r.conflict]), [[HARLOW, 0]]);
  assert.deepEqual(openRows(db, other, "works_at").map(r => [r.dst, r.conflict]), [["name:Bramble Dental", 0]]);
  assert.equal(db.prepare("SELECT label FROM memory_nodes WHERE id = ?").get(other)?.label, "Dana Reyes", "both are called Dana Reyes");
  assert.deepEqual(openRows(db, other, "works_at", "bramble").map(r => r.dst), ["name:Bramble Dental"]);
  curator.uncorrect(Number(split.id));
  await curator.curate();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM memory_nodes WHERE id = ?").get(other)?.n, 0);

  // Merge: "Dana M Reyes" is Dana Reyes.
  const { db: db2, curator: c2, graph: g2 } = await world(t, { sessions: [...SESSIONS,
    ...[1, 2, 3].map(i => S("harlow-site", [`we sent Dana Marie Reyes the intake copy, round ${i}.`], T0 + i * DAY))] });
  assert.ok(g2.resolve("Dana Marie Reyes"));
  const before = Number(db2.prepare("SELECT sessions FROM memory_nodes WHERE id = ?").get(DANA)?.sessions);
  const m = c2.correct({ action: "merge", src: "name:Dana Marie Reyes", dst: DANA });
  await c2.curate();
  assert.equal(db2.prepare("SELECT COUNT(*) n FROM memory_nodes WHERE id = 'name:Dana Marie Reyes'").get()?.n, 0);
  assert.equal(Number(g2.facts({ about: "Dana Reyes" }).about?.sessions), before + 3, "the merged node carries both sets of sessions");
  c2.correct({ action: "split", src: "name:Dana Marie Reyes", dst: DANA });
  await c2.curate();
  assert.ok(g2.resolve("Dana Marie Reyes"), "split with other undoes the merge");
  void m; void graph;
});

test("correct: tools are for the owner's surfaces, and the event carries no names", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ me: { domains: ["riverastudio.com"] } }));
  const db = open(path.join(root, "vyre.db")); seedRecall(db); db.close();
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  await call("memory.curate", {}, { root });
  const r = await call("memory.correct", { fact: WORKS, action: "replace", object: "Northwind Bakery", at: "2026-09-10", note: "she moved in September" }, { root });
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.equal(r.data.facts.find(f => !f.until)?.text, "Dana Reyes works at Northwind Bakery");
  const ev = (await request("GET", "/v1/events?type=memory.corrected", undefined, { root })).data;
  assert.equal(ev.length, 1);
  assert.deepEqual(Object.keys(ev[0].payload).sort(), ["action", "id", "prior_confidence", "prior_rule", "prior_source", "rel", "scope"]);
  assert.deepEqual({ ...ev[0].payload, prior_confidence: typeof ev[0].payload.prior_confidence }, {
    id: r.data.correction.id, action: "replace", rel: "works_at", scope: "all", prior_source: "extract", prior_rule: ev[0].payload.prior_rule, prior_confidence: "number" });
  assert.ok(!JSON.stringify(ev[0].payload).match(/Dana|Harlow|Northwind|name:|@|September/), "the event leaked a label, node id or note");
  const list = (await call("memory.corrections", {}, { root })).data;
  assert.equal(list.length, 1);
  // A session (MCP) and an agent can neither correct nor list.
  for (const caller of ["mcp", "mcp:agent:kit", "harness"]) {
    for (const [tool, input] of [["memory.correct", { fact: WORKS, action: "wrong" }], ["memory.merge", { node: "Dana Reyes", into: "Sam Okafor" }],
      ["memory.split", { node: "Dana Reyes", other: "Sam Okafor" }], ["memory.uncorrect", { id: 1 }], ["memory.corrections", {}]]) {
      assert.equal((await d.registry.call(tool, input, caller)).error?.code, "denied", `${tool} from ${caller}`);
    }
  }
  const undo = await call("memory.uncorrect", { id: r.data.correction.id }, { root });
  assert.ok(undo.data.undone);
  assert.equal((await call("memory.facts", { about: "Dana Reyes" }, { root })).data.facts.find(f => f.rel === "works_at" && !f.until)?.object.label, "Harlow Legal");
  const merged = await call("memory.merge", { node: "Sam Okafor", into: "Dana Reyes" }, { root });
  assert.ok(!merged.error);
  assert.deepEqual((await request("GET", "/v1/events?type=memory.merged", undefined, { root })).data[0].payload, { id: merged.data.correction.id, scope: "all" });
  assert.match((await call("memory.split", { node: "Dana Reyes" }, { root })).error?.message || "", /needs room/);
});

test("correct: the CLI corrects, lists, undoes, merges and splits, with --project", async t => {
  const root = fs.realpathSync(tempHome(t));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ me: { domains: ["riverastudio.com"] } }));
  const db = open(path.join(root, "vyre.db")); seedRecall(db); db.close();
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  await call("memory.curate", {}, { root });
  const bin = fileURLToPath(new URL("../../bin/vyre", import.meta.url));
  const vyre = (...args) => new Promise(resolve => execFile(process.execPath, [bin, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1" } },
    (err, stdout, stderr) => resolve({ code: err ? Number(err.code) || 1 : 0, text: stdout + stderr })));
  const fixed = await vyre("memory", "correct", WORKS, "replace", "Northwind", "Bakery", "--at", "2026-09-10", "--note", "moved");
  assert.equal(fixed.code, 0, fixed.text);
  assert.match(fixed.text, /Dana Reyes works at Northwind Bakery/);
  assert.match(fixed.text, /your correction/);
  const list = await vyre("memory", "corrections");
  assert.match(list.text, /replace/);
  assert.match((await vyre("why", `${DANA}|works_at|${NORTHWIND}`)).text, /your replace/);
  assert.equal((await vyre("memory", "uncorrect", "1")).code, 0);
  assert.match((await vyre("memory", "correct", WORKS)).text, /vyre memory correct <fact>/);
  assert.match((await vyre("memory", "Dana Reyes", "--project", "nowhere")).text, /no project nowhere/);
  assert.equal((await vyre("memory", "merge", "Sam Okafor", "Dana Reyes")).code, 0);
  assert.match((await vyre("memory", "split", "Dana Reyes")).text, /vyre memory split <node> --project/);
  assert.match((await vyre("memory", "pin", "Dana Reyes")).text, /pinned/);
});
