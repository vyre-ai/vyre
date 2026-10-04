// lib/theme: the token source and the theme rules as a pure library vyred runs (ADR 0033).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lib from "../lib/theme/index.js";
import * as scriptsTheme from "../scripts/lib/theme.js";
import * as scriptsTokens from "../scripts/lib/tokens.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("theme lib: tokens.json lives beside the lib and is the one source gen-tokens reads", async () => {
  assert.equal(lib.TOKENS_FILE, path.join(ROOT, "lib/theme/tokens.json"));
  assert.equal(scriptsTokens.TOKENS, lib.SOURCE);
  const { SOURCE } = await import("../scripts/gen-tokens");
  assert.equal(SOURCE, "lib/theme/tokens.json", "the app's own tokens test reads the source through SOURCE");
  assert.deepEqual(scriptsTokens.load(ROOT), lib.tokens());
  assert.ok(!fs.existsSync(path.join(ROOT, "docs/design/one-app/tokens.json")), "one source, not two");
});

test("theme lib: package.json ships lib", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("lib"));
});

test("theme lib: tokens() is a fresh copy each call", () => {
  const a = lib.tokens();
  a.color.dark.bg = "#000000";
  assert.equal(lib.tokens().color.dark.bg, "#0E0D0C");
});

test("theme lib: the scripts' paths are the lib's functions", () => {
  for (const k of ["applyOverride", "check", "contrast", "fromLegacy", "ALLOWED", "PAIRS"]) assert.equal(scriptsTheme[k], lib[k], k);
  assert.equal(scriptsTokens.rgba, lib.rgba);
});

test("theme lib: css() is the Deck's tokens.css with its own first line", () => {
  const t = lib.tokens();
  const deck = scriptsTokens.css(t);
  const mine = lib.css(t, "x");
  assert.equal(mine.split("\n").slice(1).join("\n"), deck.split("\n").slice(1).join("\n"));
  assert.equal(mine.split("\n")[0], "/* x */");
});

test("theme lib: version is a short stable hash that follows the tokens", () => {
  const t = lib.tokens();
  assert.match(lib.version(t), /^[0-9a-f]{12}$/);
  assert.equal(lib.version(t), lib.version(lib.tokens()));
  t.radius.card = 16;
  assert.notEqual(lib.version(t), lib.version(lib.tokens()));
});

test("theme lib: an override that is not an object, or a list of the wrong kind, is refused", () => {
  const base = lib.tokens();
  assert.deepEqual(lib.applyOverride(base, [1]).problems, ["an override must be an object shaped like tokens.json"]);
  assert.ok(lib.applyOverride(base, { space: ["4px"] }).problems.includes("space must be a list of numbers"));
  assert.ok(lib.applyOverride(base, { color: { dark: "x" } }).problems.includes("color.dark must be an object"));
  assert.ok(lib.applyOverride(base, { color: { dark: { bg: 5 } } }).problems.includes("color.dark.bg: 5 is not a colour"));
});

test("theme lib: legacy names without dashes and the old dark swatches map to roles", () => {
  const base = lib.tokens();
  const { override, unknown } = lib.fromLegacy({
    dark: { graphite: "#050505", "text-2": "#BBBBBB", recall: "#EBC76B", signal: "#AAEE66" },
    light: { "rule-strong": "#C0C0C0", "beacon-ink": "#5B3FC4" },
  }, base);
  assert.deepEqual(unknown, ["recall"]);
  assert.deepEqual(override.color.dark, { bg: "#050505", primaryBg: "#AAEE66", focus: "#AAEE66", markDot: "#AAEE66", text2: "#BBBBBB" });
  assert.deepEqual(override.color.paper, { ruleStrong: "#C0C0C0", beacon: "#5B3FC4" });
  assert.deepEqual(lib.applyOverride(base, override).problems, []);
});

test("theme lib: a role config names itself beats the swatch that paints it", () => {
  const { override } = lib.fromLegacy({ dark: { bg: "#010101", graphite: "#020202" } }, lib.tokens());
  assert.equal(override.color.dark.bg, "#010101");
});
