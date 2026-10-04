// @ts-check
// PLAN.md section 5, minimum 11: no internal words on any surface. The public site (vyre.run: the landing page, /start, /setup, the 404 page
// and llms.txt) never says "vyred", "switchboard", "no such tool" or "as Claude Code does": a person reads "Vyre", "the box", "sessions".
// The same word list as test/no-internal-words.test.js (native-core's, for the Deck). Generated and copied folders are not the site's copy.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "site");
const BANNED = /\b(vyred|switchboard|no such tool|as claude code does)\b/i;
const SKIP = new Set(["box", "relay", "deck", "fonts", "node_modules"]);

function* pages(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) yield* pages(p); continue; }
    if (/\.(html|txt|md|xml|webmanifest)$/.test(e.name) && !/\.test\./.test(e.name) && e.name !== "CHANGELOG.md") yield p;
  }
}

test("the public site's copy has no internal word (vyred, switchboard, no such tool, as Claude Code does)", () => {
  const bad = [];
  for (const f of pages(SITE)) {
    fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => { if (BANNED.test(line)) bad.push(`${path.relative(SITE, f)}:${i + 1}: ${line.trim().slice(0, 110)}`); });
  }
  assert.deepEqual(bad, [], `internal words on the site (say "Vyre", "the box", or what to do next):\n${bad.join("\n")}`);
});
