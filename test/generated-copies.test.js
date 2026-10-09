// @ts-check
// Copies that must live where they cannot import lib/ (the extension's credential shapes and site knowledge, the computers image's WebSocket framing) are generated from lib/ by scripts/sync-copies.mjs.
// Hand-edit one, or change lib/ without running the script, and this fails.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatedFiles } from "../scripts/sync-copies.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every generated copy is exactly what scripts/sync-copies.mjs generates", () => {
  for (const [p, want] of Object.entries(generatedFiles())) {
    const have = fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p), "utf8") : null;
    assert.equal(have, want, `${p} has drifted from lib/: run node scripts/sync-copies.mjs`);
  }
});

test("shared/sk holds nothing but the generated files", () => {
  const dir = path.join(ROOT, "local/hands-chrome-mac/extension/shared/sk");
  const all = (/** @type {string} */ d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? all(path.join(d, e.name)) : [path.relative(dir, path.join(d, e.name))]));
  assert.deepEqual(all(dir).sort(), Object.keys(generatedFiles()).filter(p => p.startsWith("local/hands-chrome-mac/extension/shared/sk/")).map(p => p.slice("local/hands-chrome-mac/extension/shared/sk/".length)).sort());
});
