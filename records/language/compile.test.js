import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { compile, compileSafely, validateStored } from "./compile.js";
import { print } from "./print.js";
import { LanguageError } from "./errors.js";

const KIT_SRC = fs.readFileSync(new URL("../kits/estate-planning/kit.ts", import.meta.url), "utf8");

test("the estate planning kit compiles to the stored form", () => {
  const kit = compile(KIT_SRC);
  assert.equal(kit.id, "estate-planning");
  assert.deepEqual(kit.types.map((t) => t.name), ["contact", "matter"]);
  const ssn = kit.types[0].fields.find((f) => f.name === "ssn");
  assert.deepEqual(ssn, { name: "ssn", kind: "sealed", label: "Social Security number", description: ssn.description, seal: { level: "ai", class: "us-ssn" } });
  const stage = kit.types[1].fields.find((f) => f.kind === "stage");
  assert.deepEqual(stage.options, ["Intake", "Engagement", "Drafting", "Signing", "Funding", "Closed"]);
  assert.deepEqual(kit.types[1].stages.map((s) => s.name), stage.options, "the stage field and the type's stages are one list");
  assert.equal(kit.types[1].stages[0].tasks.length, 2);
  const welcome = kit.types[1].stages[0].tasks[1];
  assert.deepEqual(welcome, { title: "Welcome email", doer: "teammate:intake", checker: "role:attorney", output: { kind: "sent", target: "email" }, how: "tailor", template: "welcome", depends_on: ["Research the client"], due_offset_ms: 86_400_000 });
  assert.deepEqual(kit.roles.map((r) => [r.name, r.kind]), [["research", "teammate"], ["intake", "teammate"], ["attorney", "role"]]);
  assert.equal(kit.templates[0].name, "welcome");
  assert.equal(kit.flows[0].trigger.event, "payment.received");
  assert.deepEqual(kit.flows[0].steps.map((x) => [x.id, x.kind]), [["client", "upsert"], ["matter", "upsert"]]);
  assert.equal(kit.types[1].fields.find((f) => f.name === "client").kind, "link", "a link to another record");
});

test("round trip: stored to text to stored is identical, and the text is a fixed point", () => {
  const kit = compile(KIT_SRC);
  const text = print(kit);
  const again = compile(text);
  assert.deepEqual(again, kit);
  assert.equal(print(again), text);
  assert.deepEqual(validateStored(kit), kit);
});

test("the worker parse gives the same answer", async () => {
  assert.deepEqual(await compileSafely(KIT_SRC), compile(KIT_SRC));
});

const wrap = (body) => `import { defineKit, defineType, defineField, defineStage, defineTask, defineRole, defineRule, defineTemplate } from "@vyre/sdk";\n${body}`;
const kitOf = (extra = "", fields = 't: defineField.text()') => wrap(`export const A = defineType({ name: "a", fields: { ${fields} } });\n${extra}\nexport default defineKit({ id: "k", version: 1, includes: [A] });`);
const fails = (src, code, re) => assert.throws(() => compile(src), (e) => e instanceof LanguageError && (!code || e.code === code) && (!re || re.test(e.message)), `expected ${code} ${re}`);

