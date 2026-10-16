// @ts-check
// Item 1: operator card shows Glass live inline on every platform (no web-only gate, no still preview).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "app", "src", "chat", "OperatorCard.tsx");

test("operator card: live Glass inline, full-screen modal, no web-only gate or still preview", () => {
  const src = fs.readFileSync(CARD, "utf8");
  assert.ok(src.includes("LiveScreen"), "uses Glass live view");
  assert.ok(!src.includes("useStill"), "does not poll stills for the main picture");
  assert.ok(!src.includes("Platform.OS"), "no platform gate on live Glass");
  assert.match(src, /Open full screen/, "offers one-tap full viewport");
  assert.ok(src.includes("<Modal"), "full-screen path uses a modal");
});
