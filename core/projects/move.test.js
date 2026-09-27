// @ts-check
// The box moves project homes from ~/Vyre/projects into the work folder once (./move.js).
// Every folder is under the test's temp home: VYRE_WORK_DIR and VYRE_OLD_PROJECTS_DIR point there.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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

test("move: a box's first start moves both project homes, leaves links, rewrites rows and markers, then never again", async t => {
  const w = world(t);
  fs.writeFileSync(path.join(w.root, "config.json"), JSON.stringify({ role: "box" }));
  assert.equal(config.load(w.root).projectsDir, w.to, "the box's default is the work folder");
  // Taildrive's projects share follows it.
  assert.equal(shareMap(config.load(w.root), [w.work]).projects, w.to);

  const f = fakeCtx(w);
  const stop = await mod.start(f.ctx);
  const moved = f.events.filter(e => e.type === "projects.moved");
  assert.equal(moved.length, 1);
  assert.deepEqual(moved[0].payload.moved.sort(), ["harlow-legal", "northwind-bakery"]);
  assert.deepEqual(moved[0].payload.skipped, []);
  const record = JSON.parse(fs.readFileSync(path.join(w.root, RECORD), "utf8"));
  assert.deepEqual({ ...record, moved: record.moved.sort() }, { ...moved[0].payload, moved: moved[0].payload.moved.sort() });
  assert.equal(record.from, w.old);
  assert.equal(record.to, w.to);

  for (const slug of ["harlow-legal", "northwind-bakery"]) {
    const link = path.join(w.old, slug);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), `${slug} left no link`);
    assert.equal(fs.readlinkSync(link), path.join(w.to, slug));
    assert.ok(fs.existsSync(path.join(w.to, slug, M.MARKER)));
  }
  // The plain folder stays where it was.
  assert.ok(fs.lstatSync(path.join(w.old, "notes")).isDirectory());
  assert.ok(!fs.existsSync(path.join(w.to, "notes")));

  // Rows point at the new homes, the spec's folders too.
  const rows = w.db.prepare("SELECT slug, home, spec FROM projects_projects ORDER BY slug").all();
  assert.deepEqual(rows.map(r => r.home), [path.join(w.to, "harlow-legal"), path.join(w.to, "northwind-bakery")]);
  for (const r of rows) assert.ok(!String(r.spec).includes(w.old), `${r.slug}'s spec still names the old folder`);

  // Markers: relative inside the home, and a folder outside it still found.
  const harlow = M.load(path.join(w.to, "harlow-legal"));
  assert.deepEqual(harlow && harlow.workspaces, [path.join(w.to, "harlow-legal"), path.join(w.to, "harlow-legal", "site"), w.shared]);
  const north = M.load(path.join(w.to, "northwind-bakery"));
  assert.deepEqual(north && north.workspaces, [path.join(w.to, "northwind-bakery"), path.join(w.to, "harlow-legal")],
    "a folder in another moved home follows it");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.to, "northwind-bakery", M.MARKER), "utf8")).workspaces, ["../harlow-legal"]);

  // The projects list shows the new homes.
  const list = await f.tools.get("projects.list").run({});
  assert.deepEqual(list.projects.map(p => p.home).sort(), [path.join(w.to, "harlow-legal"), path.join(w.to, "northwind-bakery")]);
  // A session still in the old path belongs to the moved project, through the link.
  const of = await f.tools.get("projects.of").run({ cwd: path.join(w.old, "harlow-legal", "site") });
  assert.equal(of && of.slug, "harlow-legal");
  await stop.stop();

  // A second start does nothing.
  const again = fakeCtx(w);
  await mod.start(again.ctx);
  assert.deepEqual(again.events, []);
  assert.equal(moveProjects({ db: w.db, from: w.old, to: w.to, root: w.root }), null);
});

test("move: a Mac, or a box with its own projectsDir, moves nothing", async t => {
  const w = world(t);
  const mac = fakeCtx(w, "local");
  await mod.start(mac.ctx);
  fs.writeFileSync(path.join(w.root, "config.json"), JSON.stringify({ role: "box", projectsDir: w.old }));
  const own = fakeCtx(w);
  await mod.start(own.ctx);
  assert.deepEqual([...mac.events, ...own.events], []);
  assert.ok(!fs.existsSync(path.join(w.root, RECORD)));
  assert.ok(fs.lstatSync(path.join(w.old, "harlow-legal")).isDirectory() && !fs.lstatSync(path.join(w.old, "harlow-legal")).isSymbolicLink());
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
