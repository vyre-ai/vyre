// @ts-check
// A Flow's saved tests against a fake box: each act sends exactly the inputs the tools declare, and a refused call shows its words and changes nothing.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { seen.push({ tool, input }); return o[tool] ?? { data: {} }; };
  return { call, seen };
}

test("list, run, keep and remove send the inputs the tools declare", { skip: !strip }, async () => {
  const { testsSource } = await import("./tests-source.ts");
  const b = box({ "flows.test.list": { data: { cases: [{ name: "welcome", input: {} }] } }, "flows.test.run": { data: { ok: true, summary: "1 of 1 test case pass", lines: ["welcome: pass"] } } });
  const s = testsSource(b.call);
  assert.deepEqual(await s.list("f1"), [{ name: "welcome", input: {} }]);
  const ran = await s.run("f1");
  assert.deepEqual([ran.refresh, ran.result?.summary], [true, "1 of 1 test case pass"]);
  await s.keep("f1", "run_9");
  await s.keep("f1", "run_9", "  Late fee  ");
  await s.remove("f1", "welcome");
  assert.deepEqual(b.seen.map((x) => [x.tool, x.input]), [
    ["flows.test.list", { id: "f1" }],
    ["flows.test.run", { id: "f1" }],
    ["flows.test.save", { id: "f1", from_run: "run_9" }],
    ["flows.test.save", { id: "f1", from_run: "run_9", name: "Late fee" }],
    ["flows.test.remove", { id: "f1", name: "welcome" }],
  ]);
});

test("a refused call gives its own words and does not ask the page to read again", { skip: !strip }, async () => {
  const { testsSource } = await import("./tests-source.ts");
  const b = box({ "flows.test.remove": { error: { code: "not_allowed", message: "that is a person's to remove" } }, "flows.test.save": { error: { code: "not_found", message: "that run is not a run of this Flow" } }, "flows.test.list": { error: { code: "not_found", message: "no such Flow" } } });
  const s = testsSource(b.call);
  assert.deepEqual(await s.remove("f1", "welcome"), { refresh: false, message: "that is a person's to remove" });
  assert.deepEqual(await s.keep("f1", "run_x"), { refresh: false, message: "that run is not a run of this Flow" });
  assert.deepEqual(await s.list("gone"), [], "a list that cannot be read shows none");
});

test("a case says what it starts from", { skip: !strip }, async () => {
  const { caseWords } = await import("./tests-source.ts");
  assert.equal(caseWords({ name: "a", event: { type: "x" } }), "Starts from an event");
  assert.equal(caseWords({ name: "b", input: {} }), "Starts from a form or a button");
});
