import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { diff, added, weakened, addedRuns, risky } from "./index.js";
import { CALLERS, WORLDS } from "./matrix.js";


test("the matrix lists are unique and the world ids are stable", () => {
  assert.equal(new Set(CALLERS.map(c => c.id)).size, CALLERS.length);
  assert.deepEqual(WORLDS.map(w => w.id), ["bare", "person", "person+proof", "person+proof+said", "named"]);
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
