// @ts-check
// The box moves project homes from ~/Vyre/projects into the work folder once, when the owner
// runs projects.move (./move.js, ./index.js).
// Every folder is under the test's temp home: VYRE_WORK_DIR and VYRE_OLD_PROJECTS_DIR point there.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";
import { Projects, MIGRATIONS } from "./projects.js";
import { moveProjects, RECORD } from "./move.js";
import * as M from "./markers.js";
import mod from "./index.js";
import * as config from "../config/index.js";
import { shareMap } from "../files/drive.js";

/** A box's world before the move: two project homes and one plain folder in the old folder. */
function world(t) {
  const root = fs.realpathSync(tempHome(t));
  const old = path.join(root, "home", "Vyre", "projects");
  const work = path.join(root, "work");
  fs.mkdirSync(work, { recursive: true });
  const prev = { w: process.env.VYRE_WORK_DIR, o: process.env.VYRE_OLD_PROJECTS_DIR };
  process.env.VYRE_WORK_DIR = work;
  process.env.VYRE_OLD_PROJECTS_DIR = old;
  t.after(() => {
    if (prev.w === undefined) delete process.env.VYRE_WORK_DIR; else process.env.VYRE_WORK_DIR = prev.w;
    if (prev.o === undefined) delete process.env.VYRE_OLD_PROJECTS_DIR; else process.env.VYRE_OLD_PROJECTS_DIR = prev.o;
  });
  const db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  migrate(db, "projects", MIGRATIONS);
  // Made the way a box made them before: in the old projects folder.
  const before = new Projects({ db, config: { projectsDir: old, roots: [] } });
  const shared = path.join(root, "alex", "Work", "shared");
  fs.mkdirSync(path.join(old, "harlow-legal", "site"), { recursive: true });
  fs.mkdirSync(shared, { recursive: true });
  before.create({ name: "Harlow Legal", workspaces: [path.join(old, "harlow-legal", "site"), shared],
    people: [{ name: "Dana Reyes" }] });
  before.create({ name: "Northwind Bakery", workspaces: [path.join(old, "harlow-legal")] });
  fs.mkdirSync(path.join(old, "notes"));
  fs.writeFileSync(path.join(old, "notes", "todo.txt"), "call Northwind\n");
  return { root, old, work, to: path.join(work, "projects"), db, shared };
}

/** A context for the projects module, recording tools, events and log lines. */
function fakeCtx(w, role = "box") {
  const tools = new Map(), events = [], logs = [];
  const cfg = config.load(w.root);
  const ctx = {
    config: { ...cfg, role, roots: [] },
    store: { db: w.db, migrate: steps => migrate(w.db, "projects", steps) },
    paths: { root: w.root },
    log: m => logs.push(m),
    events: { emit: (type, payload) => events.push({ type, payload }), on: () => () => {} },
    tool: (name, def) => tools.set(name, def),
    call: async () => ({ error: { code: "no_such_tool", message: "none" } }),
  };
  return { ctx, tools, events, logs };
}

/** Every path under dir with what it is: a file's text, a link's target, or "dir". */
function snapshot(dir) {
  const out = {};
  const walk = d => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) out[p] = "-> " + fs.readlinkSync(p);
      else if (e.isDirectory()) { out[p] = "dir"; walk(p); }
      else if (!p.endsWith("vyre.db") && !/vyre\.db-/.test(p)) out[p] = fs.readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}
const rowsOf = db => db.prepare("SELECT slug, home, spec FROM projects_projects ORDER BY slug").all().map(r => ({ ...r }));

/** Run fn with env vars set (undefined removes one), putting them back after. */
async function withEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test("move: start never moves; an existing box stays on ~/Vyre/projects until the record exists", async t => {
  const w = world(t);
  fs.writeFileSync(path.join(w.root, "config.json"), JSON.stringify({ role: "box" }));
  assert.equal(config.load(w.root).projectsDir, path.join(os.homedir(), "Vyre", "projects"), "an existing box with homes keeps the old default");
  const f = fakeCtx(w);
  await mod.start(f.ctx);
  assert.deepEqual(f.events, []);
  assert.ok(!fs.existsSync(path.join(w.root, RECORD)));
  assert.ok(!fs.lstatSync(path.join(w.old, "harlow-legal")).isSymbolicLink());
  fs.writeFileSync(path.join(w.root, RECORD), "{}\n");
  assert.equal(config.load(w.root).projectsDir, w.to, "after the move the box's default is the work folder");
});

test("move: a new box (no homes in the old folder) defaults to /work/projects", t => {
  const w = world(t);
  fs.rmSync(w.old, { recursive: true });
  fs.writeFileSync(path.join(w.root, "config.json"), JSON.stringify({ role: "box" }));
  assert.equal(config.load(w.root).projectsDir, w.to, "no old folder");
  fs.mkdirSync(w.old, { recursive: true });
  assert.equal(config.load(w.root).projectsDir, w.to, "an empty old folder");
  fs.writeFileSync(path.join(w.root, "config.json"), JSON.stringify({ role: "box", projectsDir: w.old }));
  assert.equal(config.load(w.root).projectsDir, w.old, "config.json wins");
  fs.writeFileSync(path.join(w.root, "config.json"), JSON.stringify({ role: "local" }));
  assert.equal(config.load(w.root).projectsDir, path.join(os.homedir(), "Vyre", "projects"), "a Mac never changes");
});

