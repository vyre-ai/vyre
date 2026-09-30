// @ts-check
// Quiet local version history for a project's folder: a new folder gets github.project.local-init
// at once; an existing non-repo folder gets one offer, once; a repo or a module caller gets nothing.
// Runs the real module's start() into a fake ctx (access.test.js's pattern); github's tool is a spy.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";
import { MIGRATIONS } from "./projects.js";
import mod from "./index.js";
import * as config from "../config/index.js";

async function world(t, { github = true } = {}) {
  const root = fs.realpathSync(tempHome(t));
  const db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  const cfg = config.load(root);
  const tools = new Map(), inits = [];
  const ctx = {
    config: { ...cfg, role: "box", roots: [], projectsDir: path.join(root, "projects") },
    store: { db, migrate: steps => migrate(db, "projects", steps) },
    paths: { root }, log: () => {},
    events: { emit: () => {}, on: () => () => {} },
    tool: (name, def) => tools.set(name, def),
    call: async (tool, input = {}) => {
      if (tool === "github.project.local-init") {
        if (!github) return { error: { code: "no_such_tool", message: "none" } };
        inits.push(input.project);
        return { data: { already: false, branch: "main", left_out: [] } };
      }
      if (tool === "agents.list") return { error: { code: "no_such_tool", message: "none" } };
      const def = tools.get(tool);
      if (!def) return { error: { code: "no_such_tool", message: "none" } };
      try { return { data: await def.run(input, { caller: "module:projects" }) }; }
      catch (e) { return { error: { code: /** @type {any} */ (e).code || "failed", message: /** @type {Error} */ (e).message } }; }
    },
  };
  const handle = await mod.start(ctx);
  t.after(() => handle.stop());
  const call = (tool, input, meta = { caller: "cli" }) => tools.get(tool).run(input, meta);
  const state = slug => /** @type {any} */ (db.prepare("SELECT state FROM projects_history WHERE project = ?").get(slug))?.state ?? null;
  return { root, call, inits, state };
}

test("a new folder gets version history quietly, with no offer", async t => {
  const w = await world(t);
  const p = await w.call("projects.create", { name: "Northwind Bakery" });
  assert.deepEqual(w.inits, ["northwind-bakery"]);
  assert.equal(p.offer, undefined);
  assert.equal(w.state("northwind-bakery"), "kept");
});

test("an existing folder that is not a repo gets one offer; saying no is remembered", async t => {
  const w = await world(t);
  const home = path.join(w.root, "alex", "Work", "harlow");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "notes.txt"), "hi");
  const p = await w.call("projects.create", { name: "Harlow Legal", home });
  assert.equal(p.offer.question, "Keep version history for this folder?");
  assert.equal(p.offer.tool, "projects.history");
  assert.deepEqual(w.inits, []);
  assert.equal(w.state("harlow-legal"), "offered");
  const no = await w.call("projects.history", { project: "harlow-legal", keep: false });
  assert.equal(no.state, "declined");
  assert.deepEqual(w.inits, []);
});

test("saying yes to the offer makes the folder a repo through github's tool", async t => {
  const w = await world(t);
  const home = path.join(w.root, "harlow");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "notes.txt"), "hi");
  await w.call("projects.create", { name: "Harlow Legal", home });
  const yes = await w.call("projects.history", { project: "harlow-legal", keep: true });
  assert.equal(yes.state, "kept");
  assert.deepEqual(w.inits, ["harlow-legal"]);
});

test("a folder that is already a repo, or a module-made project, gets nothing", async t => {
  const w = await world(t);
  const home = path.join(w.root, "repo");
  fs.mkdirSync(path.join(home, ".git"), { recursive: true });
  const p = await w.call("projects.create", { name: "Repo One", home });
  assert.equal(p.offer, undefined);
  const q = await w.call("projects.create", { name: "Synced", home: path.join(w.root, "synced") }, { caller: "module:sync" });
  assert.equal(q.offer, undefined);
  assert.deepEqual(w.inits, []);
});

test("with github off, create still works, quietly", async t => {
  const w = await world(t, { github: false });
  const p = await w.call("projects.create", { name: "Northwind Bakery" });
  assert.equal(p.slug, "northwind-bakery");
  assert.equal(p.offer, undefined);
  assert.equal(w.state("northwind-bakery"), null);
});
