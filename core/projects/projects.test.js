// @ts-check
// Projects against the shared fictional corpus. The corpus lives under /home/alex, which no test
// machine has, so each test moves it into its own temp folder: project homes have to be real
// folders for their markers to be written.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { SESSIONS, HOME, seedRecall } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";
import { Projects, MIGRATIONS } from "./projects.js";
import * as M from "./markers.js";
import { compose, LIMIT } from "./brief.js";

const ID = { site: SESSIONS[0].id, intake: SESSIONS[1].id, northwind: SESSIONS[2].id, hub: SESSIONS[3].id, agent: SESSIONS[4].id, headless: SESSIONS[5].id };

/** A temp world: the corpus seeded with its folders moved under a temp root, and a Projects over it. */
function world(t, { call, sessions = SESSIONS } = {}) {
  // Real paths, as Claude Code records them: on macOS the temp folder is a symlink.
  const root = fs.realpathSync(tempHome(t));
  const home = path.join(root, "alex");
  const moved = sessions.map(s => ({ ...s, cwd: s.cwd.replace(HOME, home) }));
  for (const s of moved) fs.mkdirSync(s.cwd, { recursive: true });
  const db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, moved);
  migrate(db, "projects", MIGRATIONS);
  const events = [];
  const config = { projectsDir: path.join(root, "projects"), roots: [path.join(home, "Work")] };
  const P = new Projects({ db, config, call, emit: (type, payload) => events.push({ type, ...payload }) });
  return { root, home, work: path.join(home, "Work"), db, P, events, config };
}

/** A fake Recall: full-text over the seeded turns, as recall.search would answer. */
const fakeRecall = db => async (tool, input) => {
  if (tool !== "recall.search") return { error: { code: "no_such_tool", message: "no tool " + tool } };
  const expr = input.q.split(/\s+/).map(w => `"${w}"`).join(" AND ");
  return { data: db.prepare("SELECT session, seq FROM recall_turns WHERE recall_turns MATCH ? LIMIT ?").all(expr, input.limit) };
};

test("projects: Harlow Legal gets its folder's thread and the picks; the hub is in Northwind too", async t => {
  const w = world(t);
  const harlow = w.P.create({ name: "Harlow Legal", org: "Rivera Studio", home: path.join(w.work, "harlow-site"),
    threads: [ID.intake, ID.hub], people: [{ name: "Dana Reyes", email: "dana@harlowlegal.com" }] });
  assert.equal(harlow.slug, "harlow-legal");
  const north = w.P.create({ name: "Northwind", home: path.join(w.work, "northwind"), threads: [ID.hub] });

  const ids = p => w.P.threadsOf(w.P.resolve(p)).map(x => x.id);
  assert.deepEqual(new Set(ids("harlow-legal")), new Set([ID.site, ID.intake, ID.hub]));
  assert.deepEqual(new Set(ids(north.slug)), new Set([ID.northwind, ID.headless, ID.hub]));
  const hub = w.P.threadsOf(harlow).find(x => x.id === ID.hub);
  assert.deepEqual(hub.how, ["picked"]);
  const site = w.P.threadsOf(harlow).find(x => x.id === ID.site);
  assert.deepEqual(site.how, ["folder"]);
  // The subagent folds under its parent rather than appearing as a thread of its own.
  assert.equal(site.agents, 1);
  assert.ok(!ids("harlow-legal").some(id => id.includes("/agent-")));
  // The marker is the record.
  assert.deepEqual(M.load(harlow.home).threads, [ID.intake, ID.hub]);
  assert.deepEqual(w.events.map(e => e.type), ["project.created", "thread.picked", "thread.picked", "project.created", "thread.picked"]);
});

