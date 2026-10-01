// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text } from "../test/fake-dom.js";

install();
const { providerMark, providerName, badgeSize } = await import("./provider-mark.js");

test("no provider, no badge: a turn that does not say who wrote it gets none", () => {
  assert.equal(providerMark(null), null);
  assert.equal(providerMark(""), null);
  assert.equal(providerMark(undefined, 20), null);
});

test("each known provider has its own shape and monogram; an unknown one is a circle with its first two letters", () => {
  const cl = /** @type {any} */ (providerMark("claude", 18)), cx = /** @type {any} */ (providerMark("Codex", 18)), gk = /** @type {any} */ (providerMark("grok", 18)), q = /** @type {any} */ (providerMark("mistral", 18));
  assert.deepEqual([cl, cx, gk, q].map(e => e.getAttribute("class").split(" ")[1]), ["pmark-circle", "pmark-square", "pmark-drop", "pmark-circle"]);
  assert.deepEqual([cl, cx, gk, q].map(e => text(e)), ["Cl", "Cx", "Gk", "Mi"]);
});

test("the accessible name says who wrote it, with the model when known", () => {
  assert.equal(/** @type {any} */ (providerMark("codex", 18, { model: "GPT-5" })).getAttribute("aria-label"), "Written by Codex, GPT-5");
  assert.equal(/** @type {any} */ (providerMark("grok")).getAttribute("aria-label"), "Written by Grok");
  assert.equal(providerName("codex"), "Codex");
  assert.equal(providerName("mistral"), "Mistral");
});

test("beside an avatar the badge is 55 percent of it and never under 12", () => {
  assert.deepEqual([28, 40, 24, 16].map(badgeSize), [15, 22, 13, 12]);
});
