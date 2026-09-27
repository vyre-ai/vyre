// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PALETTE, PAIRS, contrast, failures, withAttention } from "./palette.js";

test("palette: every text-on-colour pair passes WCAG AA in dark and paper", () => {
  assert.deepEqual(failures(), []);
});

test("palette: teal, the one alternative attention colour, passes too", () => {
  assert.deepEqual(failures(withAttention("teal")), []);
});

test("palette: the reduced set has no hue besides lime and the attention colour", () => {
  for (const set of Object.values(PALETTE)) for (const role of Object.keys(set)) {
    assert.ok(!/recall|gold|honey|coral|danger|error|success|info/.test(role), `extra role ${role}`);
  }
});

test("palette: the check catches a failing pair (bone on lime, the bug it exists for)", () => {
  const bad = { dark: { ...PALETTE.dark, "primary-ink": "#F1EEE6" }, light: PALETTE.light };
  assert.match(failures(bad).join("\n"), /dark: primary-ink on primary-bg .* is 1\.10:1/);
  assert.ok(contrast("#0E0D0C", "#C6F36B", "#0E0D0C") > 15);
});

// The Deck paints these roles from the generated deck/css/tokens.css (deck.css only adds what has
// no token yet), so the two together must resolve every role to the palette.
test("palette: tokens.css and deck.css declare the same roles, dark on :root and paper on data-theme", () => {
  const files = ["../../deck/css/tokens.css", "../../deck/css/deck.css"].map(f => fs.readFileSync(new URL(f, import.meta.url), "utf8"));
  const block = (/** @type {RegExp} */ re) => {
    /** @type {Record<string, string>} */ const out = {};
    for (const css of files) {
      const m = re.exec(css);
      if (m) Object.assign(out, Object.fromEntries([...m[1].matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map(x => [x[1], x[2].trim()])));
    }
    assert.ok(Object.keys(out).length, `no block for ${re}`);
    return out;
  };
  const dark = block(/^:root \{([\s\S]*?)^\}/m);
  const paper = { ...dark, ...block(/^:root\[data-theme="paper"\] \{([\s\S]*?)^\}/m) };
  const resolve = (/** @type {Record<string,string>} */ set, /** @type {string} */ name) => {
    let v = set[name];
    for (let i = 0; v && i < 5; i++) { const m = /^var\(--([a-z0-9-]+)\)$/.exec(v); if (!m) break; v = set[m[1]]; }
    return v && v.replace(/\s+/g, "").toLowerCase();
  };
  const roles = new Set(PAIRS.flatMap(([fg, bg]) => [fg, bg]));
  for (const [theme, set] of [["dark", dark], ["light", paper]]) for (const role of roles) {
    // @ts-ignore
    assert.equal(resolve(set, role), PALETTE[theme][role].replace(/\s+/g, "").toLowerCase(), `${theme} --${role}`);
  }
});
