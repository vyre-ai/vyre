import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LOOKS, lookOwner, showingLine, themeFor } from "./spaces.js";

test("all spaces shows Mine's look", () => {
  assert.equal(lookOwner("all"), "mine");
  assert.equal(lookOwner("harlow"), "harlow");
  assert.equal(themeFor("all", DEFAULT_LOOKS).accent, "violet");
});

test("each space gives its own accent and density", () => {
  const t = themeFor("harlow", DEFAULT_LOOKS);
  assert.equal(t.accent, "amber");
  assert.equal(t.density, "compact");
});

test("switching clears a custom hex that the next space does not have", () => {
  const looks = { ...DEFAULT_LOOKS, mine: { ...DEFAULT_LOOKS.mine, accent: "custom", hex: "#7AA2F7" } };
  assert.equal(themeFor("mine", looks).hex, "#7AA2F7");
  assert.equal(themeFor("harlow", looks).hex, undefined);
  assert.ok("hex" in themeFor("harlow", looks));
});

test("an unknown space falls back to Mine's look", () => {
  assert.equal(themeFor("nowhere", DEFAULT_LOOKS).accent, "violet");
});

test("the showing line names the space and every setting", () => {
  const line = showingLine("Harlow Legal", { accent: "amber", density: "compact", font: "sans", corners: "default" }, { sans: "Instrument Sans" }, true);
  assert.equal(line, "Harlow Legal with accent amber, compact density, Instrument Sans, default corners (some of it is your own override).");
});
