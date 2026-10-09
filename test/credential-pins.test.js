// @ts-check
// R031-00c: two redactors cannot import lib/credential-shapes.js (the phone app's bundle, and the copy generated into the Chrome extension). Instead of letting them drift, this pins them: every sample
// token of a shape the table knows is hidden by the table AND by each of them. Samples are built at run time from parts, so no scanner sees a key in the source.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redact as tableRedact } from "../lib/credential-shapes.js";
import { text as siteRedact } from "../lib/siteops/redact.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const rep = (/** @type {string} */ c, /** @type {number} */ n) => c.repeat(n);
/** [name, sample]: one per shape family both redactors must hide. */
const SAMPLES = [
  ["github", "gh" + "p_" + rep("a", 36)],
  ["github-pat", "github_" + "pat_" + rep("b", 22) + "_" + rep("g", 59)],
  ["slack", "xo" + "xb-" + "1234567890-" + rep("c", 12)],
  ["anthropic", "sk-" + "ant-api03-" + rep("e", 30)],
  ["stripe-live", "sk" + "_live_" + rep("f", 20)],
];

/** The app's redactor, evaluated from its own source (it is TypeScript; this file reads the array literal). */
function appRedact() {
  const src = fs.readFileSync(path.join(ROOT, "apps/app/screens/connections/model.ts"), "utf8");
  const m = /const SHAPES = (\[[\s\S]*?\]);\n/.exec(src);
  assert.ok(m, "the app's SHAPES array is where this test looks for it");
  const shapes = /** @type {RegExp[]} */ (new Function(`return ${m[1]};`)());
  return (/** @type {string} */ s) => shapes.reduce((t, re) => t.replace(new RegExp(re.source, re.flags), "[hidden]"), s);
}

test("the table, the siteops redactor (and so the extension copy) and the app's redactor all hide the same sample tokens", () => {
  const app = appRedact();
  for (const [name, token] of SAMPLES) {
    const text = `before ${token} after`;
    assert.ok(!tableRedact(text).includes(token), `the table hides ${name}`);
    assert.ok(!String(siteRedact(text)).includes(token), `siteops hides ${name}`);
    assert.ok(!app(text).includes(token), `the app hides ${name}`);
  }
});
