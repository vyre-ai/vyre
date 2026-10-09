// @ts-check
// The gallery's fixtures are valid screens in every form, and every block type is either drawn by the app's renderer or named here as still to come, so a gap is a decision and never a surprise.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { BLOCKS, validateScreen } from "./blocks.js";
import { fixtures } from "./fixtures.js";

/** Block types the app does not draw yet (waves 3 and 4). Shrinking this list is the work; growing it needs a reason. */
const NOT_DRAWN = ["calendar", "stages", "people", "activity", "approval", "gallery", "map", "filter"];

test("fixtures: every fixture is a valid screen in each surface's form, and the generated file is current", () => {
  const all = fixtures();
  for (const [id, f] of Object.entries(all)) for (const [form, screen] of Object.entries(f.screens)) assert.deepEqual(validateScreen(screen), [], `${id} ${form}`);
  assert.ok(all["block-stats"] && all.desk && all.record && all.numbers);
  const file = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../apps/app/ui/blocks/fixtures.generated.json", import.meta.url)), "utf8"));
  assert.deepEqual(Object.keys(file.fixtures), Object.keys(all), "run: node scripts/gen-gallery");
});

test("fixtures: the renderer draws every block type except the ones named as still to come", () => {
  const src = fs.readFileSync(fileURLToPath(new URL("../../apps/app/ui/blocks/BlockHost.tsx", import.meta.url)), "utf8");
  const drawn = [...(/const DRAW[\s\S]*?> = \{([\s\S]*?)\n\};/.exec(src)?.[1] || "").matchAll(/\b([a-z]+): \(p\)/g)].map(m => m[1]);
  const missing = Object.keys(BLOCKS).filter(t => !drawn.includes(t)).sort();
  assert.deepEqual(missing, [...NOT_DRAWN].sort());
});
