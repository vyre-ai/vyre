// @ts-check
// No "Deck" in the docs (user decision, 5 Oct 2026: the Deck is removed in 0.2.9; the Vyre app replaces it). Every docs page that people read says "the Vyre app".
// Exempt: history and decisions (ADRs, design docs, work logs, proposals, release notes), and docs/reference, which is generated from the descriptions in the code
// (the code's own wording is the cleanup team's; the reference follows it when `npm run docs:ref` runs).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORD = /\bDecks?\b/;
const EXEMPT = [/^docs\/(adr|design|work|proposals|releases|reference)\//, /^docs\/(nav|index|shots)\.json$/];

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (e.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

test("no Deck in the docs people read: the Vyre app replaced it", () => {
  const hits = [];
  for (const rel of walk("docs", [])) {
    if (EXEMPT.some(r => r.test(rel))) continue;
    const lines = fs.readFileSync(path.join(REPO, rel), "utf8").split("\n");
    lines.forEach((l, i) => { if (WORD.test(l)) hits.push(`${rel}:${i + 1}: ${l.trim().slice(0, 80)}`); });
  }
  assert.deepEqual(hits, [], `write "the Vyre app" instead of the Deck:\n${hits.join("\n")}`);
});