test("projects: the Harlow brief names Dana and never mentions Northwind", async t => {
  const w = world(t);
  w.P.create({ name: "Harlow Legal", home: path.join(w.work, "harlow-site"), threads: [ID.intake, ID.hub],
    people: [{ name: "Dana Reyes", email: "dana@harlowlegal.com" }] });
  w.P.create({ name: "Northwind", home: path.join(w.work, "northwind"), threads: [ID.hub], people: [{ name: "Sam Okafor" }] });
  const { text, project } = await w.P.context({ project: "Harlow Legal" });
  assert.equal(project, "harlow-legal");
  assert.match(text, /"Harlow Legal"/);
  assert.match(text, /Dana Reyes <dana@harlowlegal\.com>/);
  assert.match(text, /Harlow site rebuild/);
  assert.match(text, /Weekly planning/);
  assert.doesNotMatch(text, /northwind|Sam Okafor/i);
  assert.ok(text.length <= LIMIT);
});

test("projects: memory facts are asked for the project's own folders only, and missing Memory is quiet", async t => {
  const asked = [];
  const w = world(t, { call: async (tool, input) => {
    asked.push({ tool, input });
    return tool === "memory.facts" ? { data: [{ text: "Dana Reyes works at Harlow Legal", confidence: 0.9 }] } : { error: { code: "no_such_tool", message: "" } };
  } });
  const p = w.P.create({ name: "Harlow Legal", home: path.join(w.work, "harlow-site"), threads: [ID.hub] });
  const { text } = await w.P.context({ project: p.slug });
  assert.match(text, /From this project's memory[\s\S]*Dana Reyes works at Harlow Legal \(90%\)/);
  assert.deepEqual(asked[0].input.project_cwds, [p.home], "a picked hub's folder would pull other projects' facts in");

  const w2 = world(t);
  const p2 = w2.P.create({ name: "Harlow Legal", home: path.join(w2.work, "harlow-site") });
  assert.doesNotMatch((await w2.P.context({ project: p2.slug })).text, /memory/);
});

test("projects: context finds the project from the folder, else the one pick; several picks get no guess", async t => {
  const w = world(t);
  w.P.create({ name: "Harlow Legal", home: path.join(w.work, "harlow-site"), threads: [ID.hub] });
  const inside = await w.P.context({ cwd: path.join(w.work, "harlow-site", "src"), session: ID.site });
  assert.equal(inside.project, "harlow-legal");
  assert.doesNotMatch(inside.text, /Harlow site rebuild/, "the brief listed the thread it was starting in");
  assert.equal((await w.P.context({ cwd: w.work, session: ID.hub })).project, "harlow-legal");
  w.P.create({ name: "Northwind", home: path.join(w.work, "northwind"), threads: [ID.hub] });
  const both = await w.P.context({ cwd: w.work, session: ID.hub });
  assert.equal(both.project, null);
  assert.equal(both.text, "");
  assert.deepEqual(both.candidates.sort(), ["harlow-legal", "northwind"]);
  assert.equal((await w.P.context({ cwd: "/nowhere" })).text, "");
});

test("projects: the catalogue searches what was said through Recall, and says when it cannot", async t => {
  const w = world(t);
  w.P.call = fakeRecall(w.db);
  w.P.create({ name: "Harlow Legal", home: path.join(w.work, "harlow-site") });
  const all = await w.P.catalog();
  assert.equal(all.total, 5, "five top-level sessions; the subagent folds into its parent");
  assert.equal(all.sessions[0].id, ID.headless, "newest first");
  assert.deepEqual(all.sessions.find(s => s.id === ID.site).projects, ["harlow-legal"]);
  assert.equal((await w.P.catalog({ human: true })).total, 4);

  // The hub is named "Weekly planning" and only mentions Dana in what it said.
  const dana = await w.P.catalog({ q: "dana" });
  assert.equal(dana.search, "said");
  const hub = dana.sessions.find(s => s.id === ID.hub);
  assert.ok(hub && !hub.titled && hub.said > 0, "the hub was hidden because its title does not say Dana");
  // Words from a subagent count for its parent.
  const focus = await w.P.catalog({ q: "focus ring" });
  assert.deepEqual(focus.sessions.map(s => s.id), [ID.site]);

  w.P.call = async () => ({ error: { code: "no_such_tool", message: "no tool recall.search" } });
  const titles = await w.P.catalog({ q: "harlow" });
  assert.equal(titles.search, "titles");
  assert.match(titles.note, /Recall is not running/);
  // The hub's first message names Harlow Legal, so a title search finds it too.
  assert.deepEqual(titles.sessions.map(s => s.id).sort(), [ID.site, ID.intake, ID.hub].sort());
  assert.ok(titles.sessions.every(s => s.titled && s.said === 0));
});

test("projects: picks are added once, removed only by hand, and folder membership is reported, not hidden", async t => {
  const w = world(t);
  const p = w.P.create({ name: "Harlow Legal", home: path.join(w.work, "harlow-site") });
  w.events.length = 0;
  assert.deepEqual(w.P.addThreads(p.slug, [ID.hub, ID.hub]).added, [ID.hub]);
  assert.deepEqual(w.P.addThreads(p.slug, [ID.hub]).added, []);
  // Picking a subagent picks its parent.
  assert.deepEqual(w.P.addThreads(p.slug, [ID.agent]).added, [ID.site]);
  assert.deepEqual(w.events.filter(e => e.type === "thread.picked").map(e => e.thread), [ID.hub, ID.site]);
  // A rebuild of the cache keeps every pick: the marker holds them.
  w.db.exec("DELETE FROM projects_projects");
  w.P.refresh({ walk: true });
  assert.deepEqual(w.P.resolve(p.slug).threads, [ID.hub, ID.site]);
  const r = w.P.removeThreads(p.slug, [ID.hub, ID.site]);
  assert.deepEqual(r.removed, [ID.hub, ID.site]);
  assert.deepEqual(r.stillByFolder, [ID.site]);
  assert.ok(w.P.threadsOf(w.P.resolve(p.slug)).some(x => x.id === ID.site));
  assert.ok(!w.P.threadsOf(w.P.resolve(p.slug)).some(x => x.id === ID.hub));
});

test("projects: list carries each project's picked thread ids, subagents folded, counts unchanged", async t => {
  const w = world(t);
  const harlow = w.P.create({ name: "Harlow Legal", home: path.join(w.work, "harlow-site"), threads: [ID.intake, ID.hub, ID.agent] });
  w.P.create({ name: "Northwind", home: path.join(w.work, "northwind"), threads: [ID.hub] });
  w.P.create({ name: "Keel", home: path.join(w.work, "keel") });
  // A hand-edited marker that names a subagent still lists its parent, once.
  M.write(harlow.home, { threads: [ID.intake, ID.hub, ID.site, ID.agent] });
  const rows = new Map(w.P.list().projects.map(p => [p.slug, p]));
  assert.deepEqual(rows.get("harlow-legal").picks, [ID.intake, ID.hub, ID.site]);
  assert.deepEqual(rows.get("northwind").picks, [ID.hub]);
  assert.deepEqual(rows.get("keel").picks, []);
  // threads and picked are still counts, as the CLI and the Deck read them.
  assert.equal(typeof rows.get("harlow-legal").threads, "number");
  assert.equal(rows.get("harlow-legal").picked, 3);
  assert.equal(rows.get("harlow-legal").threads, 3);
});

test("projects: a marker edited by hand is followed; a folder added to it brings its sessions", async t => {
  const w = world(t);
  const p = w.P.create({ name: "Harlow Legal", home: path.join(w.work, "harlow-site") });
  assert.ok(!w.P.threadsOf(p).some(x => x.id === ID.intake));
  M.write(p.home, { workspaces: ["../harlow-intake"], people: [{ name: "Dana Reyes" }] });
  w.P.refresh();
  const again = w.P.resolve("harlow-legal");
  assert.ok(w.P.threadsOf(again).some(x => x.id === ID.intake && x.how.includes("folder")));
  assert.equal(again.people[0].name, "Dana Reyes");
  assert.equal(M.load(p.home).name, "Harlow Legal", "a write dropped a field it did not name");
});

test("projects: a project outside the roots is remembered; one under them is discovered; a removed marker ends it", async t => {
  const w = world(t);
  const away = path.join(w.root, "elsewhere", "harlow");
  w.P.create({ name: "Harlow Legal", home: away });
  M.write(path.join(w.work, "northwind"), { name: "Northwind" });
  const names = () => w.P.list().projects.map(p => p.name).sort();
  assert.deepEqual(names(), ["Harlow Legal", "Northwind"]);
  fs.rmSync(path.join(away, M.MARKER));
  assert.deepEqual(names(), ["Northwind"]);
});

test("projects: create refuses a second project with the same name, or a folder that is already a home", async t => {
  const w = world(t);
  w.P.create({ name: "Harlow Legal", home: path.join(w.work, "harlow-site") });
  assert.throws(() => w.P.create({ name: "harlow legal", home: path.join(w.root, "x") }), /already exists/);
  assert.throws(() => w.P.create({ name: "Other", home: path.join(w.work, "harlow-site") }), /already a project home/);
  assert.throws(() => w.P.create({ name: "  " }), /needs a name/);
  const d = w.P.create({ name: "Rivera Studio" });
  assert.equal(d.home, fs.realpathSync(path.join(w.config.projectsDir, "rivera-studio")));
});

test("projects: two markers claiming one slug are refused, not merged", async t => {
  const w = world(t);
  M.write(path.join(w.work, "harlow-site"), { name: "Harlow" });
  M.write(path.join(w.work, "harlow-intake"), { name: "Harlow" });
  const { projects, problems } = w.P.list();
  assert.equal(projects.length, 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0].error, /also used by/);
});

