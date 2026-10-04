// @ts-check
// memory.graph: the floor plan. Rooms per project, the shared room, strict project graphs (a
// project never draws another client's facts), the updated cursor, the caps, and who may see
// the main graph.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open } from "../store/index.js";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { SESSIONS, HOME, seedRecall } from "../../test/fixtures/corpus.js";
import { tempHome, writeModule, present } from "../../test/helpers.js";
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

// ---- reviewer-2 probe on work/memory-access 7fa6b6b86: steering by a model label (drop into core/memory/) ----
test("RV2-MS1: which model labels may pin, mute or curate the MAIN graph or another project's", async t => {
  const root = fs.realpathSync(tempHome(t)); const work = path.join(root, "Work");
  const moved = [...SESSIONS, CROSSOVER].map(s => ({ ...s, cwd: s.cwd.replace(W, work) }));
  const db = open(path.join(root, "vyre.db")); seedRecall(db, moved); db.close();
  const d = await start({ root, log: () => {} }); t.after(() => d.stop());
  const opts = { root };
  await call("projects.create", { name: "Northwind", home: path.join(work, "northwind") }, opts);
  await call("projects.create", { name: "Harlow", home: path.join(work, "harlow-site"), workspaces: [path.join(work, "harlow-intake")] }, opts);
  await call("agents.create", { name: "juno", kind: "assistant" }, opts);
  await call("agents.create", { name: "kit", projects: ["northwind"] }, opts);
  await call("projects.access.migrate", {}, opts); await call("memory.curate", {}, opts);
  const out = {};
  const cases = [
    ["pin main", "memory.pin", { node: "Dana Reyes" }],
    ["mute main", "memory.mute", { node: "Dana Reyes", scope: "*" }],
    ["pin other project", "memory.pin", { node: "Harlow Legal", scope: path.join(work, "harlow-site") }],
    ["mute own project", "memory.mute", { node: "Sam Okafor", scope: path.join(work, "northwind") }],
    ["curate whole", "memory.curate", {}],
  ];
  for (const c of ["mcp", "mcp:thread:t1", "harness", "harness:thread:t1", "mcp:agent:kit", "module:flows", "anonymous"]) {
    for (const [label, tool, input] of cases) {
      const r = await d.registry.call(tool, input, c).catch(e => ({ error: { code: e.code, message: e.message } }));
      out[`${c} | ${label}`] = r.error ? `${r.error.code || ""}:${String(r.error.message || "").slice(0, 38)}` : "ALLOWED";
    }
  }
  console.log("MS1\n" + Object.entries(out).map(([k, v]) => k + " => " + v).join("\n"));
  const bad = Object.entries(out).filter(([k, v]) => v === "ALLOWED" && /^(mcp|mcp:thread:t1|harness|harness:thread:t1|module:flows|anonymous) \| (pin main|mute main|pin other project|curate whole)/.test(k)).map(([k]) => k);
  assert.deepEqual(bad, [], "an unnamed model steered the whole graph or another project: " + bad.join("; "));
});
