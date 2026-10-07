// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PALETTE, PAIRS, contrast, failures, parse, withAttention } from "./palette.js";

test("palette: every text-on-colour pair passes WCAG AA in dark and paper", () => {
  assert.deepEqual(failures(), []);
});

test("palette: teal, the one alternative attention colour, passes too", () => {
  assert.deepEqual(failures(withAttention("teal")), []);
});

test("palette: the reduced set has no hue besides the attention colour", () => {
  for (const set of Object.values(PALETTE)) for (const role of Object.keys(set)) {
    assert.ok(!/recall|gold|honey|coral|danger|error|success|info/.test(role), `extra role ${role}`);
  }
});

test("palette: the check catches a failing pair (bone on bone, the bug it exists for)", () => {
  const bad = { dark: { ...PALETTE.dark, "primary-ink": "#F1EEE6" }, light: PALETTE.light };
  assert.match(failures(bad).join("\n"), /dark: primary-ink on primary-bg .* is 1\.00:1/);
  assert.ok(contrast("#0E0D0C", "#F1EEE6", "#0E0D0C") > 15);
});

// The Deck paints these roles from the generated web/css/tokens.css (deck.css only adds what has
// no token yet), so the two together must resolve every role to the palette.
test("palette: tokens.css and deck.css declare the same roles, dark on :root and paper on data-theme", () => {
  const files = ["../../web/css/tokens.css", "../../web/css/deck.css"].map(f => fs.readFileSync(new URL(f, import.meta.url), "utf8"));
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

// Deep glass (Capsule 0.2): the tint at its real alpha over the four sample wallpapers' stops. Bone
// has no accent hue, so a chip on glass carries no wash (a wash lifted the chip text to 3.98:1 over
// the brightest sky): the text is the theme text colour on the glass itself, and this holds it.
test("palette: text on Deep glass passes 4.5:1 over every sample wallpaper stop, dark and light", () => {
  const stops = ["#cfe0ea", "#9db8c9", "#6f8fa8", "#3e5b73", "#3a2c4d", "#8a4f6b", "#e08a5b", "#f4c27a",
    "#0b0e1a", "#161d33", "#232b47", "#2c3350", "#26331f", "#3c4f2c", "#5c6e3c", "#8a9a5c"];
  const mix = (/** @type {string} */ tint, /** @type {number} */ a, /** @type {string} */ under) => {
    const t = parse(tint), u = parse(under);
    return "#" + [0, 1, 2].map(i => Math.round(t[i] * a + u[i] * (1 - a)).toString(16).padStart(2, "0")).join("");
  };
  for (const [theme, tint, alpha] of /** @type {const} */ ([["dark", "#161513", 0.62], ["light", "#FBFAF6", 0.66]])) {
    for (const s of stops) {
      const glass = mix(tint, alpha, s);
      const r = contrast(PALETTE[theme].text, glass, glass);
      assert.ok(r >= 4.5, `${theme} glass over ${s}: text ${r.toFixed(2)}:1`);
    }
  }
});
