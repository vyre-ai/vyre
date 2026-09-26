// @ts-check
// Facts other modules teach through ctx.memory.teach: checked, folded into the same graph as the
// transcripts, sourced to {module, kind}, idempotent, and reachable only from modules.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open } from "../store/index.js";
import { start } from "../daemon/index.js";
import { call, request } from "../daemon/client.js";
import { SESSIONS, HOME, seedRecall } from "../../test/fixtures/corpus.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { Curator } from "./curator.js";
import { Graph } from "./graph.js";
import { lesson } from "./teach.js";

function world(t, { recall = true } = {}) {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  if (recall) seedRecall(db, SESSIONS);
  const curator = new Curator(db, { me: { domains: ["riverastudio.com"] } });
  return { db, curator, graph: new Graph(db, curator) };
}
const dump = db => ["memory_nodes", "memory_edges", "memory_evidence", "memory_lessons", "memory_shortforms", "memory_taught"]
  .map(t => db.prepare(`SELECT * FROM ${t}`).all().map(r => JSON.stringify({ ...r, observed: undefined, at: undefined })).sort());

test("teach: a fact is checked, and the same fact is the same lesson", () => {
  const a = lesson({ subject: "Priya Shah", rel: "works_at", object: "Harlow Legal" });
  assert.equal(a.key, lesson({ object: "Harlow Legal", rel: "works_at", subject: "Priya Shah" }).key, "key order must not matter");
  assert.deepEqual(a.claims, [{ src: { id: "name:Priya Shah", kind: "person" }, rel: "works_at", dst: { id: "name:Harlow Legal", kind: "org" } }]);
  const p = lesson({ subject: { name: "Priya Shah", email: "Priya@HarlowLegal.com" } });
  assert.deepEqual(p.claims.map(c => [c.src.id, c.rel, c.dst?.id ?? null]), [["name:Priya Shah", null, null], ["name:Priya Shah", "has_email", "email:priya@harlowlegal.com"]]);
  assert.equal(lesson({ subject: "harlowlegal.com" }).claims[0].src.id, "domain:harlowlegal.com");
  assert.equal(lesson({ subject: { repo: "rivera-studio/harlow-site" } }).claims[0].src.id, "repo:rivera-studio/harlow-site");
  for (const bad of [null, [], {}, { subject: 7 }, { subject: "A", rel: "Works At", object: "B" }, { subject: "A", object: "B" }, { subject: { email: "nope" } }]) {
    assert.throws(() => lesson(bad), undefined, JSON.stringify(bad));
  }
});

test("teach: a taught fact joins the graph, sourced to the module that taught it", async t => {
  const { curator, graph } = world(t);
  await curator.curate();
  assert.equal(curator.teach("projects", "project.person", { subject: { name: "Priya Shah", email: "priya@harlowlegal.com" }, rel: "works_at", object: "Harlow Legal" }).changed, true);
  await curator.curate();
  const facts = graph.facts({ about: "Priya Shah" }).facts;
  const works = facts.find(f => f.rel === "works_at");
  assert.equal(works?.text, "Priya Shah works at Harlow Legal");
  assert.equal(works?.source, "taught by projects");
  assert.deepEqual(works?.taught, [{ module: "projects", kind: "project.person" }]);
  assert.ok(works?.age, "a taught fact has an age: when it was taught");
  assert.ok(facts.some(f => f.text === "Priya Shah's email is priya@harlowlegal.com"));
  const why = graph.why({ fact: works.id });
  assert.deepEqual(why.turns, []);
  assert.equal(why.gone, 0);
  assert.deepEqual(why.taught.map(l => [l.module, l.kind]), [["projects", "project.person"]]);
  // It lands on the node the transcripts already built, not a copy of it.
  assert.ok(graph.facts({ about: "Harlow Legal" }).facts.some(f => f.text === "Priya Shah works at Harlow Legal"));
  assert.ok(graph.relevant({ text: "loop in Priya Shah" }).some(f => f.text === "Priya Shah works at Harlow Legal"));
});

