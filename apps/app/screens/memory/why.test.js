// @ts-check
// "Where this came from": memory.why against a fake box, and how its turns are grouped.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

test("why: asks memory.why for the fact, groups turns by thread, names who said it", { skip: !strip }, async () => {
  const { memoryExtras } = await import("./extras-source.ts");
  const { whyOf } = await import("./why-model.ts");
  /** @type {any[]} */
  const seen = [];
  const w = await memoryExtras(async (tool, input) => { seen.push([tool, input]); return { data: { turns: [
    { session: "s1", seq: 3, name: "Intake call", text: "Kit takes the intake", role: "user", age: "2 days ago" },
    { session: "s2", seq: 1, text: "Noted.", role: "assistant" },
    { session: "s1", seq: 5, name: "Intake call", text: "Yes, Kit", role: "assistant" }],
    taught: [{ module: "flows", kind: "rule", text: "Kit owns intake" }], gone: 2 } }; }).whyReal("fact:1");
  assert.deepEqual(seen, [["memory.why", { fact: "fact:1", limit: 10 }]]);
  const o = whyOf(w);
  assert.deepEqual(o.threads.map((t) => [t.session, t.name, t.turns.length]), [["s1", "Intake call", 2], ["s2", "Untitled chat", 1]]);
  assert.deepEqual(o.threads[0].turns[0], { seq: 3, text: "Kit takes the intake", who: "You", age: "2 days ago" });
  assert.equal(o.threads[1].turns[0].who, "The agent");
  assert.deepEqual(o.taught, [{ module: "flows", kind: "rule", text: "Kit owns intake" }]);
  assert.equal(o.gone, "2 turns behind this are no longer in the index.");
  assert.equal(o.empty, false);
});

test("why: nothing behind a fact is said plainly, never invented", { skip: !strip }, async () => {
  const { whyOf } = await import("./why-model.ts");
  const o = whyOf({});
  assert.equal(o.empty, true);
  assert.deepEqual(o.threads, []);
  assert.equal(whyOf({ gone: 1 }).gone, "1 turn behind this is no longer in the index.");
});

test("why: a box error is thrown", { skip: !strip }, async () => {
  const { memoryExtras } = await import("./extras-source.ts");
  await assert.rejects(memoryExtras(async () => ({ error: { code: "nope", message: "no" } })).whyReal("f"), /no/);
});
