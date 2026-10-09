// @ts-check
// e1: the lines form round-trips with the stored form and says it in fewer tokens.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { printLines, parseLines, enc, LinesError } from "./lines.js";
import { printFlow, normalizeFlow, sameFlow } from "./text.js";
import { checkFlow, sourceHash } from "./schema.js";

const src = "const a = 1;\n  return { n: `x ${a}` };\n";
const flow = normalizeFlow({
  format: 1, name: "intake_welcome", label: "Welcome", description: 'Says "hi"', authorship: "human",
  trigger: { on: "event", event: "payment.received", where: "trigger.amount > 100" },
  steps: [
    { id: "m", kind: "create", type: "matter", set: { client: { expr: "trigger.name" }, "odd key": "A b", n: 3, ok: true, none: null, list: [1, "two", { expr: "x" }] }, verify: { check: "output.record" }, retry: { attempts: 3, backoff_ms: [10, 20] } },
    { id: "d", kind: "decide", if: "steps.m.record.id", then: [
      { id: "a", kind: "assign", to: "role:paralegal", title: "Check the client", output: { kind: "note" } },
      { id: "r", kind: "repeat", over: "[1, 2]", as: "x", steps: [fnStep("g1")] },
    ], else: [{ id: "e", kind: "find", type: "matter" }], on_fail: { then: "continue", steps: [{ id: "h", kind: "create", type: "matter", set: { client: "failed" } }] } },
    fnStep("f"),
  ],
  on_failure: [{ id: "z", kind: "create", type: "matter", set: { client: "z" } }],
});
function fnStep(/** @type {string} */ id) { return { id, kind: "fn", language: "js", source: src, hash: sourceHash(src), inputs: {}, outputs: ["n"] }; }

test("e1: a Flow prints to lines and parses back to the same Flow", () => {
  const text = printLines(flow);
  const back = normalizeFlow(parseLines(text));
  assert.ok(sameFlow(back, flow), text);
  assert.equal(printLines(back), text, "printing what was parsed gives the same text");
  assert.deepEqual(checkFlow(back), []);
});

test("e1: values with quotes, newlines, keywords and unicode survive", () => {
  for (const v of ["", "true", "null", "12", "-3.5e2x", "a b", 'q"uote', "back\\slash", "line\nbreak", "tab\t", "héllo ✓", "role:x", "a,b", "[x]", "`tick`", "{ y }", "k=v"]) {
    const f = normalizeFlow({ format: 1, name: "t", authorship: "human", trigger: { on: "manual" }, steps: [{ id: "s", kind: "create", type: "m", set: { v } }] });
    const back = normalizeFlow(parseLines(printLines(f)));
    assert.deepEqual(back.steps[0].set.v, v, JSON.stringify(v));
  }
  assert.equal(enc({ expr: "a`b" }), '{expr: "a`b"}');
});

test("e1: a Code step whose source holds a closing marker falls back to a string and still round-trips", () => {
  const tricky = "return 1;\n>>>\nreturn 2;";
  const f = normalizeFlow({ format: 1, name: "t", authorship: "human", trigger: { on: "manual" }, steps: [{ id: "f", kind: "fn", language: "js", source: tricky, hash: sourceHash(tricky), inputs: {}, outputs: ["n"] }] });
  assert.ok(sameFlow(normalizeFlow(parseLines(printLines(f))), f));
});

test("e1: the lines are much shorter than the TypeScript form", () => {
  const a = printLines(flow).length, b = printFlow(flow).length;
  assert.ok(a < b * 0.6, `${a} vs ${b}`);
});

test("e1: bad lines are refused with the line number", () => {
  const bad = (/** @type {string} */ t, /** @type {RegExp} */ re) => assert.throws(() => parseLines(t), (e) => e instanceof LinesError && re.test(e.message), t);
  bad("steps:\n  a create type=\n", /line 2/);
  bad("steps:\n\ta create\n", /spaces/);
  bad("steps:\n  a create __proto__=1\n", /not allowed/);
  bad("steps:\n  a create set={__proto__: 1}\n", /not allowed/);
  bad("steps:\n  a decide\n    then:\n", /line 3: then has no steps/);
  bad("steps:\n  a fn source=<<<\n    x\n", /no closing/);
  bad("name: a\nname: b\n", /twice/);
  bad("steps:\n  a create type=m\n      deeper create\n", /indented more/);
  bad("name: " + "[".repeat(60) + "\n", /deeply/);
});

test("e1: every Flow in the shipped Kit library round-trips, and the lines cost fewer tokens", async () => {
  const { kitLibrary, kitFromLibrary } = await import("../../records/kits/library.js");
  const { tokens } = await import("../../lib/tokens.js");
  let n = 0, a = 0, b = 0;
  for (const meta of kitLibrary()) {
    const kit = kitFromLibrary(meta.id);
    for (const f of (kit.includes && kit.includes.flows) || []) {
      const flow = normalizeFlow(f.flow || f);
      if (!flow || !Array.isArray(flow.steps)) continue;
      const text = printLines(flow);
      assert.ok(sameFlow(normalizeFlow(parseLines(text)), flow), `${meta.id}: ${text.slice(0, 200)}`);
      n++; a += tokens(text); b += tokens(printFlow(flow));
    }
  }
  assert.ok(n > 0, "the library has Flows");
  console.log(`# lines: ${n} library Flows, ${a} tokens against ${b} for the TypeScript form (${Math.round((1 - a / b) * 100)} percent fewer)`);
  assert.ok(a <= b * 0.7, `${a} vs ${b}`);
});