test("move: a dry run changes nothing and answers what the real run then does", async t => {
  const w = world(t);
  // A skip too, so the lists carry a why.
  fs.mkdirSync(path.join(w.to, "northwind-bakery"), { recursive: true });
  const disk = snapshot(w.root), rows = rowsOf(w.db);
  const logs = [], events = [];
  const dry = moveProjects({ db: w.db, from: w.old, to: w.to, root: w.root, dryRun: true, log: m => logs.push(m), emit: (...e) => events.push(e) });
  assert.ok(dry);
  assert.deepEqual(snapshot(w.root), disk, "the dry run touched the disk");
  assert.deepEqual(rowsOf(w.db), rows, "the dry run touched the db");
  assert.deepEqual([logs, events], [[], []], "the dry run said something");
  assert.deepEqual(dry.moved, ["harlow-legal"]);
  assert.deepEqual(dry.skipped, [{ slug: "northwind-bakery", why: `${path.join(w.to, "northwind-bakery")} already exists` }]);
  assert.ok(dry.rewrites && dry.rewrites.some(r => "row" in r && r.row === "harlow-legal"));

  const real = moveProjects({ db: w.db, from: w.old, to: w.to, root: w.root, now: () => dry.at });
  assert.deepEqual(real, dry, "the real run did something the dry run did not say");
  // And what the dry run listed is what the db and markers now hold.
  for (const r of dry.rewrites || []) {
    if ("row" in r) assert.deepEqual(rowsOf(w.db).find(x => x.slug === r.row), { slug: r.row, home: r.home, spec: r.spec });
    else assert.deepEqual(JSON.parse(fs.readFileSync(r.marker, "utf8")).workspaces, r.workspaces);
  }
  assert.ok(fs.existsSync(path.join(w.root, RECORD)));
});

test("move: projects.move is the owner's, on a box, off until enabled, and runs once", async t => {
  const w = world(t);
  fs.writeFileSync(path.join(w.root, "config.json"), JSON.stringify({ role: "box" }));
  const f = fakeCtx(w);
  await mod.start(f.ctx);
  const def = f.tools.get("projects.move");
  assert.deepEqual([...def.callers].sort(), ["capsule", "cli", "deck", "local"], "agents' MCP, models' harness, guests and modules are not listed");
  const run = (input, meta = { caller: "cli" }) => def.run(input, meta).then(data => ({ data }), e => ({ code: e.code, message: e.message }));

  for (const meta of [{ caller: "cli:agent:kit" }, { caller: "mcp:agent:juno" }, { caller: "cli", agent: "kit" }]) {
    assert.equal((await run({ dry: true }, meta)).code, "denied", `${JSON.stringify(meta)} was let in`);
  }
  const mac = fakeCtx(w, "local");
  await mod.start(mac.ctx);
  assert.equal((await mac.tools.get("projects.move").run({ dry: true }, { caller: "cli" }).catch(e => e)).code, "not_box");

  await withEnv({ VYRE_PROJECTS_MOVE: undefined }, async () => {
    const dry = await run({ dry: true });
    assert.equal(dry.data.dry, true);
    assert.deepEqual(dry.data.moved.sort(), ["harlow-legal", "northwind-bakery"]);
    assert.ok(!fs.existsSync(path.join(w.root, RECORD)));
    const off = await run({});
    assert.equal(off.code, "move_off");
    assert.match(off.message, /box-deploy validates it on a copy/);
    assert.ok(!fs.lstatSync(path.join(w.old, "harlow-legal")).isSymbolicLink(), "move_off moved something");
  });

  // No work folder: nowhere to move to.
  await withEnv({ VYRE_WORK_DIR: path.join(w.root, "no-work"), VYRE_PROJECTS_MOVE: "1" }, async () => {
    assert.equal((await run({ dry: true })).code, "no_work_folder");
  });

  // Enabled in config.json: the real move, once.
  f.ctx.config.projects = { move: "enabled" };
  const done = await run({ dry: false });
  assert.deepEqual(done.data.moved.sort(), ["harlow-legal", "northwind-bakery"]);
  assert.equal(done.data.restart, true);
  assert.equal(done.data.next, `Restart vyred: the projects folder is now ${w.to}`);
  const moved = f.events.filter(e => e.type === "projects.moved");
  assert.equal(moved.length, 1);
  const record = JSON.parse(fs.readFileSync(path.join(w.root, RECORD), "utf8"));
  assert.deepEqual(record.moved.sort(), ["harlow-legal", "northwind-bakery"]);
  assert.equal(record.from, w.old);
  assert.equal(record.to, w.to);
  assert.equal(config.load(w.root).projectsDir, w.to, "the next start uses the work folder");

  for (const slug of ["harlow-legal", "northwind-bakery"]) {
    const link = path.join(w.old, slug);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), `${slug} left no link`);
    assert.equal(fs.readlinkSync(link), path.join(w.to, slug));
    assert.ok(fs.existsSync(path.join(w.to, slug, M.MARKER)));
  }
  assert.ok(fs.lstatSync(path.join(w.old, "notes")).isDirectory(), "a plain folder stays");
  assert.ok(!fs.existsSync(path.join(w.to, "notes")));

  const rows = rowsOf(w.db);
  assert.deepEqual(rows.map(r => r.home), [path.join(w.to, "harlow-legal"), path.join(w.to, "northwind-bakery")]);
  for (const r of rows) assert.ok(!String(r.spec).includes(w.old), `${r.slug}'s spec still names the old folder`);
  const harlow = M.load(path.join(w.to, "harlow-legal"));
  assert.deepEqual(harlow && harlow.workspaces, [path.join(w.to, "harlow-legal"), path.join(w.to, "harlow-legal", "site"), w.shared]);
  const north = M.load(path.join(w.to, "northwind-bakery"));
  assert.deepEqual(north && north.workspaces, [path.join(w.to, "northwind-bakery"), path.join(w.to, "harlow-legal")],
    "a folder in another moved home follows it");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.to, "northwind-bakery", M.MARKER), "utf8")).workspaces, ["../harlow-legal"]);
  const list = await f.tools.get("projects.list").run({});
  assert.deepEqual(list.projects.map(p => p.home).sort(), [path.join(w.to, "harlow-legal"), path.join(w.to, "northwind-bakery")]);
  const of = await f.tools.get("projects.of").run({ cwd: path.join(w.old, "harlow-legal", "site") });
  assert.equal(of && of.slug, "harlow-legal", "a session in the old path belongs to the moved project, through the link");

  // Once: a second real move is refused, a dry run says it is done.
  assert.equal((await run({})).code, "already_moved");
  const again = await run({ dry: true });
  assert.equal(again.data.done, true);
  assert.equal(moveProjects({ db: w.db, from: w.old, to: w.to, root: w.root }), null);
});

