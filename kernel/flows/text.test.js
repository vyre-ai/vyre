import { test } from "node:test";
import assert from "node:assert/strict";
import { printFlow, parseFlowText, parseFlowTextBounded, sameFlow, normalizeFlow, TextError, TEXT_LIMITS } from "./text.js";
import { checkFlow, canonical, sourceHash } from "./schema.js";
import { onPayment } from "./testing/fixtures.js";

const refused = (text, re) => assert.throws(() => parseFlowText(text), e => e instanceof TextError && re.test(e.detail) && Number.isInteger(e.line) && e.line >= 1, `expected ${re}`);
const wrap = body => `import { defineFlow, step, expr } from '@vyre/sdk';\n${body}`;
const minimal = "export default defineFlow({ name: 'x', authorship: 'human', trigger: { on: 'manual' }, steps: [] });";

test("text: the sample Flow prints, parses back to the same stored form, and the text is stable", () => {
  const stored = normalizeFlow(onPayment());
  const text = printFlow(stored);
  const back = parseFlowText(text);
  assert.deepEqual(back.problems, []);
  assert.equal(back.flows.length, 1);
  assert.equal(canonical(back.flows[0].flow), canonical(stored));
  assert.equal(printFlow(back.flows[0].flow), text, "code to stored to code is the same text");
  assert.match(text, /^import \{ defineFlow, step, expr \} from '@vyre\/sdk';/);
  assert.match(text, /step\.create\('open', \{/);
  assert.match(text, /client: expr\('trigger\.client'\)/);
});

test("text: the printer is idempotent and independent of the stored form's key order", () => {
  const a = onPayment();
  const b = JSON.parse(JSON.stringify(a, (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v)));
  assert.equal(printFlow(a), printFlow(b));
  const once = printFlow(a), twice = printFlow(parseFlowText(once).flows[0].flow);
  assert.equal(once, twice);
});

test("text: comments are dropped, layout is the formatter's, and a named export is found", () => {
  const text = wrap(`// a comment\n/* another */\nexport const OnX = defineFlow({\n name:'x',authorship:'human',\n trigger:{on:'manual'},steps:[ step.create('a',{type:'matter',set:{client:'Jane'}}) ] });`);
  const r = parseFlowText(text);
  assert.equal(r.flows[0].binding, "OnX");
  assert.deepEqual(r.problems, []);
  assert.doesNotMatch(printFlow(r.flows[0].flow), /comment/);
});

test("text: a stored Flow with every step kind survives stored to code to stored", () => {
  const src = "const total = inputs.a + inputs.b;\nreturn { total };";
  const flow = normalizeFlow({
    format: 1, name: "everything", label: "Everything", description: "Every step kind.", authorship: "kit",
    caps: [{ action: "records.read", resource: "vyre://spc_a/matter/*" }],
    trigger: { on: "time", cron: "0 3 * * *" },
    steps: [
      { id: "s1", kind: "find", type: "matter", where: "record.plan == \"Trust\"", limit: 10 },
      { id: "s2", kind: "pick", type: "matter", where: "record.plan == \"Will\"" },
      { id: "s3", kind: "filter", from: "steps.s1.rows", where: "record.fee > 100" },
      { id: "s4", kind: "create", type: "matter", set: { client: "A", plan: "Will" } },
      { id: "s5", kind: "update", type: "matter", record: { expr: "steps.s2.record" }, set: { client: { expr: "trigger.n" } } },
      { id: "s6", kind: "upsert", type: "matter", match: { client: "A" }, set: { plan: "Both" } },
      { id: "s7", kind: "remove", type: "matter", record: { expr: "steps.s2.record" } },
      { id: "s8", kind: "decide", if: "len(steps.s1.rows) > 0", then: [{ id: "s8a", kind: "stage", type: "matter", record: { expr: "steps.s2.record" }, to: "Drafting" }], else: [{ id: "s8b", kind: "wait", for_ms: 60000 }] },
      { id: "s9", kind: "repeat", over: "steps.s1.rows", as: "row", max: 20, steps: [{ id: "s9a", kind: "assign", to: "teammate:research", title: { expr: "row.client" }, output: { kind: "note" }, how: "assistant", checker: "role:attorney", await: true }] },
      { id: "s10", kind: "wait", event: "document.signed", where: "event.record == trigger.id", timeout_ms: 86400000, on_timeout: "continue" },
      { id: "s11", kind: "ask", to: "role:attorney", title: "Approve?", form: [{ name: "ok", kind: "boolean" }] },
      { id: "s12", kind: "call", action: "email.send", resource: "vyre://spc_a/mail/*", input: { to: "a@example.com", "x-odd key": [1, 2, { z: null }] } },
      { id: "s13", kind: "agent", assistant: "teammate:intake", title: "Draft", instructions: "Write it", output: { kind: "draft", target: "welcome" } },
      { id: "s14", kind: "classify", input: { expr: "trigger.text" }, labels: ["urgent", "normal"] },
      { id: "s15", kind: "service", connector: "practice", method: "POST", path: "/matters", headers: { a: "b" }, query: { v: "1" }, body: { n: { expr: "trigger.n" } } },
      { id: "s16", kind: "fn", language: "js", source: src, inputs: { a: 1, b: { expr: "trigger.n" } }, outputs: ["total"], needs: [] },
    ],
  });
  assert.deepEqual(checkFlow(flow).map(e => e.path + ": " + e.message), []);
  const text = printFlow(flow);
  const back = parseFlowText(text).flows[0].flow;
  assert.equal(canonical(back), canonical(flow));
  assert.equal(printFlow(back), text);
  assert.ok(text.includes("source: `const total = inputs.a + inputs.b;\nreturn { total };`"), "the Code step is a template literal");
});

test("text: a stored Flow property test, random valid definitions survive stored to code to stored", () => {
  let seed = 12345;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const pick = a => a[rnd(a.length)];
  const word = () => pick(["alpha", "bravo", "charlie", "delta", "echo"]) + pick(["", "_1", "_x"]);
  const str = () => pick(["plain", "it's", "back\\slash", "line\nbreak", "tab\t", "unié", "quote\"d", "`tick`", "${x}", "", "a b c"]);
  const val = d => pick([() => str(), () => rnd(1000), () => rnd(2) === 0, () => null, () => ({ expr: pick(["trigger.n", "len(steps.a.rows) > 1", "lower(trigger.name)"]) }), () => (d < 2 ? [val(d + 1), val(d + 1)] : 1), () => (d < 2 ? { [word()]: val(d + 1), [str() || "k"]: val(d + 1) } : 2)])();
  let counter = 0;
  const id = () => "s" + (counter++);
  const step = d => {
    const k = pick(["create", "update", "remove", "find", "decide", "repeat", "wait", "ask", "call", "service", "fn", "classify"]);
    const base = { id: id(), kind: k };
    switch (k) {
      case "create": return { ...base, type: "matter", set: { [word()]: val(0) } };
      case "update": return { ...base, type: "matter", record: val(1), set: { [word()]: val(0) } };
      case "remove": return { ...base, type: "matter", record: val(1) };
      case "find": return { ...base, type: "matter", where: "record.n > 1", limit: 1 + rnd(50) };
      case "decide": return { ...base, if: "trigger.n > 1", then: d < 2 ? [step(d + 1)] : [], ...(rnd(2) ? { else: d < 2 ? [step(d + 1)] : [] } : {}) };
      case "repeat": return { ...base, over: "trigger.list", as: "item", steps: d < 2 ? [step(d + 1)] : [] };
      case "wait": return rnd(2) ? { ...base, for_ms: rnd(100000) } : { ...base, event: "document.signed", timeout_ms: 1000 + rnd(1000) };
      case "ask": return { ...base, to: "role:attorney", title: val(0) };
      case "call": return { ...base, action: "email.send", resource: "vyre://spc_a/mail/*", input: val(0) };
      case "service": return { ...base, connector: "practice", method: "POST", path: "/" + word(), body: val(0) };
      case "fn": { const source = str() + "\n*/ import x from 'y'; require('z') /// @ts-ignore `"; return { ...base, language: "js", source, hash: sourceHash(source), inputs: { a: val(1) }, outputs: ["out"] }; }
      default: return { ...base, input: val(0), labels: ["a", "b"] };
    }
  };
  for (let n = 0; n < 150; n++) {
    counter = 0;
    const flow = { format: 1, name: word().replace(/-/g, "_"), authorship: pick(["human", "builder", "model", "kit"]), trigger: pick([{ on: "manual" }, { on: "event", event: "payment.received" }, { on: "time", every_ms: 60000 }]), steps: Array.from({ length: 1 + rnd(4) }, () => step(0)) };
    const problems = checkFlow(flow);
    assert.deepEqual(problems, [], JSON.stringify(flow));
    const text = printFlow(flow);
    const back = parseFlowText(text);
    assert.deepEqual(back.problems, []);
    assert.equal(canonical(back.flows[0].flow), canonical(normalizeFlow(flow)), text);
    assert.equal(printFlow(back.flows[0].flow), text);
  }
});

test("text: a file outside the declarative subset is refused, with a line number", () => {
  refused(wrap("import fs from 'fs';\n" + minimal), /only @vyre\/sdk may be imported/);
  refused("import { defineFlow } from 'fs';\n" + minimal, /only @vyre\/sdk may be imported/);
  refused(wrap("const m = import('x');\n" + minimal), /dynamic import/);
  refused(wrap("const r = require('fs');\n" + minimal), /require is not allowed/);
  refused(wrap("export { a } from './a';\n" + minimal), /export \.\.\. from/);
  refused(wrap("/// <reference path=\"x\" />\n" + minimal), /triple-slash/);
  refused(wrap("// @ts-ignore\n" + minimal), /@ts- pragmas/);
  refused(wrap("export default defineFlow({ ...other });"), /spread/);
  refused(wrap("export default defineFlow({ ['ab']: 1 });"), /computed keys/);
  refused(wrap("export default defineFlow({ get x() { return 1; } });"), /getters|shorthand|expected/);
  refused(wrap("export default defineFlow({ name });"), /shorthand/);
  refused(wrap("const t = expr('a')`x`;"), /tagged templates/);
  refused(wrap("export default defineFlow({ name: `a${b}c` });"), /\$\{/);
  refused(wrap("export default defineFlow({ __proto__: { x: 1 } });"), /not a name a definition may use/);
  refused(wrap("export default defineFlow({ 'constructor': 1 });"), /not a name a definition may use/);
  refused(wrap("const f = function() {};"), /not allowed/);
  refused(wrap("const f = new Date();"), /not allowed/);
  refused(wrap("const n = other.thing(1);"), /not imported/);
  refused(wrap("const n = fetch('x');"), /not imported/);
  refused(wrap("const n = step.nope('a', {});"), /not something a definition file may call/);
  refused(wrap("const a = missing;"), /not defined above/);
  refused(wrap("export default defineFlow({ a: 1, a: 2 });"), /twice/);
  refused(wrap("let x = 1;"), /imports, `const name/);
  refused("export default 1 +", /ends too soon|unexpected/);
  try { parseFlowText(wrap("\n\n\nexport default defineFlow({ name: 1 + 2 });")); assert.fail(); } catch (e) { assert.equal(e.line, 5); }
});

test("text: defining the same name twice, a reference to an earlier definition, and a file with no Flow", () => {
  refused(wrap("const A = defineFlow({ name: 'a' });\nconst A = defineFlow({ name: 'b' });"), /defined twice/);
  refused(wrap("const A = 1;"), /defines no Flow/);
  const r = parseFlowText(wrap("export const A = defineFlow({ name: 'a', authorship: 'human', trigger: { on: 'manual' }, steps: [] });\nexport const B = defineFlow({ name: 'b', authorship: 'human', trigger: { on: 'manual' }, steps: [] });"));
  assert.deepEqual(r.flows.map(f => f.binding), ["A", "B"]);
});

test("text (E-3): a Code step body with */, an escaped backtick, import, require and /// neither ends the span nor trips a rejection", () => {
  const source = "/* not a comment end: */ import x from 'y'; const r = require('z');\n/// <reference path=\"q\" />\n// @ts-ignore\nconst t = `inner ${1}`;\nreturn { t };";
  const flow = { format: 1, name: "e3", authorship: "human", trigger: { on: "manual" }, steps: [{ id: "code", kind: "fn", language: "js", source, inputs: {}, outputs: ["t"] }] };
  const text = printFlow(flow);
  const back = parseFlowText(text);
  assert.deepEqual(back.problems, []);
  assert.equal(back.flows[0].flow.steps[0].source, source, "byte for byte");
  // and the same body written by hand as a string literal
  const hand = wrap(`export default defineFlow({ name: 'e3', authorship: 'human', trigger: { on: 'manual' }, steps: [ step.fn('code', { language: 'js', inputs: {}, outputs: ['t'], source: ${JSON.stringify(source).replace(/'/g, "\\'")} }) ] });`);
  assert.equal(parseFlowText(hand).flows[0].flow.steps[0].source, source);
  // an unescaped interpolation inside the span is still refused: values are never computed
  refused(wrap("export default defineFlow({ name: 'x', steps: [ step.fn('c', { source: `a ${b}` }) ] });"), /\$\{/);
  // an oversize body is a schema error, not a hang
  const huge = { ...flow, steps: [{ ...flow.steps[0], source: "x".repeat(64 * 1024 + 1) }] };
  assert.ok(checkFlow(huge).some(e => /at most 65536 characters/.test(e.message)));
});

test("text: limits on size, nesting and node count are errors, not slow requests", () => {
  refused("x".repeat(TEXT_LIMITS.source + 1), /over 1000000 characters/);
  refused(wrap("export default defineFlow({ a: " + "[".repeat(60) + "]".repeat(60) + " });"), /nests too deeply/);
  refused(wrap("export default defineFlow({ a: [" + "1,".repeat(70_000) + "] });"), /too large/);
});

test("text: a definition file cannot pollute prototypes", () => {
  assert.throws(() => parseFlowText(wrap("export default defineFlow({ name: 'x', trigger: { on: 'manual', __proto__: { polluted: true } }, steps: [] });")), TextError);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(parseFlowText(wrap(minimal.replace(" steps: []", " steps: [], description: 'd'")) ).flows[0].flow), Object.prototype, "the result is plain objects");
});

test("text: the bounded parser reads a good file and refuses a bad one in a worker", async () => {
  const good = printFlow(onPayment());
  const r = await parseFlowTextBounded(good);
  assert.equal(canonical(r.flows[0].flow), canonical(normalizeFlow(onPayment())));
  await assert.rejects(() => parseFlowTextBounded(wrap("const r = require('fs');\n" + minimal)), /require is not allowed/);
});

test("text: sameFlow ignores the hash a Code step carries and key order", () => {
  const a = { format: 1, name: "q", authorship: "human", trigger: { on: "manual" }, steps: [{ id: "c", kind: "fn", language: "js", source: "return {}", inputs: {}, outputs: [] }] };
  assert.ok(sameFlow(a, { ...a, steps: [{ ...a.steps[0], hash: sourceHash("return {}") }] }));
});
