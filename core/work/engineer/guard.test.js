// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { declarativeGuard, MAX_CODE_STEP } from "./guard.js";

export const KIT = `import { defineKit, defineType, defineField, defineStage, defineTask, defineTemplate, defineRule, defineFlow } from '@vyre/sdk';

export const Matter = defineType({
  name: 'matter', label: 'Matter',
  fields: {
    client: defineField.link({ to: 'person' }),
    plan:   defineField.choice(['Will', 'Trust', 'Both']),
    ssn:    defineField.sealed({ class: 'us-ssn' }),
    stage:  defineStage([
      { name: 'Intake', tasks: [
        defineTask({ title: 'Research the client', doer: 'teammate:research', how: 'assistant', output: { fields: ['practice_area'], note: true } }),
        defineTask({ title: 'Welcome email', doer: 'teammate:intake', checker: 'role:attorney', how: 'tailor', template: 'welcome', output: { sent: 'email' }, dependsOn: ['Research the client'] }),
      ] },
      'Drafting', 'Signing',
    ]),
  },
  rules: [defineRule({ require: 'stage < "Drafting" or engagement_signed == true' })],
});

export const Welcome = defineTemplate({ name: 'welcome', kind: 'email', body: 'Dear {{client.name}}, welcome to Harlow Legal.' });
export const OnPayment = defineFlow({ name: 'On payment', on: { event: 'payment.received' }, steps: [{ create: 'project', fromKit: 'estate-planning' }] });
export default defineKit({ id: 'estate-planning', version: 3, includes: [Matter, Welcome, OnPayment] });
`;

const errs = (/** @type {string} */ s) => declarativeGuard(s).errors.map(e => `${e.line}:${e.msg}`);
const wrap = (/** @type {string} */ body) => `import { defineCodeStep } from '@vyre/sdk';\nexport const S = defineCodeStep({ name: 's', body: ${body} });\n`;

test("the spec's Kit text passes the guard", () => {
  assert.deepEqual(declarativeGuard(KIT), { ok: true, errors: [] });
});

test("rejections carry the line number", () => {
  assert.deepEqual(errs(`import { x } from 'fs';\n`), ["1:only @vyre/sdk may be imported"]);
  assert.match(errs(`import { defineType } from '@vyre/sdk';\nconst a = await import('x');`)[0], /^2:dynamic import/);
  assert.match(errs(`\n\nconst fs = require('fs');`)[0], /^3:require/);
  assert.match(errs(`export * from 'x';`)[0], /export from/);
  assert.match(errs(`export { a } from 'x';`)[0], /export from/);
  assert.deepEqual(errs(`export { a };\nexport const b = 1;`), []);
  assert.match(errs(`/// <reference path="x" />\n`)[0], /^1:a triple-slash/);
  assert.match(errs(`// @ts-ignore\nconst a = 1;`)[0], /^1:a ts pragma/);
  assert.match(errs(`/* @ts-nocheck */`)[0], /ts pragma/);
});

test("prototype keys, computed keys, spreads, getters and tagged templates are rejected", () => {
  assert.match(errs(`const a = { __proto__: null };`)[0], /__proto__/);
  assert.match(errs(`const a = { 'constructor': 1 };`)[0], /key constructor/);
  assert.match(errs(`const a = { x: 1, prototype: 2 };`)[0], /prototype/);
  assert.match(errs(`const a = { [k]: 1 };`)[0], /computed key/);
  assert.match(errs(`const a = { x: 1,\n [k]: 1 };`)[0], /^2:a computed key/);
  assert.deepEqual(errs(`const a = { x: [1, 2], y: ['a'] };`), []);
  assert.match(errs(`const a = { ...b };`)[0], /spread/);
  assert.match(errs(`const a = [...b];`)[0], /spread/);
  assert.match(errs(`const a = { get x() { return 1; } };`)[0], /getter or setter/);
  assert.match(errs(`const a = { set x(v) {} };`)[0], /getter or setter/);
  assert.deepEqual(errs(`const a = { get: 1, set: 2 };`), []);
  assert.match(errs("const a = tag`x`;")[0], /tagged template/);
  assert.match(errs("const a = f(1)`x`;")[0], /tagged template/);
  assert.match(errs("const a = `x ${y}`;")[0], /substitution/);
  assert.deepEqual(errs("const a = `plain text`;"), []);
});

test("E-3: a code step body with */, a backtick escape, import, require and a triple-slash directive neither ends the span nor trips the rejections", () => {
  const body = "`/// <reference path=\"x\" />\\n// @ts-nocheck\\nconst a = \\`x\\`; /* */ */\\nimport x from 'y'; const f = require('fs'); await import('z'); const o = { ...a, __proto__: 1, [k]: 2, get g() {} };\\n`";
  assert.deepEqual(declarativeGuard(wrap(body)), { ok: true, errors: [] });
  // The same text outside a span is rejected, and a clean line after the span is still checked.
  assert.equal(declarativeGuard(wrap(body) + "const bad = { ...x };\n").errors.length, 1);
  assert.match(errs(wrap(body) + "const bad = { ...x };\n")[0], /^3:a spread/);
});

test("a code step body as a single quoted string with escapes is also opaque", () => {
  assert.deepEqual(declarativeGuard(wrap(`'import x from \\'y\\'; require(1) */ \`'`)), { ok: true, errors: [] });
});

test("an oversize code step body, an unclosed span and an oversize file are refused", () => {
  const big = "`" + "x".repeat(MAX_CODE_STEP + 10) + "`";
  assert.match(errs(wrap(big))[0], /code step is over/);
  assert.match(errs("defineCodeStep({ body: `abc"[0] ? "defineCodeStep({ body: `abc" : "")[0], /never closed/);
  assert.match(errs("defineCodeStep({ body: 'abc' ")[0], /never closed/);
  assert.match(declarativeGuard("x".repeat(300_000)).errors[0].msg, /over 200000/);
  assert.equal(declarativeGuard(/** @type {any} */ (5)).ok, false);
});