test("move: a destination that exists is skipped and reported, never overwritten", t => {
  const w = world(t);
  fs.mkdirSync(path.join(w.to, "northwind-bakery"), { recursive: true });
  fs.writeFileSync(path.join(w.to, "northwind-bakery", "keep.txt"), "mine\n");
  const logs = [];
  const out = moveProjects({ db: w.db, from: w.old, to: w.to, root: w.root, log: m => logs.push(m) });
  assert.ok(out);
  assert.deepEqual(out.moved, ["harlow-legal"]);
  assert.deepEqual(out.skipped, [{ slug: "northwind-bakery", why: `${path.join(w.to, "northwind-bakery")} already exists` }]);
  assert.equal(fs.readFileSync(path.join(w.to, "northwind-bakery", "keep.txt"), "utf8"), "mine\n");
  assert.ok(!fs.existsSync(path.join(w.to, "northwind-bakery", M.MARKER)));
  assert.ok(fs.existsSync(path.join(w.old, "northwind-bakery", M.MARKER)), "the skipped home stays");
  assert.ok(logs.some(l => /not moving northwind-bakery: .*already exists/.test(l)));
  // The skipped project's row stays on its home; its folder in the moved home follows the move.
  const row = w.db.prepare("SELECT home, spec FROM projects_projects WHERE slug = 'northwind-bakery'").get();
  assert.equal(row && row.home, path.join(w.old, "northwind-bakery"));
  assert.deepEqual(M.load(path.join(w.old, "northwind-bakery"))?.workspaces, [path.join(w.old, "northwind-bakery"), path.join(w.to, "harlow-legal")]);
});

test("move: across filesystems (EXDEV) the home is copied with its times and links, then removed", t => {
  const w = world(t);
  const src = path.join(w.old, "harlow-legal");
  fs.symlinkSync("site", path.join(src, "current"));
  const when = new Date("2026-01-02T03:04:05Z");
  fs.writeFileSync(path.join(src, "site", "index.html"), "<h1>Harlow Legal</h1>\n");
  fs.utimesSync(path.join(src, "site", "index.html"), when, when);
  const tried = [];
  const rename = (a, b) => { tried.push(a); throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" }); };
  const logs = [];
  const out = moveProjects({ db: w.db, from: w.old, to: w.to, root: w.root, rename, log: m => logs.push(m) });
  assert.deepEqual(out && out.moved.sort(), ["harlow-legal", "northwind-bakery"]);
  assert.equal(tried.length, 2);
  const dst = path.join(w.to, "harlow-legal");
  assert.equal(fs.readFileSync(path.join(dst, "site", "index.html"), "utf8"), "<h1>Harlow Legal</h1>\n");
  assert.equal(fs.statSync(path.join(dst, "site", "index.html")).mtime.getTime(), when.getTime());
  assert.equal(fs.readlinkSync(path.join(dst, "current")), "site", "a symlink was rewritten");
  assert.ok(fs.lstatSync(src).isSymbolicLink(), "the source was not replaced by a link");
  assert.ok(logs.some(l => /moved harlow-legal .*\(copied\)/.test(l)));
});
