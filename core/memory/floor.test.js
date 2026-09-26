// @ts-check
// memory.graph: the floor plan. Rooms per project, the shared room, strict project graphs (a
// project never draws another client's facts), the updated cursor, the caps, and who may see
// the main graph.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open } from "../store/index.js";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { SESSIONS, HOME, seedRecall } from "../../test/fixtures/corpus.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { Curator } from "./curator.js";
import { Graph } from "./graph.js";
import { floorPlan } from "./floor.js";

const W = `${HOME}/Work`;
/** The fixtures are dated, so the clock that ages them is too. */
const NOW = Date.parse("2026-10-01T09:00:00Z");
const NORTHWIND = [`${W}/northwind`], HARLOW = [`${W}/harlow-site`, `${W}/harlow-intake`];
const PROJECTS = [
  { slug: "harlow", name: "Harlow Legal", folders: HARLOW },
  { slug: "northwind", name: "Northwind", folders: NORTHWIND },
];
// Dana comes up once in Northwind's own work too, which makes her shared between the two.
const CROSSOVER = {
  id: "33333333-cccc-4000-8000-000000000001", cwd: `${W}/northwind`, name: "Bakery order", start: Date.parse("2026-09-03T09:00:00Z"),
  turns: [{ role: /** @type {"user"} */ ("user"), text: "Dana Reyes asked whether the bakery can cater the Friday lunch." }],
};

async function world(t, sessions = [...SESSIONS, CROSSOVER]) {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, sessions);
  const curator = new Curator(db, { me: { domains: ["riverastudio.com"] } });
  await curator.curate();
  return { db, curator, graph: new Graph(db, curator, { now: () => NOW }), add: list => seedRecall(db, list) };
}
const plan = (g, input = {}) => floorPlan(g, { projects: PROJECTS, ...input });
const byLabel = (p, label) => p.nodes.find(n => n.label === label);

test("graph: the main graph has a room per project and a shared room for who both share", async t => {
  const { graph } = await world(t);
  const p = plan(graph);
  assert.equal(p.scope, "main");
  assert.deepEqual(p.rooms.map(r => r.id).sort(), ["project:harlow", "project:northwind", "shared"].sort().concat(p.rooms.some(r => r.id === "unfiled") ? ["unfiled"] : []).sort());
  assert.equal(byLabel(p, "Harlow Legal")?.room, "project:harlow");
  assert.equal(byLabel(p, "Northwind Bakery")?.room, "project:northwind");
  assert.equal(byLabel(p, "Sam Okafor")?.room, "project:northwind");
  const dana = byLabel(p, "Dana Reyes");
  assert.equal(dana?.room, "shared");
  assert.deepEqual(dana?.rooms, ["project:harlow", "project:northwind"]);
  assert.ok(p.rooms.find(r => r.id === "project:harlow").facts > 0, "rooms carry how many facts they hold");
  // Threads are nodes too, joined by mentioned_in; people and organisations by what they are.
  assert.ok(p.nodes.some(n => n.kind === "thread" && n.label === "Harlow site rebuild"));
  assert.ok(p.edges.some(e => e.src === dana.id && e.rel === "works_at"));
  assert.ok(p.edges.every(e => p.nodes.some(n => n.id === e.src) && p.nodes.some(n => n.id === e.dst)), "an edge points outside the drawing");
  // The user's own things and tools are not drawn.
  assert.ok(!p.nodes.some(n => n.role === "own" || n.role === "tool"));
});

test("graph: a project's graph is its own; another client's facts never reach it", async t => {
  const { graph } = await world(t);
  const nw = plan(graph, { project_cwds: NORTHWIND });
  assert.equal(nw.scope, "project");
  assert.deepEqual(nw.rooms.map(r => [r.id, r.label]), [["project:northwind", "Northwind"]]);
  assert.ok(nw.nodes.every(n => n.room === "project:northwind"));
  assert.ok(byLabel(nw, "Dana Reyes"), "Northwind's own session names Dana");
  assert.ok(!byLabel(nw, "Harlow Legal"), "Harlow Legal leaked into Northwind's graph");
  assert.ok(!nw.edges.some(e => e.rel === "works_at" && e.dst === "name:Harlow Legal"), "a fact Harlow's sessions established was drawn in Northwind");
  assert.ok(!nw.nodes.some(n => n.kind === "thread" && n.label === "Harlow site rebuild"));
  // The same rule everywhere a project's view is read.
  const facts = graph.facts({ project_cwds: NORTHWIND }).facts.map(f => f.text);
  assert.ok(!facts.some(x => x.includes("Harlow")), facts.join("\n"));
  assert.ok(!graph.relevant({ text: "ask Dana Reyes", project_cwds: NORTHWIND }).some(f => f.text.includes("Harlow")));
  assert.ok(graph.facts({ about: "Dana Reyes", project_cwds: NORTHWIND }).facts.every(f => !f.text.includes("Harlow") && (!f.ref || f.ref.session === CROSSOVER.id)));
  const why = graph.why({ fact: "name:Dana Reyes|works_at|name:Harlow Legal", project_cwds: NORTHWIND });
  assert.deepEqual(why.turns, [], "why showed another project's turns");
  // And Harlow's own graph still has all of it.
  const hl = graph.facts({ project_cwds: HARLOW }).facts.map(f => f.text);
  assert.ok(hl.includes("Dana Reyes works at Harlow Legal"));
});

