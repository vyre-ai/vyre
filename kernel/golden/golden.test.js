import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { record, load, diff, added, weakened, addedRuns, risky } from "./index.js";
import { CALLERS, WORLDS } from "./matrix.js";

let fresh = null;
const now = () => (fresh ||= record());

test("the recorder reproduces the stored golden set cell for cell", { timeout: 900_000 }, () => {
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

test("K2-9: generated callers outside the matrix get the same decisions from the gates as from the registry's own rules", { timeout: 900_000 }, () => {
  const was = record({ generated: true }), now_ = record({ gates: true, generated: true });
  assert.ok(was.callers.length > 100);
  const d = diff(was, now_);
  assert.deepEqual(d.slice(0, 20), [], `${d.length} decisions differ for generated callers`);
});

test("diff: a new tool is recorded, not judged; a changed cell or a vanished tool is a difference", () => {
  const base = { callers: ["c"], worlds: ["w"], legend: { R: "would run", a: "denied" }, roles: { box: { rows: { "a.x": "R" }, emptyBad: {} } } };
  const withNew = { ...base, roles: { box: { rows: { "a.x": "R", "b.new": "a" }, emptyBad: {} } } };
  assert.deepEqual(diff(base, withNew), []);
  assert.deepEqual(added(base, withNew), { box: ["b.new"] });
  const changed = { ...base, roles: { box: { rows: { "a.x": "a" }, emptyBad: {} } } };
  assert.equal(diff(base, changed).length, 1);
  const gone = { ...base, roles: { box: { rows: {}, emptyBad: {} } } };
  assert.equal(diff(base, gone)[0].now, "absent");
});

test("a refresh fails on any existing cell moving from refused to run unless an allow entry with a reason names it; additions and tightenings pass", () => {
  const set = (rows) => ({ v: 1, callers: ["cli", "deck"], worlds: ["bare"], legend: { R: "would run", a: "denied", b: "no_such_tool" }, roles: { box: { rows, emptyBad: {} } } });
  const was = set({ t1: "aR", t2: "Ra", t3: "bb" });
  assert.deepEqual(weakened(was, set({ t1: "aR", t2: "aa", t3: "Ra" })), [], "R to a is a tightening; no_such_tool to a decision is an addition");
  const loosened = set({ t1: "RR", t2: "Ra", t3: "bb" });
  assert.equal(weakened(was, loosened).length, 1);
  assert.deepEqual(weakened(was, loosened).map(d => [d.tool, d.caller, d.was, d.now]), [["t1", "cli", "denied", "would run"]]);
  assert.equal(weakened(was, loosened, [{ tool: "t1", reason: "" }]).length, 1, "a reason is required");
  assert.equal(weakened(was, loosened, [{ tool: "t1", caller: "deck", reason: "x" }]).length, 1, "another caller's entry does not cover it");
  assert.equal(weakened(was, loosened, [{ tool: "t1", reason: "the CLI may now start it" }]).length, 0);
});

test("a refresh lists the callers each added tool runs for and refuses one that runs for a model, guest or MCP caller unless allow.json names it", () => {
  const set = rows => ({ v: 1, callers: ["cli", "mcp:agent:kit", "tailnet-guest", "deck"], worlds: ["bare"], legend: { R: "would run", a: "denied", b: "no_such_tool" }, roles: { box: { rows, emptyBad: {} } } });
  const was = set({ old: "RaaR" });
  assert.deepEqual(addedRuns(was, set({ old: "RaaR", mine: "RaaR" })), [{ role: "box", tool: "mine", callers: ["cli", "deck"], risky: [] }], "person-only: nothing risky");
  const open = addedRuns(was, set({ old: "RaaR", fresh: "RRRR" }));
  assert.deepEqual(open[0].risky, ["mcp:agent:kit", "tailnet-guest"]);
  assert.deepEqual(addedRuns(was, set({ old: "RaaR", fresh: "RRRR" }), [{ tool: "fresh", reason: "an assistant starts these on purpose" }])[0].risky, []);
  assert.equal(addedRuns(was, set({ old: "RaaR", fresh: "RRRR" }), [{ tool: "fresh", reason: "" }])[0].risky.length, 2, "a reason is required");
  assert.deepEqual(addedRuns(was, set({ old: "RaaR", ghost: "bbbb" })), [], "a tool nobody can run is not an opening");
  // a tool that existed only as no_such_tool (the runner.start case) counts as added when it first has a decision
  const hidden = set({ old: "RaaR", runner: "bbbb" });
  assert.equal(addedRuns(hidden, set({ old: "RaaR", runner: "RRRR" }))[0].risky.length, 2);
  assert.equal(risky("cli"), false);
  assert.equal(risky("harness"), true);
});
