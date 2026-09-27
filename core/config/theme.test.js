// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { themeCss } from "./theme.js";

test("theme: config colours become custom properties, dark on :root and light on paper", () => {
  const css = themeCss({ dark: { signal: "#B4E35A", "rule-strong": "rgba(255,255,255,0.2)" }, light: { bg: "#FFFDF8" } });
  assert.match(css, /:root \{\n  --signal: #B4E35A;\n  --rule-strong: rgba\(255,255,255,0.2\);\n\}/);
  assert.match(css, /:root\[data-theme="paper"\] \{\n  --bg: #FFFDF8;\n\}/);
});

test("theme: anything but a plain colour is dropped, so config cannot add CSS", () => {
  const css = themeCss({ dark: { bg: "red; } body { display: none", text: "url(https://example.com/x)", "--x": "#fff", Bad: "#fff", ok: "#abc" }, light: "nope" });
  assert.doesNotMatch(css, /display|url|Bad|--x:|paper/);
  assert.match(css, /--ok: #abc;/);
  assert.equal(themeCss(undefined).trim(), "/* Vyre's colours from config (theme.colors); the defaults are in deck.css. */");
});