test("graph: in a project's view, what only another project knows is not even found", async t => {
  const { graph, add, curator } = await world(t);
  // Found by name, by short form, or through why: nothing, not an empty answer about it.
  assert.equal(graph.facts({ about: "Harlow Legal", project_cwds: NORTHWIND }).about, null);
  assert.equal(graph.facts({ about: "Harlow", project_cwds: NORTHWIND }).about, null);
  assert.equal(graph.why({ fact: "Harlow Legal", project_cwds: NORTHWIND }).fact, null);
  assert.throws(() => graph.steer({ node: "Harlow Legal", mode: "mute", project_cwds: NORTHWIND }), /nothing in memory/);
  // Counts and times of what is found come from this project alone.
  const dana = graph.facts({ about: "Dana Reyes", project_cwds: NORTHWIND }).about;
  assert.equal(dana?.sessions, 1);
  assert.equal(dana?.last, CROSSOVER.start);
  assert.ok(Number(graph.facts({ about: "Dana Reyes" }).about?.sessions) > 1);
  // A parent folder spanning projects is named for itself; case matters in a folder.
  assert.deepEqual(plan(graph, { project_cwds: [W] }).rooms.map(r => r.label), ["Work"]);
  assert.equal(plan(graph, { project_cwds: [`${W}/Northwind`] }).nodes.length, 0);
  // Dana moves, but only Northwind's sessions say so. Harlow's view still has her at Harlow,
  // with no date closing it: the closing came from another client's work.
  add([1, 2, 3, 4].map(i => ({ id: `33333333-cccc-4000-8000-00000000010${i}`, cwd: `${W}/northwind`, start: Date.parse("2026-09-20T09:00:00Z") + i * 86_400_000,
    turns: [{ role: /** @type {"user"} */ ("user"), text: `Dana Reyes at Northwind Bakery sent batch ${i} (dana@northwindbakery.com).` }] })));
  await curator.curate();
  const everywhere = graph.facts({ about: "Dana Reyes" }).facts.find(f => f.id === "name:Dana Reyes|works_at|name:Harlow Legal");
  assert.ok(everywhere?.until, "the fixture should close the old edge in the main graph");
  const inHarlow = graph.facts({ about: "Dana Reyes", project_cwds: HARLOW }).facts.find(f => f.id === "name:Dana Reyes|works_at|name:Harlow Legal");
  assert.equal(inHarlow?.until, null, "Harlow's view dated a change only Northwind's sessions made");
  const drawn = plan(graph, { project_cwds: HARLOW }).edges.find(e => e.id === "name:Dana Reyes|works_at|name:Harlow Legal");
  assert.equal(drawn?.until, null);
});

test("graph: taught facts are nodes in their project's room; around draws one neighbourhood", async t => {
  const { curator, graph } = await world(t);
  curator.teach("watchers", "watcher.item", { subject: "Northwind Bakery", text: "4 new invoices this week", project_cwds: NORTHWIND });
  await curator.curate();
  const main = plan(graph);
  const note = main.nodes.find(n => n.kind === "fact");
  assert.equal(note?.label, "4 new invoices this week");
  assert.equal(note?.room, "project:northwind");
  assert.ok(main.edges.some(e => e.dst === note.id && e.taught));
  assert.ok(!plan(graph, { project_cwds: HARLOW }).nodes.some(n => n.kind === "fact"), "a Northwind lesson was drawn in Harlow's graph");
  const near = plan(graph, { around: "Sam Okafor" });
  const labels = near.nodes.filter(n => n.kind !== "thread").map(n => n.label).sort();
  assert.ok(labels.includes("Sam Okafor") && labels.includes("Northwind Bakery"), labels.join(", "));
  assert.ok(!labels.includes("Harlow Legal"), "depth 1 around Sam reached Harlow");
});

test("graph: capped, and the updated cursor moves only when the drawing would", async t => {
  const { curator, graph } = await world(t);
  const small = plan(graph, { limit: 10 });
  assert.ok(small.nodes.length <= 10);
  assert.equal(small.truncated, true);
  const u = small.updated;
  assert.ok(u > 0);
  assert.deepEqual(plan(graph, { since: u }), { updated: u, unchanged: true });
  await curator.curate({ force: true });
  assert.equal(curator.updated(), u, "a pass that changed nothing moved the cursor");
  graph.steer({ node: "Sam Okafor", mode: "pin" });
  const after = plan(graph, { since: u });
  assert.equal(after.updated, u + 1);
  assert.equal(byLabel(after, "Sam Okafor")?.pinned, true);
  // Fast on the corpus; the real-index number is in the changelog.
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) plan(graph);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 / 20 < 50);
});