test("projects: with no Recall index yet, the catalogue is empty and says why", async t => {
  const root = tempHome(t);
  const db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  migrate(db, "projects", MIGRATIONS);
  const P = new Projects({ db, config: { projectsDir: path.join(root, "p"), roots: [] } });
  const c = await P.catalog({ q: "anything" });
  assert.equal(c.total, 0);
  const p = P.create({ name: "Harlow Legal", threads: [ID.hub] });
  assert.equal(P.threadsOf(p)[0].missing, true, "a pick the index has not seen was dropped");
});

test("markers: projectOf matches on a path boundary and prefers the deepest folder", () => {
  const outer = /** @type {any} */ ({ slug: "outer", workspaces: ["/w/x"] });
  const inner = /** @type {any} */ ({ slug: "inner", workspaces: ["/w/x/y"] });
  assert.equal(M.projectOf("/w/x/y/z", [outer, inner])?.slug, "inner");
  assert.equal(M.projectOf("/w/x-old", [outer, inner]), null);
  assert.equal(M.slugify("Harlow & Co."), "harlow-and-co");
});

test("brief: says the user's words win, trims long labels, and never passes its limit", () => {
  const project = /** @type {any} */ ({ name: "Harlow Legal", org: null, home: "/w/h", workspaces: ["/w/h"], threads: [], people: [], watchers: ["harlow-invoices"] });
  assert.match(compose({ project }), /take priority over it/);
  assert.match(compose({ project }), /Watchers: harlow-invoices/);
  const long = compose({ project, threads: [{ title: "x ".repeat(300), last: Date.now() }] });
  assert.ok(long.split("\n").find(l => l.startsWith("- x")).length < 110, "a whole first message went into the brief");
  const threads = Array.from({ length: 50 }, (_, i) => ({ name: "thread number " + i, last: Date.now() }));
  const facts = Array.from({ length: 50 }, (_, i) => ({ text: "a fairly long fact about the project, number ".repeat(4) + i }));
  const people = Array.from({ length: 80 }, (_, i) => ({ name: "Person " + i, email: `p${i}@example.com` }));
  const text = compose({ project: { ...project, people }, threads, facts });
  assert.ok(text.length <= LIMIT, `brief was ${text.length} chars`);
  assert.match(text, /…$/);
});

