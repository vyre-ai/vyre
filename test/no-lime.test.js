// @ts-check
// The lime primary was retired on 30 Sep 2026 (the user picked Bone: no accent hue, cream is the
// primary on dark, ink on paper). No shipped file, spec or board may bring it back: not its hex,
// its washes, its paper green or the word. History (changelogs, work notes, ADRs) is exempt.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY = /^(CHANGELOG\.md|site\/CHANGELOG\.md|docs\/work\/|docs\/adr\/|test\/no-lime\.test\.js$|test\/test-counts\.json$)/;
// Named CSS colours in a colour parser are not the brand colour.
// The preview libraries Vyre ships (d3, chart.js, recharts, three) are third-party code built as they are, hash-pinned (core/previews/vendor-src): their CSS colour-name tables carry the word.
const KEEP = /^(local\/capsule\/native\/Sources\/Core\/Colour\.swift|core\/previews\/vendor\/[^/]+\.js)$/;
const OLD = new RegExp(
  ["c6" + "f36b", "d4" + "f88a", "46" + "700c", "rgba\\(\\s*198\\s*,\\s*243\\s*,\\s*107", "rgba\\(\\s*70\\s*,\\s*112\\s*,\\s*12\\s*,", "\\bli" + "me\\b"].join("|"), "i");

test("no lime: the retired primary is gone from every tracked file", () => {
  const ls = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  if (ls.status !== 0) return; // not a git checkout (a packed release): nothing to scan
  const hits = [];
  for (const f of ls.stdout.split("\0").filter(Boolean)) {
    if (HISTORY.test(f) || KEEP.test(f)) continue;
    if (!/\.(js|mjs|cjs|ts|tsx|json|md|html|css|svg|swift|kt|xml|yml|yaml|sh)$/.test(f)) continue;
    let text;
    try { text = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
    text.split("\n").forEach((line, i) => { if (OLD.test(line)) hits.push(`${f}:${i + 1}`); });
  }
  assert.deepEqual(hits, []);
});
