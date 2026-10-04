// Theme overrides (ADR 0033): merged over tokens.json, refused whole when a rule breaks.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "../scripts/lib/tokens.js";
import { applyOverride, check, fromLegacy, contrast } from "../scripts/lib/theme.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = load(ROOT);

test("theme: the shipped tokens keep every rule", () => {
  assert.deepEqual(check(base), []);
});

test("theme: a good override merges by key and replaces arrays", () => {
  const { tokens, problems } = applyOverride(base, {
    $schema: "ignored",
    color: { dark: { bg: "#000000" } },
    font: { sans: "Inter Tight" },
    type: { mono: [12, 14] },
    radius: { card: 16 },
  });
  assert.deepEqual(problems, []);
  assert.equal(tokens.color.dark.bg, "#000000");
  assert.equal(tokens.color.dark.panel, base.color.dark.panel);
  assert.equal(tokens.font.mono, base.font.mono);
  assert.deepEqual(tokens.type.mono, [12, 14]);
  assert.equal(tokens.radius.card, 16);
  assert.equal(base.color.dark.bg, "#0E0D0C", "the shipped tokens are not changed");
});

test("theme: a text colour under AA is refused with the pair named", () => {
  const { problems } = applyOverride(base, { color: { dark: { label: "#3A3733" } } });
  assert.ok(problems.some(p => /^dark: label on bg is .*needs 4\.5:1$/.test(p)), problems.join("\n"));
});

test("theme: the focus ring must keep 3:1", () => {
  const { problems } = applyOverride(base, { color: { paper: { focus: "#EEEAE2" } } });
  assert.ok(problems.some(p => p.startsWith("paper: focus on bg")), problems.join("\n"));
});

test("theme: the attention colour cannot be reused", () => {
  const { problems } = applyOverride(base, { color: { dark: { beacon: "#F1EEE6" } } });
  assert.ok(problems.some(p => p.includes("beacon (attention) is reused as primaryBg")), problems.join("\n"));
});

test("theme: status, layout, icon, new roles and new keys are refused", () => {
  const { problems } = applyOverride(base, {
    status: { order: [] }, layout: { rail: 10 }, icon: { stroke: 2 },
    color: { dark: { brand: "#123456" }, attentionAlt: {} },
    radius: { huge: 40 },
  });
  for (const p of ["status may not be overridden", "layout may not be overridden", "icon may not be overridden",
    "color.dark.brand is not a colour role", "color.attentionAlt may not be overridden", "radius.huge is not a token"])
    assert.ok(problems.includes(p), p);
});

test("theme: text under 12 and touch targets under 44 are refused", () => {
  const { problems } = applyOverride(base, { type: { mono: [11, 13] }, control: { touch: 40 } });
  assert.ok(problems.includes("type: 11 is under the 12 pt minimum"));
  assert.ok(problems.includes("control.touch: 40 is under the 44 pt touch target"));
});

test("theme: wrong value types are refused", () => {
  const { problems } = applyOverride(base, { radius: { card: "12px" }, space: 4, color: { dark: { bg: "black" } } });
  assert.ok(problems.includes("radius.card must be a number"));
  assert.ok(problems.includes("space must be a list"));
  assert.ok(problems.includes('color.dark.bg: "black" is not a colour'));
});

test("theme: the legacy config.theme.colors maps CSS names to roles", () => {
  const { override, unknown } = fromLegacy({ dark: { "--bg": "#000000", "--text-2": "#BBBBBB", "--beacon-dot": "#B8A4FF" }, light: { "--rule-strong": "#C0C0C0" } });
  assert.deepEqual(unknown, []);
  assert.deepEqual(override.color.dark, { bg: "#000000", text2: "#BBBBBB", beacon: "#B8A4FF" });
  assert.deepEqual(override.color.paper, { ruleStrong: "#C0C0C0" });
  assert.deepEqual(applyOverride(base, override).problems, []);
});

test("theme: contrast composites a wash over its ground", () => {
  const r = contrast(base.color.dark.text, base.color.dark.signalWash, base.color.dark.panel);
  assert.ok(r > 10, String(r));
});
