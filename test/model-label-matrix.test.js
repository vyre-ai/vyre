// A model never gets more than the surface it rides on. The scan tests (model-is-never-person, person-label-hygiene) find label checks by the shape of the code, so a check
// written in a shape they do not know passes unseen. This one asks the registry's decisions instead: the golden matrix holds one cell per tool, caller and world, and an
// UNPROVEN model label (an agent name on a surface, a tailnet or Space agent label, no daemon-bound session) must never run a tool its base surface does not run in the same
// world. That covers every reach:person and owner-effect tool, whatever shape the code that decides it has. A session the daemon proved (meta.thread bound) may widen; it is
// not in these pairs. The stored golden set is read (kernel/golden/golden.json, kept current by the golden tests), so this file does no recording.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { load } from "../kernel/golden/index.js";
import { AGENT_PENDS } from "../lib/one-yes.js";

/** [model label, the surface or person label it must never exceed]. */
export const PAIRS = Object.freeze([
  ["mcp:agent:kit", "mcp"], ["mcp:agent:", "mcp"], ["cli:agent:kit", "cli"],
  ["tailnet:agent:kit", "tailnet:owner"], ["agent:kit", "tailnet:owner"], ["tailnet:agent:kit", "mcp"], ["agent:kit", "mcp"],
]);

const runs = (/** @type {string} */ c) => c === "would run" || c.startsWith("ran");

/** Cells where `model` runs and `base` does not: [{ role, tool, world, model, base, baseCell }]. @param {any} g @param {readonly (readonly string[])[]} pairs */
export function wider(g, pairs = PAIRS) {
  const W = g.worlds.length, out = [];
  for (const [role, { rows }] of /** @type {[string, any][]} */ (Object.entries(g.roles))) {
    for (const [model, base] of pairs) {
      const mi = g.callers.indexOf(model), bi = g.callers.indexOf(base);
      if (mi < 0 || bi < 0) throw new Error(`the matrix has no caller ${mi < 0 ? model : base}; fix PAIRS or the matrix`);
      for (const tool of Object.keys(rows)) g.worlds.forEach((/** @type {string} */ world, /** @type {number} */ w) => {
        const m = g.legend[rows[tool][mi * W + w]], b = g.legend[rows[tool][bi * W + w]];
        // AGENT_PENDS: an agent's call to these only FILES a request for a person (the floor lets it reach the tool, and the tool keeps the request pending whatever the label: core/vault/asker.js isAsker); the surface
        // is refused because acting takes a person's yes. test/vault-asker.test.js proves an agent label on a person's surface, not just Claude's session, gets a pending request and no secret.
        if (runs(m) && !runs(b) && !AGENT_PENDS.includes(tool)) out.push({ role, tool, world, model, base, baseCell: b });
      });
    }
  }
  return out;
}

test("an unproven model label never runs a tool its base surface does not run, in either role and every world", () => {
  const g = load(), bad = wider(g);
  assert.deepEqual(bad.slice(0, 20), [], `${bad.length} cells let a model label do what its surface cannot (a reach:person or owner-effect tool reached through a label)`);
});

test("the check is not vacuous: the pairs cover many tools, some a model is refused and some it runs", () => {
  const g = load(), W = g.worlds.length;
  for (const [role, { rows }] of /** @type {[string, any][]} */ (Object.entries(g.roles))) {
    const tools = Object.keys(rows);
    for (const [model, base] of PAIRS) {
      const mi = g.callers.indexOf(model), bi = g.callers.indexOf(base);
      const cells = tools.map(t => [g.legend[rows[t][mi * W]], g.legend[rows[t][bi * W]]]);
      assert.ok(tools.length > 300, `${role}: only ${tools.length} tools`);
      assert.ok(cells.some(([m, b]) => runs(b) && !runs(m)), `${role} ${model}: no tool where the base runs and the model is refused, so the pair proves nothing`);
      assert.ok(cells.some(([m]) => runs(m)), `${role} ${model}: no tool the model runs, so the label is not being exercised`);
    }
  }
});

test("red proof: a model cell flipped to run where the surface is refused is caught", () => {
  const g = JSON.parse(JSON.stringify(load())), W = g.worlds.length;
  const rows = g.roles.box.rows, mi = g.callers.indexOf("mcp:agent:kit"), bi = g.callers.indexOf("mcp");
  const tool = Object.keys(rows).find(t => !runs(g.legend[rows[t][bi * W]]) && g.legend[rows[t][bi * W]] !== "no_such_tool");
  assert.ok(tool, "a tool the bare mcp surface is refused");
  const letter = Object.keys(g.legend).find(k => g.legend[k] === "would run");
  const row = rows[tool].split(""); row[mi * W] = letter; rows[tool] = row.join("");
  const bad = wider(g);
  assert.equal(bad.length, 1);
  assert.deepEqual([bad[0].tool, bad[0].model, bad[0].world], [tool, "mcp:agent:kit", "bare"]);
});
