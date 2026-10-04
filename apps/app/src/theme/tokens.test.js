// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generate, SOURCE } from "../../../../scripts/gen-tokens";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

test("tokens: the committed tokens.ts is what scripts/gen-tokens writes from tokens.json", () => {
  for (const [rel, body] of Object.entries(generate()))
    assert.equal(fs.readFileSync(path.join(REPO, rel), "utf8"), body, `${rel} is stale; run node scripts/gen-tokens`);
});

test("tokens: attention is violet in both schemes and no coral is left", () => {
  const t = JSON.parse(fs.readFileSync(path.join(REPO, SOURCE), "utf8"));
  assert.equal(t.color.dark.beacon, "#B8A4FF");
  assert.equal(t.color.paper.beacon, "#5B3FC4");
  const ts = fs.readFileSync(path.join(REPO, "apps/app/src/theme/tokens.ts"), "utf8");
  assert.doesNotMatch(ts, /coral|#FF6B4A|#E8573A/i);
});