test("teach: a lesson that agrees with the transcripts adds provenance and keeps the turn as source", async t => {
  const { db, curator, graph } = world(t);
  await curator.curate();
  const before = graph.facts({ about: "Dana Reyes" }).facts.find(f => f.rel === "works_at");
  curator.teach("projects", "project.person", { subject: "Dana Reyes", rel: "works_at", object: "Harlow Legal" });
  await curator.curate();
  const after = graph.facts({ about: "Dana Reyes" }).facts.find(f => f.rel === "works_at");
  assert.equal(after?.id, before?.id);
  assert.equal(after?.source, before?.source, "a turn beats a lesson as the source a person reads");
  const why = graph.why({ fact: after.id });
  assert.ok(why.turns.length > 0 && why.taught.length === 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM memory_edges WHERE src = 'name:Dana Reyes' AND rel = 'works_at'").get()?.n, 1);
  // Derived edges do not borrow a lesson when turns already support them.
  const domain = graph.why({ fact: "name:Harlow Legal|has_domain|domain:harlowlegal.com" });
  assert.deepEqual(domain.taught, []);
});

test("teach: teaching twice changes nothing; forget takes it back out", async t => {
  const { db, curator, graph } = world(t);
  await curator.curate();
  const fact = { subject: "Priya Shah", rel: "works_at", object: "Harlow Legal", text: "from the project file" };
  curator.teach("projects", "project.person", fact);
  await curator.curate();
  const a = dump(db);
  assert.deepEqual(curator.teach("projects", "project.person", { ...fact }), { key: lesson(fact).key, changed: false });
  assert.equal((await curator.curate({ force: true })).changed, 0);
  assert.equal(await curator.derive(), 0);
  assert.deepEqual(dump(db), a);
  // Replacing under an explicit key moves the fact rather than adding a second one.
  curator.teach("projects", "project.person", { key: "p1", subject: "Priya Shah", rel: "works_at", object: "Northwind Bakery" });
  curator.teach("projects", "project.person", { key: "p1", subject: "Priya Shah", rel: "works_at", object: "Harlow Legal" });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM memory_taught WHERE key = 'p1'").get()?.n, 1);
  assert.equal(curator.teach("projects", "project.person", { ...fact, forget: true }).changed, true);
  assert.equal(curator.teach("projects", "project.person", { key: "p1", forget: true }).changed, true);
  await curator.curate();
  assert.equal(graph.facts({ about: "Priya Shah" }).about, null, "a forgotten lesson left its node behind");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM memory_lessons").get()?.n, 0);
});

test("teach: a note about a thing reads as its own fact and is relevant when the thing is named", async t => {
  const { curator, graph } = world(t);
  await curator.curate();
  curator.teach("watchers", "watcher.item", { subject: "Northwind Bakery", text: "the invoice inbox had 4 new invoices" });
  await curator.curate();
  const r = graph.relevant({ text: "what's new with Northwind Bakery?" });
  const note = r.find(f => f.text === "Northwind Bakery: the invoice inbox had 4 new invoices");
  assert.ok(note, r.map(f => f.text).join("\n"));
  assert.equal(note.source, "taught by watchers");
});

test("teach: a fact taught for a project shows in that project's facts and in no other's", async t => {
  const { curator, graph } = world(t);
  await curator.curate();
  const northwind = `${HOME}/Work/northwind`, harlow = [`${HOME}/Work/harlow-site`, `${HOME}/Work/harlow-intake`];
  // A watcher filing into the Northwind project, from a subfolder of it.
  curator.teach("watchers", "watcher.item", { subject: "Tomas Berg", text: "approved invoice 1042", project_cwds: [`${northwind}/billing/`] });
  // About someone the Harlow sessions name, but taught for Northwind only.
  curator.teach("watchers", "watcher.item", { subject: "Dana Reyes", text: "was copied on the Northwind invoice run", project_cwds: [northwind] });
  // For everywhere.
  curator.teach("watchers", "watcher.item", { subject: "Dana Reyes", text: "prefers email before calls" });
  await curator.curate();
  const texts = cwds => graph.facts({ project_cwds: cwds }).facts.map(f => f.text);
  const nw = texts([northwind]);
  assert.ok(nw.includes("Tomas Berg: approved invoice 1042"), "a subfolder of the project should count: " + nw.join("\n"));
  assert.ok(nw.includes("Dana Reyes: was copied on the Northwind invoice run"), nw.join("\n"));
  assert.ok(nw.includes("Sam Okafor works at Northwind Bakery"), "the project's own facts must still be there");
  const hl = texts(harlow);
  assert.ok(!hl.some(x => x.includes("Tomas Berg") || x.includes("Northwind invoice run")), "another project's lesson leaked: " + hl.join("\n"));
  assert.ok(hl.includes("Dana Reyes: prefers email before calls"), "an unscoped lesson belongs everywhere Dana does");
  assert.ok(hl.includes("Dana Reyes works at Harlow Legal"));
  // The same rule in relevant: scoped by the project the prompt comes from, everything without one.
  const rel = cwds => graph.relevant({ text: "check with Dana Reyes", project_cwds: cwds, limit: 20 }).map(f => f.text);
  assert.ok(!rel(harlow).includes("Dana Reyes: was copied on the Northwind invoice run"));
  assert.ok(rel([northwind]).includes("Dana Reyes: was copied on the Northwind invoice run"));
  assert.ok(rel([]).includes("Dana Reyes: was copied on the Northwind invoice run"));
  // A fact taught without folders keeps the stored form, and key, it had before scoping existed.
  assert.ok(!("project_cwds" in JSON.parse(lesson({ subject: "Dana Reyes" }).stored)));
  assert.throws(() => lesson({ subject: "A B", project_cwds: "nope" }), /project_cwds/);
});

test("teach: taught facts make a graph even with no Recall index", async t => {
  const { curator, graph } = world(t, { recall: false });
  curator.teach("projects", "project.person", { subject: { name: "Priya Shah", email: "priya@harlowlegal.com" }, rel: "works_at", object: "Harlow Legal" });
  const r = await curator.curate();
  assert.equal(r.recall, false);
  assert.ok(r.nodes > 0);
  assert.ok(graph.relevant({ text: "Priya Shah" }).some(f => f.text === "Priya Shah works at Harlow Legal"));
});

test("teach: through ctx.memory.teach in a real vyred, and never from outside a module", async t => {
  const root = tempHome(t);
  const db = open(path.join(root, "vyre.db")); seedRecall(db); db.close();
  writeModule(path.join(root, "modules"), "people", { requires: ["memory"], does: { tools: ["people.add"] }, teaches: { memory: ["people.person"] } },
    `export default { async start(ctx) {
      ctx.tool("people.add", { input: { type: "object", properties: { name: { type: "string" } } },
        run: async ({ name }) => ({ taught: await ctx.memory.teach("people.person", { subject: name, rel: "works_at", object: "Northwind Bakery" }) }) });
      return {};
    } };`);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  assert.deepEqual((await call("people.add", { name: "Tomas Berg" }, { root })).data, { taught: true });
  await call("memory.curate", {}, { root });
  const f = (await call("memory.facts", { about: "Tomas Berg" }, { root })).data.facts.find(x => x.rel === "works_at");
  assert.equal(f?.source, "taught by people");
  const why = (await call("memory.why", { fact: f.id }, { root })).data;
  assert.deepEqual(why.taught.map(l => [l.module, l.kind]), [["people", "people.person"]]);
  // Not a tool Claude, the CLI or a surface can see or call.
  assert.equal((await call("memory.teach", { kind: "x", fact: { subject: "A" }, from: "people" }, { root })).error.code, "no_such_tool");
  assert.ok(!(await request("GET", "/v1/tools", undefined, { root })).data.some(x => x.name === "memory.teach"));
  // A module cannot teach in another module's name.
  const spoof = await d.registry.call("memory.teach", { kind: "people.person", fact: { subject: "A" }, from: "people" }, "module:other");
  assert.match(spoof.error.message, /arrived as module:other/);
  assert.ok(fs.existsSync(d.paths.db));
});
