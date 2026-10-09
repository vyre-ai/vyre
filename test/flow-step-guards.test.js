// A tool a Flow may run (`flow.steps` in module.json) must gate itself on the person's chain: the Flows runner does not ask the kernel's action table about it, and a read tool has no other gate. This reads
// every module.json: each flow.steps tool needs a line in test/flow-step-guards.json naming the guard it relies on, and no line may be stale.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const guards = JSON.parse(fs.readFileSync(path.join(root, "test", "flow-step-guards.json"), "utf8")).tools;
const GUARD = /(chain|person|owner|member|grant|authorize|kernel)/i;

/** @returns {string[]} */
function flowTools() {
  const out = [];
  for (const top of ["core", "local", "modules"]) {
    const base = path.join(root, top);
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base)) {
      const f = path.join(base, d, "module.json");
      if (!fs.existsSync(f)) continue;
      let m; try { m = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
      for (const t of (m.flow && m.flow.steps) || []) if (t && typeof t.name === "string") out.push(t.name);
    }
  }
  return out;
}

test("every tool a module lists in flow.steps says which guard it relies on, in its own code, and no line is stale", () => {
  const have = flowTools();
  const missing = have.filter(n => !guards[n] || typeof guards[n].reason !== "string" || guards[n].reason.length < 40 || !GUARD.test(guards[n].reason));
  assert.deepEqual(missing, [], `add a line to test/flow-step-guards.json naming the check each makes on the person's chain: ${missing.join(", ")}`);
  const stale = Object.keys(guards).filter(n => !have.includes(n));
  assert.deepEqual(stale, [], `lines for tools that no longer list a flow step: ${stale.join(", ")}`);
});

test("the guard check itself: a flow.steps tool with no line, or a line with no guard, is caught", () => {
  const ok = (/** @type {any} */ g, /** @type {string} */ n) => Boolean(g[n] && typeof g[n].reason === "string" && g[n].reason.length >= 40 && GUARD.test(g[n].reason));
  assert.equal(ok({}, "x.y"), false, "no line");
  assert.equal(ok({ "x.y": { reason: "it is fine" } }, "x.y"), false, "no guard named");
  assert.equal(ok({ "x.y": { reason: "reads the person's chain with ctx.kernel.chain(meta) and refuses a chain that is not the owner" } }, "x.y"), true);
});
