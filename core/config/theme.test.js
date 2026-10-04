// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { themeCss } from "./theme.js";

test("theme: config colours become custom properties, dark on :root and light on paper", () => {
  const css = themeCss({ dark: { signal: "#B4E35A", "rule-strong": "rgba(255,255,255,0.2)" }, light: { bg: "#FFFDF8" } });
  assert.match(css, /:root \{\n  --signal: #B4E35A;\n  --rule-strong: rgba\(255,255,255,0.2\);\n/);
  assert.match(css, /:root\[data-theme="paper"\] \{\n  --bg: #FFFDF8;\n\}/);
});

test("theme: anything but a plain colour is dropped, so config cannot add CSS", () => {
  const css = themeCss({ dark: { bg: "red; } body { display: none", text: "url(https://example.com/x)", "--x": "#fff", Bad: "#fff", ok: "#abc" }, light: "nope" });
  assert.doesNotMatch(css, /display|url|Bad|--x:|paper/);
  assert.match(css, /--ok: #abc;/);
  assert.equal(themeCss(undefined).trim(), "/* Vyre's colours from config (theme.colors); the defaults are in tokens.css and deck.css. */");
});

test("theme: a dark swatch override also repaints the roles tokens.css defines, unless config names the role", () => {
  const css = themeCss({ dark: { graphite: "#101010", signal: "#B4E35A", "primary-bg": "#FFFFFF" }, light: { graphite: "#202020" } });
  const dark = /:root \{\n([\s\S]*?)\n\}/.exec(css)?.[1] || "";
  assert.match(dark, /--graphite: #101010;\n[\s\S]*--bg: #101010;/);
  assert.match(dark, /--focus: #B4E35A;/);
  assert.match(dark, /--mark-dot: #B4E35A;/);
  assert.match(dark, /--primary-bg: #FFFFFF;/);
  assert.doesNotMatch(dark, /--primary-bg: #B4E35A;/, "the role config names wins over the swatch");
  const paper = /:root\[data-theme="paper"\] \{\n([\s\S]*?)\n\}/.exec(css)?.[1] || "";
  assert.equal(paper, "  --graphite: #202020;", "paper sets roles by name; no aliasing there");
});
