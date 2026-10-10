// @ts-check
// R031-00c: two redactors cannot import lib/credential-shapes.js (the phone app's bundle, and the copy generated into the Chrome extension). Instead of letting them drift, this pins them: every sample
// token of a shape the table knows is hidden by the table AND by each of them. Samples are built at run time from parts, so no scanner sees a key in the source.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redact as tableRedact, SHAPES } from "../lib/credential-shapes.js";
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

/** The app's own redactor (screens/connections/model.ts), imported as the app imports it. */
async function appRedact() {
  const { redact } = await import("../apps/app/screens/connections/model.ts");
  return (/** @type {string} */ s) => redact(s);
}

test("the table, the siteops redactor (and so the extension copy) and the app's redactor all hide the same sample tokens", async () => {
  const app = await appRedact();
  for (const [name, token] of SAMPLES) {
    const text = `before ${token} after`;
    assert.ok(!tableRedact(text).includes(token), `the table hides ${name}`);
    assert.ok(!String(siteRedact(text)).includes(token), `siteops hides ${name}`);
    assert.ok(!app(text).includes(token), `the app hides ${name}`);
  }
});

/**
 * One string a shape's whole-value pattern accepts, built from the pattern itself (literals, escapes, character classes, groups with alternatives, counted repeats): the samples above are five of the table's
 * shapes; these are every one, so a shape added to the table is pinned by the same test without anyone writing a sample.
 * @param {RegExp} re
 */
export function sampleOf(re) {
  const src = re.source.replace(/^\^/, "").replace(/\$$/, "");
  let i = 0;
  const CH = (/** @type {number} */ n) => String.fromCharCode(n);
  const classChars = () => {
    /** @type {string[]} */ const out = [];
    i++; // [
    while (src[i] !== "]") {
      let c = src[i];
      if (c === "\\") { i++; c = src[i]; if (c === "w") { out.push(..."aZ09_"); i++; continue; } if (c === "d") { out.push(..."0123"); i++; continue; } }
      if (src[i + 1] === "-" && src[i + 2] !== "]") { const a = c.charCodeAt(0), b = src[i + 2].charCodeAt(0); for (let k = a; k <= b; k++) out.push(CH(k)); i += 3; continue; }
      out.push(c); i++;
    }
    i++; // ]
    return out;
  };
  /** @param {string[]} pool @param {number} n */
  // a real token ends in a letter or a digit and is not as short as its shape allows: the last character is alphanumeric, and an open-ended repeat is at least 36 long
  const pick = (pool, n) => { const out = Array.from({ length: n }, (_, k) => pool[(k * 7 + 3) % pool.length]); const a = pool.find(c => /[A-Za-z0-9]/.test(c)); if (a && n > 1 && !/[A-Za-z0-9]/.test(out[n - 1])) out[n - 1] = a; return out.join(""); };
  const quant = () => {
    if (src[i] === "{") { const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i)); if (!m) return 1; i += m[0].length; const lo = Number(m[1]); return m[2] !== undefined && m[3] === "" ? Math.max(lo, 36) : lo; }
    if (src[i] === "+") { i++; return 1; }
    return 1;
  };
  const seq = (/** @type {string} */ stop) => {
    let out = "";
    while (i < src.length && !stop.includes(src[i])) {
      let piece;
      if (src[i] === "(") { i++; if (src[i] === "?" && src[i + 1] === ":") i += 2; const alts = [seq("|)")]; while (src[i] === "|") { i++; alts.push(seq("|)")); } i++; piece = () => alts[0]; const n = quant(); out += piece().repeat(n); continue; }
      if (src[i] === "[") { const pool = classChars(); const n = quant(); out += pick(pool, n); continue; }
      if (src[i] === "\\") { const c = src[i + 1]; i += 2; const lit = c === "d" ? "4" : c === "w" ? "a" : c; const n = quant(); out += lit.repeat(n); continue; }
      const lit = src[i++]; const n = quant(); out += lit.repeat(n);
    }
    return out;
  };
  return seq("");
}

test("every shape in the table, sampled from its own pattern, is hidden by the table, siteops and the app's redactor, and the sampler's strings are accepted by the shape", async () => {
  const app = await appRedact();
  let checked = 0;
  /** @type {string[]} */ const missed = [];
  for (const shape of SHAPES) {
    if (!shape.value || shape.secret === false) continue;
    const token = sampleOf(shape.value);
    assert.ok(shape.value.test(token), `the sample for ${shape.id} (${token.slice(0, 12)}…) is accepted by its own shape`);
    const text = `before ${token} after`;
    checked++;
    const hidden = (/** @type {string} */ out) => !out.includes(token);
    if (!hidden(tableRedact(text))) missed.push(`${shape.id}: table`);
    if (!hidden(String(siteRedact(text)))) missed.push(`${shape.id}: siteops`);
    if (!hidden(app(text))) missed.push(`${shape.id}: app`);
  }
  assert.ok(checked >= 40, `${checked} shapes sampled`);
  assert.deepEqual(missed, [], "a redactor lets a token of a known shape through");
});
