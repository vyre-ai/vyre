// @ts-check
// Writing a Flow in text against a fake box shaped like flows.compile-text and flows.define.
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const EFFECTS = { reads: ["matter"], writes: ["matter"], outward: ["email.send"], services: [], code: [], asks: 2, assigns: ["teammate:intake"], sealed_uses: [], destinations: [], model_steps: [], needs_run_ask: false };

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { seen.push({ tool, input }); return o[tool] ?? { data: {} }; };
  return { call, seen };
}

test("Check sends the text and says what is wrong in the kernel's words, or what the Flow would do", { skip: !strip }, async () => {
  const { engineerSource } = await import("./engineer-source.ts");
  const m = await import("./engineer-model.ts");
  const bad = box({ "flows.compile-text": { data: { ok: false, errors: [{ path: "line 1", message: "a definition file has imports and export default only" }], changes: [] } } });
  const r = await engineerSource(bad.call).check("hello");
  assert.deepEqual(bad.seen, [{ tool: "flows.compile-text", input: { text: "hello" } }]);
  assert.deepEqual([m.verdict(r).title, m.problemLine(r.errors[0])], ["1 problem to fix", "line 1: a definition file has imports and export default only"]);
  const good = box({ "flows.compile-text": { data: { ok: true, errors: [], warnings: ["It sends mail"], effects: EFFECTS, changes: [] } } });
  const g = await engineerSource(good.call).check("x");
  assert.equal(m.verdict(g).tone, "ok");
  assert.deepEqual(m.effectLines(g.effects), ["Reads: matter.", "Writes: matter.", "Sends or publishes: email.send.", "Asks a person 2 times.", "Hands work to: teammate:intake."]);
  assert.equal(m.warnLine(g.warnings?.[0] ?? ""), "It sends mail");
});

test("Save is flows.define with the text; a saved draft opens the Flow's own page, a refusal stays here", { skip: !strip }, async () => {
  const { engineerSource } = await import("./engineer-source.ts");
  const m = await import("./engineer-model.ts");
  const ok = box({ "flows.define": { data: { ok: true, id: "welcome", version: 1, hash: "h" } } });
  const d = await engineerSource(ok.call).save("t");
  assert.deepEqual(ok.seen, [{ tool: "flows.define", input: { text: "t" } }]);
  assert.equal(m.flowHref(d), "/u/flows/welcome");
  await engineerSource(ok.call).save("t2", "welcome");
  assert.deepEqual(ok.seen[1].input, { text: "t2", id: "welcome" });
  assert.equal(m.flowHref({ ok: false, errors: [{ message: "x" }] }), null);
  assert.match(m.engineerRefusal("forbidden", ""), /may not write Flows/);
});
