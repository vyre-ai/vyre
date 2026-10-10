// @ts-check
// The Glass page the phone loads with no address (src/glass/frame-page.generated.ts): current with its sources, self-contained (no script, style or address of the box's), and a module script that names nothing outside it.
import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generate, OUT } from "../../../../scripts/gen-glass-page.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

test("the bundled Glass page is what the generator makes from frame.html, frame.js and the vendored noVNC", async () => {
  assert.equal(fs.readFileSync(path.join(ROOT, OUT), "utf8"), await generate(), "run node scripts/gen-glass-page.mjs");
});

test("the page is one document: its only script is inline, it loads nothing by address, and it opens no socket of its own before the app tells it", async () => {
  const mod = await import(path.join(ROOT, OUT));
  const html = String(mod.FRAME_PAGE);
  assert.match(html, /<script type="module">/);
  assert.doesNotMatch(html, /<script[^>]*\ssrc=/, "no script by address");
  assert.doesNotMatch(html, /<link[^>]*href=/, "no style by address");
  assert.doesNotMatch(html, /\bfrom\s*["']\.{1,2}\//, "no import left unresolved");
  assert.ok(html.length > 100_000, "noVNC is in it");
});