test("markers: a home reached through a symlink matches the folder as a shell reports it", t => {
  const root = tempHome(t);
  const realHome = path.join(root, "real", "harlow-site");
  fs.mkdirSync(path.join(realHome, "src"), { recursive: true });
  fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));
  const p = M.write(path.join(root, "link", "harlow-site"), { name: "Harlow Legal" });
  assert.equal(M.projectOf(fs.realpathSync(path.join(realHome, "src")), [p])?.slug, "harlow-legal");
  assert.equal(M.projectOf(path.join(root, "link", "harlow-site", "src"), [p])?.slug, "harlow-legal");
});

test("tools: projects.of answers the Harness's shape for a subfolder, and null outside", async t => {
  const { start } = await import("../daemon/index.js");
  const root = tempHome(t);
  const work = path.join(root, "Work");
  const home = path.join(work, "harlow-site"), intake = path.join(work, "harlow-intake");
  for (const d of [home, intake]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ projectsDir: path.join(root, "projects"), roots: [work],
    transcripts: [], modules: { disable: ["recall", "memory"] } }));
  const d = await start({ root, log: () => {} });
  try {
    const made = await d.registry.call("projects.create", { name: "Harlow Legal", home, workspaces: [intake] });
    assert.ok(made.data, JSON.stringify(made.error));
    const of = await d.registry.call("projects.of", { cwd: path.join(home, "src", "deep") });
    assert.equal(of.data.slug, "harlow-legal");
    assert.equal(of.data.name, "Harlow Legal");
    assert.deepEqual(of.data.folders, [fs.realpathSync(home), fs.realpathSync(intake)]);
    assert.equal((await d.registry.call("projects.of", { cwd: root })).data, null);
    const ctx = await d.registry.call("projects.context", { project: of.data.slug });
    assert.match(ctx.data.text, /"Harlow Legal"/);
  } finally { await d.stop(); }
});

