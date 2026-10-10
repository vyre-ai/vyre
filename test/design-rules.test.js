// R031-58 (the design checker): the app's screens take colour, type and layout from @vyre/ui and its tokens. apps/app/scripts/check-design-rules.mjs counts the literals, StyleSheets and second-primitive
// imports per file; design-rules.baseline.json holds what is there today. A file may not go over its count and a file not in the baseline may not start, so the look stays one look without a reviewer.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scan, problems, stale, readBaseline } from "../apps/app/scripts/check-design-rules.mjs";

test("design rules: no screen is over its baseline (a literal colour, a hand-set font, a StyleSheet, a second primitive); fix the screen, never raise the baseline", () => {
  assert.deepEqual(problems(scan(), readBaseline()), [], "use @vyre/ui and its tokens: see the rule list at the top of apps/app/scripts/check-design-rules.mjs");
});

test("design rules: the baseline names only files that still break a rule at that count or fewer (entries the code outgrew are named, lowered with --update)", () => {
  const old = stale(scan(), readBaseline());
  if (old.length) console.log(`design rules: ${old.length} baseline entries can go down (node apps/app/scripts/check-design-rules.mjs --update):\n  ${old.join("\n  ")}`);
  const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "app");
  const baseline = readBaseline();
  for (const [file, counts] of Object.entries(baseline)) assert.ok(fs.existsSync(path.join(APP, file)), `${file} is in the baseline but gone: run check-design-rules.mjs --update`), assert.ok(Object.values(counts).every((n) => /** @type {number} */ (n) > 0));
});
