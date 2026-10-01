// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text } from "../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
/** @type {any} */ (globalThis).DOMParser = class { parseFromString() { return { documentElement: doc.createElement("svg") }; } };
const { providerMark, providerName, badgeSize } = await import("./provider-mark.js");

test("no provider, no badge: a turn that does not say who wrote it gets none", () => {
  assert.equal(providerMark(null), null);
  assert.equal(providerMark(""), null);
  assert.equal(providerMark(undefined, 20), null);
});

test("Claude, Codex, Grok and OpenRouter hold their own mark; an unknown provider gets a monogram", () => {
  const cl = /** @type {any} */ (providerMark("claude", 18)), cx = /** @type {any} */ (providerMark("Codex", 18)), or = /** @type {any} */ (providerMark("openrouter", 18));
  const gk = /** @type {any} */ (providerMark("grok", 18)), q = /** @type {any} */ (providerMark("mistral", 18));
  for (const e of [cl, cx, or, gk]) assert.match(e.getAttribute("class"), /pmark-art/);
  for (const e of [q]) assert.doesNotMatch(e.getAttribute("class"), /pmark-art/);
  assert.deepEqual([q].map(e => text(e)), ["Mi"]);
  assert.match(gk.getAttribute("class"), /pmark-two/, "xAI has a light and a dark logomark");
  assert.doesNotMatch(cl.getAttribute("class"), /pmark-two/, "Claude's spark is one colour on both themes");
  assert.match(cx.getAttribute("class"), /pmark-two/, "OpenAI has a white and a black variant");
  assert.match(or.getAttribute("class"), /pmark-two/);
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
