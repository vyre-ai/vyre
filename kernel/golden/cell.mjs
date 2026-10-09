// One cell of the golden tests: one role and one recorder run (VYRE_GOLDEN_ROLE box|local, VYRE_GOLDEN_RUN plain|gates|generated), set by golden-<role>-<run>.test.js, which imports this.
// The recorder asks every tool of every caller in every world; all of it in one file took 15 minutes, past the 300 s per-file limit, so each (role, run) is its own file. Nothing here is skipped:
// the old golden.test.js's recorder cases are these files (the generated run in six parts a role), and the cases that need no recording stay in golden.test.js.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { record, recordAsync, loadRole, diff } from "./index.js";
import { CALLERS, WORLDS } from "./matrix.js";

const ROLE = String(process.env.VYRE_GOLDEN_ROLE || ""), RUN = String(process.env.VYRE_GOLDEN_RUN || ""), PART = String(process.env.VYRE_GOLDEN_PART || "");
if (!["box", "local"].includes(ROLE) || !["plain", "gates", "generated"].includes(RUN)) throw new Error("kernel/golden/cell.mjs is imported by golden-<role>-<run>.test.js, which names its role and run");
const cellTest = (/** @type {any[]} */ ...a) => /** @type {any} */ (test)(...a);

if (RUN === "plain") {
  const fresh = record({ role: ROLE });
  cellTest(`the recorder reproduces the stored golden set cell for cell (${ROLE})`, () => {
    const d = diff(loadRole(ROLE), fresh);
    assert.deepEqual(d.slice(0, 20), [], `${d.length} decisions changed; if on purpose, run: node kernel/golden/index.js --write`);
  });
  cellTest(`the golden set covers every ${ROLE} tool with one cell per caller and world`, () => {
    const tools = Object.keys(fresh.roles[ROLE].rows);
    assert.ok(tools.length > 300, `${ROLE}: only ${tools.length} tools`);
    for (const t of tools) assert.equal(fresh.roles[ROLE].rows[t].length, CALLERS.length * WORLDS.length, `${ROLE} ${t}`);
  });
  if (ROLE === "box") cellTest("golden sanity: the facts the kernel brief relies on hold today", () => {
    const g = fresh, row = (/** @type {string} */ t) => g.roles.box.rows[t];
    const cell = (/** @type {string} */ t, /** @type {string} */ caller, /** @type {string} */ world) => g.legend[row(t)[g.callers.indexOf(caller) * g.worlds.length + g.worlds.indexOf(world)]];
    // unknown tools are refused and an internal tool is invisible to a surface
    const internal = Object.keys(g.roles.box.rows).find(t => cell(t, "cli", "bare") === "no_such_tool" && cell(t, "module:first-party", "bare") !== "no_such_tool");
    assert.ok(internal, "at least one internal tool exists");
    // a hook-only tool runs for hook and for nobody else
    for (const t of Object.keys(g.roles.box.rows)) {
      if (cell(t, "hook", "bare") === "would run") assert.notEqual(cell(t, "cli", "person+proof"), "would run", `${t} is a hook tool`);
    }
    // a guest never gets further than a person would
    for (const t of Object.keys(g.roles.box.rows)) {
      if (cell(t, "tailnet-guest", "person+proof") === "would run") assert.equal(cell(t, "cli", "person+proof"), "would run", `${t}: guest ran where the person's own surface did not`);
    }
  });
}
if (RUN === "gates") cellTest(`K2b: with the kernel retrofit deciding the gates, every ${ROLE} decision is the same as today's, cell for cell`, () => {
  const d = diff(loadRole(ROLE), record({ gates: true, role: ROLE }));
  assert.deepEqual(d.slice(0, 20), [], `${d.length} decisions changed under the kernel gates`);
});
if (RUN === "generated") cellTest(`K2-9: generated callers outside the matrix get the same ${ROLE} decisions from the gates as from the registry's own rules (part ${PART})`, async () => {
  // the two recordings side by side: one after the other they ran past the per-file limit on a busy machine
  const [was, now_] = await Promise.all([recordAsync({ generated: true, role: ROLE, callers: PART }), recordAsync({ gates: true, generated: true, role: ROLE, callers: PART })]);
  assert.ok(was.callers.length > 20, `${was.callers.length} callers in part ${PART}`);
  const d = diff(was, now_);
  assert.deepEqual(d.slice(0, 20), [], `${d.length} decisions differ for generated callers`);
});