test("projects: a catalogue search costs one Recall call and no per-session path lookups, however big the index", async t => {
  // 2,000 sessions in folders that no longer exist, as on a real machine after a year of work.
  const many = Array.from({ length: 2000 }, (_, i) => ({
    id: `22222222-bbbb-4000-8000-${String(i).padStart(12, "0")}`, cwd: `${HOME}/Old/gone-${i % 400}/deep/er`,
    name: i % 7 ? undefined : `Weekly review ${i}`, start: Date.parse("2026-08-01T00:00:00Z") + i * 60_000,
    turns: [{ role: /** @type {const} */ ("user"), text: `weekly review number ${i}` }],
  }));
  const w = world(t, { sessions: [...SESSIONS, ...many] });
  const calls = [];
  const recallCall = fakeRecall(w.db);
  w.P.call = async (tool, input) => { calls.push(tool); return recallCall(tool, input); };
  w.P.create({ name: "Harlow Legal", home: path.join(w.work, "harlow-site"), threads: [ID.hub] });
  w.P.create({ name: "Northwind", home: path.join(w.work, "northwind") });

  const realpath = fs.realpathSync;
  let lookups = 0;
  fs.realpathSync = /** @type {any} */ ((...a) => { lookups++; return realpath(...a); });
  t.after(() => { fs.realpathSync = realpath; });
  const t0 = performance.now();
  const r = await w.P.catalog({ q: "weekly review", limit: 50 });
  const ms = performance.now() - t0;
  fs.realpathSync = realpath;

  // Work-based guarantees (immune to scheduler jitter under concurrent load): the
  // catalogue must hit Recall exactly once and must not resolve session folders
  // one by one, no matter how big the index.
  assert.deepEqual(calls, ["recall.search"], "the catalogue called Recall more than once for one search");
  assert.ok(lookups < 20, `${lookups} realpath lookups for one search; session folders must not be resolved one by one`);
  assert.ok(r.total > 50 && r.sessions.length === 50);
  // Generous, catastrophic-regression-only bound (median on this machine is ~25ms
  // for 2,000 sessions; this is roughly 80x that, so it only trips on an actual
  // algorithmic regression, not on load from other test suites running concurrently).
  assert.ok(ms < 2000, `a catalogue search over 2,000 sessions took ${Math.round(ms)}ms`);
});
