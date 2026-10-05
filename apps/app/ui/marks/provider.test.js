import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { badgeLabel, badgeSize, providerArt, providerMono, providerName, providerOfModel } from "./provider.js";

test("a known provider has its own mark in both schemes; an unknown one has a monogram and none has nothing", () => {
  for (const p of ["claude", "codex", "openrouter", "grok"]) { assert.ok(providerArt(p, "dark")?.startsWith("<svg"), p); assert.ok(providerArt(p, "paper")?.startsWith("<svg"), p); }
  assert.equal(providerArt("mistral"), null);
  assert.equal(providerArt(null), null);
  assert.equal(providerMono("mistral"), "Mi");
  assert.equal(providerMono("codex"), "Cx");
  assert.equal(providerName("codex"), "Codex");
  assert.equal(providerName(""), "");
});

test("a model's name says its provider only when it really does", () => {
  assert.equal(providerOfModel("Sonnet 5.5"), "claude");
  assert.equal(providerOfModel("gpt-5"), "codex");
  assert.equal(providerOfModel("Grok 4"), "grok");
  assert.equal(providerOfModel("Local"), null);
  assert.equal(providerOfModel(null), null);
});

test("the badge is 55 percent of the avatar, never under 12, and says who wrote the reply", () => {
  assert.equal(badgeSize(32), 18);
  assert.equal(badgeSize(16), 12);
  assert.equal(badgeLabel("claude", "Sonnet 5.5"), "Written by Claude, Sonnet 5.5");
});