test("everything outside the declarative subset is refused with a line number", () => {
  fails(wrap(`import fs from "fs";`), "forbidden_syntax", /Only named imports/);
  fails(wrap(`import { x } from "fs";`), "forbidden_syntax", /Only @vyre\/sdk can be imported/);
  fails(`import { defineKit } from "@vyre/sdk"; const x = require("fs");`, "forbidden_syntax");
  fails(kitOf("const y = import('fs');"), "forbidden_syntax", /Dynamic import/);
  fails(kitOf("export const q = process.env.HOME;"), "forbidden_syntax");
  fails(kitOf("for (;;) {}"), "forbidden_syntax", /not allowed at the top level/);
  fails(kitOf("const f = () => 1;"), "forbidden_syntax");
  fails(kitOf("const z = new Date();"), "forbidden_syntax");
  fails(kitOf("const z = `a${1}b`;"), "forbidden_syntax", /\$\{/);
  fails(kitOf("const z = { ...A };"), "forbidden_syntax");
  fails(kitOf("export { A } from './x';"), "forbidden_syntax");
  fails(kitOf("// @ts-ignore\nconst z = 1;"), "forbidden_syntax", /pragmas/);
  fails(kitOf("/// <reference path='/etc/passwd' />"), "forbidden_syntax");
  fails(kitOf("const z = { __proto__: 1 };"), "forbidden_syntax");
  fails(kitOf("const z = A.fields;"), "forbidden_syntax", /Property access/);
  fails(kitOf("const z: number = 1;"), "forbidden_syntax", /annotations/);
  fails(kitOf("const z = 'a\\u0041';"), "forbidden_syntax");
  fails(kitOf("const z = [1, 2,"), "syntax");
  const e = (() => { try { compile(kitOf("const z = eval('1');")); } catch (x) { return x; } })();
  assert.equal(e.code, "forbidden_syntax");
  assert.equal(typeof e.line, "number");
});

test("calls only reach the SDK, and only if imported", () => {
  fails(wrap(`export const A = defineType({ name: "a", fields: { t: defineField.text() } });\nexport default defineKit({ id: "k", version: 1, includes: [A] });\nexport const B = notThere();`), "unknown_function");
  fails(`export default defineKit({ id: "k", version: 1, includes: [] });`, "unknown_function", /not imported/);
  fails(kitOf("const z = defineField.constructor();"), "unknown_function");
  fails(kitOf("const z = defineField.toString();"), "unknown_function");
  fails(kitOf("const z = Undefined;"), "unknown_reference");
});

test("limits: size, depth, nodes and string length are errors, not slow requests", () => {
  assert.throws(() => compile("x".repeat(1_100_000)), (e) => e.code === "limit_size");
  assert.throws(() => compile(kitOf(`const d = ${"[".repeat(60)}${"]".repeat(60)};`)), (e) => e.code === "limit_depth");
  assert.throws(() => compile(kitOf(`const d = [${"1,".repeat(60000)}];`)), (e) => e.code === "limit_nodes");
  assert.throws(() => compile(kitOf(`const d = "${"a".repeat(150000)}";`)), (e) => e.code === "limit_string" || e.code === "invalid_definition");
});

test("a hostile file cannot hold the daemon: the worker parse enforces the limits too", async () => {
  await assert.rejects(compileSafely("x".repeat(1_100_000)), (e) => e.code === "limit_size");
  const t0 = Date.now();
  await assert.rejects(compileSafely(kitOf(`const d = ${"[".repeat(100)}${"]".repeat(100)};`)), (e) => e.code === "limit_depth");
  assert.ok(Date.now() - t0 < 3000);
});

test("kit checks: references, sealed fields and expressions", () => {
  fails(kitOf("", 't: defineField.link({ to: "ghost" })'), "invalid_definition", /ghost/);
  fails(kitOf("", 't: defineField.link()'), "invalid_definition", /name/);
  fails(kitOf("", 't: defineField.ref({ to: "a" })'), "unknown_function");
  fails(wrap(`export const A = defineType({ name: "a", fields: { s: defineField.sealed({ class: "us-ssn" }) }, rules: [defineRule({ require: "s == 'x'" })] });\nexport default defineKit({ id: "k", version: 1, includes: [A] });`), "invalid_definition", /sealed and cannot be used/);
  fails(wrap(`export const A = defineType({ name: "a", fields: { t: defineField.text() }, rules: [defineRule({ require: "nope == 1" })] });\nexport default defineKit({ id: "k", version: 1, includes: [A] });`), "invalid_definition", /not a field/);
  fails(wrap(`export const A = defineType({ name: "a", fields: { t: defineField.text(), s: defineField.sealed({ class: "us-ssn" }) } });\nexport const T = defineTemplate({ name: "t", kind: "email", body: "SSN {{a.s}}" });\nexport default defineKit({ id: "k", version: 1, includes: [A, T] });`), "invalid_definition", /sealed:/);
  fails(wrap(`export const A = defineType({ name: "a", fields: { t: defineField.text(), st: defineStage([{ name: "x", tasks: [defineTask({ title: "t1", doer: "teammate:ghost", output: { kind: "note" } })] }, "y"]) } });\nexport default defineKit({ id: "k", version: 1, includes: [A] });`), "invalid_definition", /teammate role/);
  fails(wrap(`export const A = defineType({ name: "a", fields: { t: defineField.text(), s: defineField.sealed({ class: "us-ssn" }), st: defineStage([{ name: "x", tasks: [defineTask({ title: "t1", doer: "person:alex", output: { kind: "fields", target: ["s"] } })] }, "y"]) } });\nexport default defineKit({ id: "k", version: 1, includes: [A] });`), "invalid_definition", /sealed field/);
});

test("builder checks give the author a path and a plain sentence", () => {
  fails(kitOf("", 'Bad_Name: defineField.text()'), "invalid_definition", /lowercase/);
  fails(kitOf("", 't: defineField.text({ colour: 1 })'), "invalid_definition", /Unknown option "colour"/);
  fails(kitOf("", 't: defineField.choice(["a", "a"])'), "invalid_definition", /different/);
  fails(kitOf("", 't: defineField.sealed({ class: "nope" })'), "invalid_definition", /Class must be/);
  fails(kitOf("", 't: defineField.sealed({ class: "us-ssn", level: "robot" })'), "invalid_definition", /Level must be/);
  fails(kitOf("", 't: defineField.text({ default: "x" })'), "invalid_definition", /Unknown option "default"/);
  fails(kitOf("", 'a: defineStage(["x"])'), "invalid_definition", /2 to 40/);
  fails(kitOf("", 'a: defineStage(["x", "x"])'), "invalid_definition", /Two stages/);
});

test("code step bodies are opaque strings, size capped and round-trip byte for byte", () => {
  const body = "const total = input.a + input.b; // */ `${not a template}`\nreturn { total };";
  const src = `import { defineKit, defineType, defineField, defineCodeStep } from "@vyre/sdk";\nexport const A = defineType({ name: "a", fields: { t: defineField.text() } });\nexport const C = defineCodeStep({ name: "sum", inputs: ["a", "b"], outputs: ["total"], body: ${JSON.stringify(body)} });\nexport default defineKit({ id: "k", version: 1, includes: [A, C] });`;
  const kit = compile(src);
  assert.equal(kit.codeSteps[0].body, body);
  assert.equal(compile(print(kit)).codeSteps[0].body, body);
  fails(src.replace(JSON.stringify(body), "`a${1}`"), "forbidden_syntax");
});

test("the checked-in stored kit is what the source compiles to, and its text is a fixed point", () => {
  const stored = JSON.parse(fs.readFileSync(new URL("../kits/estate-planning/kit.json", import.meta.url), "utf8"));
  assert.deepEqual(stored, compile(KIT_SRC), "regenerate with: node records/language/cli.js compile records/kits/estate-planning/kit.ts > records/kits/estate-planning/kit.json");
  assert.deepEqual(validateStored(stored), stored);
});

test("the kit's types are the kernel's TypeDefinition: every field has a label, the stage field and the stages agree, kinds are kernel kinds", async () => {
  const { FIELD_KINDS } = await import("../../kernel/contracts/index.js");
  const kit = compile(KIT_SRC);
  for (const t of kit.types) {
    assert.ok(t.label);
    for (const f of t.fields) { assert.ok(f.label, `${t.name}.${f.name} has a label`); assert.ok(FIELD_KINDS.includes(f.kind)); if (f.kind === "sealed") assert.ok(f.seal.class && f.seal.level); }
  }
});

test("conditional fields, stage entry conditions and stage sets compile, print and read back", () => {
  const src = wrap(`export const M = defineType({ name: "m", fields: {
  area: defineField.choice(["Personal Injury", "Estate Planning"]),
  accident_date: defineField.date({ visible_if: 'area == "Personal Injury"', required_if: 'area == "Personal Injury"' }),
  trust_name: defineField.text({ visible_if: 'area == "Estate Planning"' }),
  stage: defineStage(["Intake", { name: "Signed", enter_if: "not empty(area)" }], { sets: [
    { name: "pi", when: 'area == "Personal Injury"', stages: ["Intake", "Treating", "Demand", "Settled"] },
    { name: "ep", when: 'area == "Estate Planning"', stages: ["Intake", "Drafting", { name: "Signed", enter_if: "not empty(trust_name)" }] },
  ] }),
} });
export default defineKit({ id: "k", version: 1, includes: [M] });`);
  const kit = compile(src);
  const t = kit.types[0];
  assert.equal(t.fields.find((f) => f.name === "accident_date").visible_if, 'area == "Personal Injury"');
  assert.equal(t.fields.find((f) => f.name === "accident_date").required_if, 'area == "Personal Injury"');
  assert.deepEqual(t.fields.find((f) => f.kind === "stage").options, ["Intake", "Signed", "Treating", "Demand", "Settled", "Drafting"]);
  assert.equal(t.stage_sets.length, 2);
  assert.equal(t.stages[1].enter_if, "not empty(area)");
  const text = print(kit);
  assert.deepEqual(compile(text), kit);
  assert.equal(print(compile(text)), text);
});

test("conditional fields and stage sets are checked against the type", () => {
  fails(kitOf("", 't: defineField.text({ visible_if: "nope == 1" })'), "invalid_definition", /not a field of a/);
  fails(kitOf("", 't: defineField.text({ visible_if: "t == 1" })'), "invalid_definition", /cannot name the field it is on/);
  fails(kitOf("", 't: defineField.text({ required: true, required_if: "u == 1" }), u: defineField.text()'), "invalid_definition", /not both/);
  fails(kitOf("", 't: defineField.text({ required: true, visible_if: "u == 1" }), u: defineField.text()'), "invalid_definition", /required_if/);
  fails(kitOf("", 's: defineField.sealed({ class: "us-ssn" }), t: defineField.text({ visible_if: "s == 1" })'), "invalid_definition", /sealed/);
  fails(kitOf("", 'u: defineField.text(), st: defineStage(["A", "B"], { sets: [{ name: "x", when: \'st == "A"\', stages: ["A", "C"] }] })'), "invalid_definition", /not by its stage/);
});

test("the checked-in base kit is what its source compiles to, and its text is a fixed point", () => {
  const src = fs.readFileSync(new URL("../kits/base/kit.ts", import.meta.url), "utf8");
  const stored = JSON.parse(fs.readFileSync(new URL("../kits/base/kit.json", import.meta.url), "utf8"));
  assert.deepEqual(stored, compile(src), "regenerate with: node records/language/cli.js compile records/kits/base/kit.ts > records/kits/base/kit.json");
  assert.deepEqual(compile(print(stored)), stored);
});
