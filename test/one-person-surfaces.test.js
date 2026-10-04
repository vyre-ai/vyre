import "../scripts/mac-test-guard.mjs";
// The lead's ruling (5 Oct): there is ONE list of the person's surfaces, lib/person-surfaces.js (cli, local, deck, capsule); core/modules, core/presence and lib/caller.js take it from there, and a bare
// `mobile` label is not on it (the phone arrives as its paired device with a person session). Two lists is the same fault as two answers to "who is the person". The identity lists all come from the leaf. Callers
// lists that still spell the four names out WITH `mobile` (a label any caller can send, so it only lets a call reach the tool, never makes a person) are counted per file in test/one-person-surfaces.json: each owner
// drops `mobile` and imports the one list, and lowers the number; a new one fails. It only shrinks.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PERSON_SURFACES } from "../lib/caller.js";
import { PERSON_SURFACES as LEAF } from "../lib/person-surfaces.js";
import { SURFACE_LABELS } from "../core/modules/index.js";
import { PERSON_SURFACES as PRESENCE } from "../core/presence/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FOUR = ["cli", "local", "deck", "capsule"];
const THE_LEAF = "lib/person-surfaces.js";

test("core/modules, core/presence and lib/caller.js all hold the one list, and mobile is not on it", () => {
  assert.deepEqual([...LEAF], FOUR);
  assert.deepEqual([...PERSON_SURFACES], FOUR);
  assert.deepEqual([...SURFACE_LABELS], FOUR);
  assert.deepEqual([...PRESENCE].sort(), [...FOUR].sort());
  assert.ok(!LEAF.includes("mobile"));
});

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "image", "testing", "golden"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.m?js$/.test(e.name) && !/\.test\.m?js$/.test(e.name)) out.push(p);
  }
}
/** Array or Set literals (one logical statement may span lines) that name all four surfaces. @param {string} src */
export function lists(src) {
  const out = [];
  for (const m of src.matchAll(/(?:\[|new Set\(\[)([^\]\[]{0,400})\]/g)) {
    const body = m[1];
    // a vocabulary of every label (it also names mcp, harness or hook) is not a list of the person's surfaces
    if (FOUR.every(n => new RegExp(`["']${n}["']`).test(body)) && !/["'](?:mcp|harness|hook)["']/.test(body)) out.push({ body, mobile: /["']mobile["']/.test(body) });
  }
  return out;
}
const FROZEN = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "one-person-surfaces.json"), "utf8")).files;
test("callers lists that still name mobile with the four surfaces are frozen and only shrink (a bare mobile is no person; each owner drops it from their list)", () => {
  const files = [];
  for (const top of ["core", "local", "modules", "lib", "kernel"]) { const d = path.join(ROOT, top); if (fs.existsSync(d)) walk(d, files); }
  /** @type {Record<string, number>} */ const counts = {};
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    if (rel === THE_LEAF) continue;
    const n = lists(fs.readFileSync(f, "utf8")).filter(l => l.mobile).length;
    if (n) counts[rel] = n;
  }
  if (process.env.WRITE_FROZEN) fs.writeFileSync(path.join(ROOT, "test", "one-person-surfaces.json"), JSON.stringify({ files: counts }, null, 1) + "\n");
  const over = Object.entries(counts).filter(([f, n]) => n > (FROZEN[f] || 0)).map(([f, n]) => `${f}: ${n} (frozen ${FROZEN[f] || 0})`);
  assert.deepEqual(over, [], "a new list naming mobile: the phone is its paired device, not a label");
  const stale = Object.keys(FROZEN).filter(f => !counts[f] || counts[f] < FROZEN[f]).map(f => `${f}: ${counts[f] || 0} (frozen ${FROZEN[f]})`);
  assert.deepEqual(stale, [], "lower these numbers in test/one-person-surfaces.json (WRITE_FROZEN=1 rewrites it)");
});