test("graph: the main graph is only for the user and the assistant; an agent sees only its projects", async t => {
  const root = fs.realpathSync(tempHome(t));
  const work = path.join(root, "Work");
  // The corpus, moved under the temp home so real projects can own its folders.
  const moved = [...SESSIONS, CROSSOVER].map(s => ({ ...s, cwd: s.cwd.replace(W, work) }));
  const db = open(path.join(root, "vyre.db")); seedRecall(db, moved); db.close();
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const opts = { root };
  assert.ok(!(await call("projects.create", { name: "Northwind", home: path.join(work, "northwind") }, opts)).error);
  assert.ok(!(await call("projects.create", { name: "Harlow", home: path.join(work, "harlow-site"), workspaces: [path.join(work, "harlow-intake")] }, opts)).error);
  // The real agents module: the assistant, and an agent with one project.
  assert.ok(!(await call("agents.create", { name: "juno", kind: "assistant" }, opts)).error);
  assert.ok(!(await call("agents.create", { name: "kit", projects: ["northwind"] }, opts)).error);
  await call("memory.curate", {}, opts);

  const main = (await call("memory.graph", {}, opts)).data;
  assert.equal(main.scope, "main");
  assert.ok(main.rooms.some(r => r.id === "project:northwind") && main.rooms.some(r => r.id === "project:harlow"), JSON.stringify(main.rooms));
  assert.equal(main.nodes.find(n => n.label === "Dana Reyes")?.room, "shared");
  assert.equal((await call("memory.graph", { agent: "juno" }, opts)).data.scope, "main", "the assistant sees the main graph");

  const denied = await call("memory.graph", { agent: "kit" }, opts);
  assert.match(denied.error?.message || "", /main graph is for the assistant/);
  const own = await call("memory.graph", { agent: "kit", project_cwds: [path.join(work, "northwind")] }, opts);
  assert.equal(own.data?.scope, "project");
  assert.equal(own.data.rooms[0].label, "Northwind");
  assert.match((await call("memory.graph", { agent: "kit", project_cwds: [path.join(work, "harlow-site")] }, opts)).error?.message || "", /not granted/);
  assert.match((await call("memory.facts", { agent: "kit" }, opts)).error?.message || "", /main graph/);
  assert.match((await call("memory.graph", { agent: "nobody" }, opts)).error?.message || "", /no agent nobody/);
  // Everything that reads or steers the whole graph is guarded the same way.
  for (const [tool, input] of [["memory.stats", {}], ["memory.curate", {}], ["memory.pin", { node: "Dana Reyes" }], ["memory.relevant", { text: "Dana Reyes" }], ["memory.why", { fact: "Dana Reyes" }]]) {
    assert.match((await call(tool, { ...input, agent: "kit" }, opts)).error?.message || "", /main graph/, `${tool} let kit read or steer the main graph`);
  }
  assert.equal((await call("memory.pin", { node: "Sam Okafor", scope: path.join(work, "northwind"), agent: "kit" }, opts)).data?.mode, "pin");
  assert.match((await call("memory.mute", { node: "Harlow Legal", scope: path.join(work, "northwind"), agent: "kit" }, opts)).error?.message || "", /nothing in memory/);
  // The agent can also be named by the caller; the two must agree. Over HTTP vyred takes that
  // name only with the key of the agent's live thread, so Memory's part is checked in-process.
  assert.match((await call("memory.graph", {}, { ...opts, caller: "mcp:agent:kit" })).error?.message || "", /no thread of that agent/);
  for (const caller of ["mcp agent:kit", "mcp:agent:kit"]) {
    assert.match((await d.registry.call("memory.graph", {}, caller)).error?.message || "", /main graph is for the assistant/, caller);
    assert.match((await d.registry.call("memory.graph", { agent: "juno" }, caller)).error?.message || "", /came from agent kit/, caller);
  }
  // A session that has not said who it is gets a project's graph, not the main one.
  assert.match((await call("memory.graph", {}, { ...opts, caller: "mcp" })).error?.message || "", /drawn for the Deck/);
  assert.equal((await call("memory.graph", { project_cwds: [path.join(work, "northwind")] }, { ...opts, caller: "mcp" })).data?.scope, "project");
  assert.equal((await call("memory.graph", {}, { ...opts, caller: "deck" })).data?.scope, "main");
});

test("graph: a named agent is refused when agents cannot be checked", async t => {
  const root = tempHome(t);
  // Agents is a core module now; switch it off to see Memory refuse rather than trust.
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ modules: { enable: [], disable: ["agents"] } }));
  const db = open(path.join(root, "vyre.db")); seedRecall(db); db.close();
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  await call("memory.curate", {}, { root });
  const r = await call("memory.graph", { agent: "kit", project_cwds: NORTHWIND }, { root });
  assert.match(r.error?.message || "", /cannot be checked/);
  assert.ok((await call("memory.graph", {}, { root })).data.nodes.length > 0, "the user still gets the main graph");
});
