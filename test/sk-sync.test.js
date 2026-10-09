// @ts-check
// The extension's credential-shapes and site-knowledge copies are generated from lib/ (scripts/sync-sk.mjs). Hand-edit one, or change lib/ without running the script, and this fails.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skFiles } from "../scripts/sync-sk.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the extension's shared/sk copies are exactly what scripts/sync-sk.mjs generates", () => {
  for (const [p, want] of Object.entries(skFiles())) {
    const have = fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p), "utf8") : null;
    assert.equal(have, want, `${p} has drifted from lib/: run node scripts/sync-sk.mjs`);
  }
});

test("shared/sk holds nothing but the generated files", () => {
  const dir = path.join(ROOT, "local/hands-chrome-mac/extension/shared/sk");
  assert.deepEqual(fs.readdirSync(dir).sort(), Object.keys(skFiles()).map(p => path.basename(p)).sort());
});
