import test from "node:test";
import assert from "node:assert/strict";
import { record, load, diff } from "./index.js";
import { CALLERS, WORLDS } from "./matrix.js";

let fresh = null;
const now = () => (fresh ||= record());

test("the recorder reproduces the stored golden set cell for cell", () => {
  const d = diff(load(), now());
  assert.deepEqual(d.slice(0, 20), [], `${d.length} decisions changed; if on purpose, run: node kernel/golden/index.js --write`);
});

test("the golden set covers every tool in both roles with one cell per caller and world", () => {
  const g = now();
  for (const role of ["box", "local"]) {
    const tools = Object.keys(g.roles[role].rows);
    assert.ok(tools.length > 300, `${role}: only ${tools.length} tools`);
    for (const t of tools) assert.equal(g.roles[role].rows[t].length, CALLERS.length * WORLDS.length, `${role} ${t}`);
  }
});

test("golden sanity: the facts the kernel brief relies on hold today", () => {
  const g = now(), row = (role, t) => g.roles[role].rows[t];
  const cell = (role, t, caller, world) => g.legend[row(role, t)[g.callers.indexOf(caller) * g.worlds.length + g.worlds.indexOf(world)]];
  // unknown tools are refused and an internal tool is invisible to a surface
  const internal = Object.keys(g.roles.box.rows).find(t => cell("box", t, "cli", "bare") === "no_such_tool" && cell("box", t, "module:first-party", "bare") !== "no_such_tool");
  assert.ok(internal, "at least one internal tool exists");
  // a hook-only tool runs for hook and for nobody else
  for (const t of Object.keys(g.roles.box.rows)) {
    if (cell("box", t, "hook", "bare") === "would run") assert.notEqual(cell("box", t, "cli", "person+proof"), "would run", `${t} is a hook tool`);
  }
  // a guest never gets further than a person would
  for (const t of Object.keys(g.roles.box.rows)) {
    if (cell("box", t, "tailnet-guest", "person+proof") === "would run") assert.equal(cell("box", t, "cli", "person+proof"), "would run", `${t}: guest ran where the person's own surface did not`);
  }
});

test("the matrix lists are unique and the world ids are stable", () => {
  assert.equal(new Set(CALLERS.map(c => c.id)).size, CALLERS.length);
  assert.deepEqual(WORLDS.map(w => w.id), ["bare", "person", "person+proof", "person+proof+said", "named"]);
});

test("K2b: with the kernel retrofit deciding the gates, every decision is the same as today's, cell for cell", () => {
  const d = diff(load(), record({ gates: true }));
  assert.deepEqual(d.slice(0, 20), [], `${d.length} decisions changed under the kernel gates`);
});
