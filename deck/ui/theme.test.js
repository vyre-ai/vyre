// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveTheme, applyTheme, ACCENTS } from "./theme.js";
import { ratio } from "../../lib/theme/contrast.js";

test("theme: defaults are violet, default density, sans, default corners, dark", () => {
  const r = resolveTheme();
  assert.equal(r.scheme, "dark");
  assert.equal(r.accent, ACCENTS.violet.dark);
  assert.deepEqual([r.density, r.font, r.corners], ["default", "sans", "default"]);
  assert.equal(r.tint, r.accent, "the row tint follows the accent unless a space sets its own");
});

test("theme: the space sets the look, and the person wins only for what is theirs", () => {
  const space = { accent: "amber", density: "compact", font: "serif", corners: "round", tint: "sky" };
  const r = resolveTheme({ space, person: { theme: "paper", density: "comfortable" }, system: "dark" });
  assert.equal(r.scheme, "paper");
  assert.equal(r.accent, ACCENTS.amber.paper);
  assert.equal(r.tint, ACCENTS.sky.paper);
  assert.equal(r.density, "comfortable", "the person's own density");
  assert.equal(r.font, "serif", "the space's font stays when the person sets none");
  assert.equal(r.corners, "round", "corners are the space's alone");
  assert.deepEqual(r.own, ["density"]);
  assert.equal(resolveTheme({ person: { theme: "system" }, system: "paper" }).scheme, "paper");
});

test("theme: a custom accent that fails contrast is replaced by the nearest that passes, and says so", () => {
  const dark = resolveTheme({ space: { accent: "custom", hex: "#1A1A1A" } });
  assert.ok(ratio(dark.accent, "#141311") >= 4.5);
  assert.match(String(dark.note), /too low in contrast/);
  const ok = resolveTheme({ space: { accent: "custom", hex: "#7AA2F7" } });
  assert.equal(ok.accent, "#7AA2F7");
  assert.equal(ok.note, null);
  const paper = resolveTheme({ space: { accent: "custom", hex: "#7AA2F7" }, person: { theme: "paper" } });
  assert.ok(ratio(paper.accent, "#F4F1EA") >= 4.5);
  assert.equal(resolveTheme({ space: { accent: "custom", hex: "not a colour" } }).accent, ACCENTS.violet.dark, "a bad hex falls back to the default");
});

test("theme: the ink is picked by luminance", () => {
  assert.equal(resolveTheme({ space: { accent: "violet" } }).accentInk, "#0E0D0C");
  assert.equal(resolveTheme({ space: { accent: "sky" }, person: { theme: "paper" } }).accentInk, "#FFFFFF");
});

test("theme: applyTheme writes attributes and custom properties", () => {
  /** @type {any} */ const root = { dataset: {}, style: { props: /** @type {Record<string,string>} */ ({}), setProperty(/** @type {string} */ k, /** @type {string} */ v) { this.props[k] = v; } },
    toggleAttribute(/** @type {string} */ k, /** @type {boolean} */ on) { (this.attrs ||= {})[k] = on; } };
  applyTheme(root, resolveTheme({ space: { accent: "rose", density: "compact" }, person: { reducedMotion: true } }));
  assert.equal(root.dataset.density, "compact");
  assert.equal(root.dataset.theme, undefined, "dark has no theme attribute");
  assert.equal(root.style.props["--accent"], ACCENTS.rose.dark);
  assert.equal(root.attrs["data-reduced-motion"], true);
  applyTheme(root, resolveTheme({ person: { theme: "paper" } }));
  assert.equal(root.dataset.theme, "paper");
});
