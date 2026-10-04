// The one-app tokens: one JSON, rendered for the Capsule (Swift), the app (TS) and the Deck (CSS).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load, swift, ts, css, rgba } from "../scripts/lib/tokens.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const t = load(ROOT);

test("tokens: both themes name the same colour roles", () => {
  assert.deepEqual(Object.keys(t.color.dark), Object.keys(t.color.paper));
  for (const theme of ["dark", "paper"]) for (const v of Object.values(t.color[theme])) rgba(v);
});

test("tokens: the status keys are the stable contract, most urgent first", () => {
  assert.deepEqual(t.status.order, ["needsYou", "failed", "running", "unread", "done"]);
  for (const k of t.status.order) assert.ok(t.status[k].word, k);
});

test("tokens: the Swift file carries every role, the status list in order, and mono sizes", () => {
  const s = swift(t);
  for (const k of Object.keys(t.color.dark)) assert.match(s, new RegExp(`public let ${k}: Color`));
  const order = [...s.matchAll(/Status\(key: "(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(order, t.status.order);
  assert.match(s, /monoSizes: \[CGFloat\] = \[12, 13\]/);
  assert.match(s, /beacon: Color\(\.sRGB, red: 184 \/ 255, green: 164 \/ 255, blue: 255 \/ 255, opacity: 1\)/);
  assert.equal(swift(t), s, "stable output");
});

test("tokens: the CSS uses the Deck's selectors and role names", () => {
  const c = css(t);
  assert.match(c, /^:root \{/m);
  assert.match(c, /^:root\[data-theme="paper"\] \{/m);
  for (const name of ["--bg:", "--panel:", "--hover:", "--text-2:", "--label:", "--rule-strong:", "--primary-bg:", "--primary-ink:",
    "--focus:", "--signal-wash:", "--code-bg:", "--beacon-ink:", "--beacon-dot:", "--beacon-badge-ink:", "--sans:", "--mono:", "--popover:", "--float:", "--radius-card:", "--radius-sheet:",
    "--size-base:", "--line-read:", "--space-4:", "--control-touch:", "--motion-panel:", "--ease:"])
    assert.ok(c.includes(name), name);
  assert.match(c, /@media \(max-width: 719px\), \(max-height: 500px\) and \(pointer: coarse\) \{\n  :root \{\n    --size-read: 17px; --line-read: 24px;/);
});

test("tokens: the TS file is what the app imports: tokens, Scheme, Colors, attention()", () => {
  const out = ts(t);
  assert.match(out, /export const tokens = /);
  assert.match(out, /export type Scheme = "dark" \| "paper";/);
  assert.match(out, /export type Colors = /);
  assert.match(out, /export function attention\(/);
  assert.doesNotMatch(out, /\$schema/);
});

test("tokens: every generated file in the tree is current", async () => {
  const { generate } = await import("../scripts/gen-tokens");
  for (const [rel, body] of Object.entries(generate())) {
    const file = path.join(ROOT, rel);
    if (fs.existsSync(file)) assert.equal(fs.readFileSync(file, "utf8"), body, `${rel} is stale; run npm run tokens`);
  }
});

test("tokens: every output names the root folder that must exist before it is written", async () => {
  const { OUTPUTS, ROOTS } = await import("../scripts/gen-tokens");
  for (const rel of Object.keys(OUTPUTS)) {
    assert.ok(ROOTS[rel], rel);
    assert.ok(rel.startsWith(ROOTS[rel] + "/"), `${rel} is under ${ROOTS[rel]}`);
  }
});

// ---- Deck v2 ----
import { cssV2 } from "../scripts/lib/tokens.js";
import { checkV2, tokens as shippedTokens } from "../lib/theme/index.js";
import { emblem } from "../deck/vendor/vyrecode/emblem.js";
import { PROJECT_COLORS } from "../deck/vendor/vyrecode/identity.js";

test("tokens v2: both schemes name the same roles, every one a colour, and v1 is untouched", () => {
  assert.deepEqual(Object.keys(t.v2.color.dark), Object.keys(t.v2.color.paper));
  for (const theme of ["dark", "paper"]) for (const v of Object.values(t.v2.color[theme])) rgba(v);
  assert.equal(t.color.dark.beacon, t.v2.color.dark.accent, "the accent is the attention colour");
  assert.equal(t.color.paper.beacon, t.v2.color.paper.accent);
  assert.equal(t.type.desktop.base[0], 13, "the v1 type scale is still there for the screens that have not moved");
});

test("tokens v2: the colour rules hold (the one known miss is filed, and the list may only shrink)", () => {
  // Paper's ok word on its own wash over a card is 4.46:1, 0.04 under AA. app-design owns the value (issue #68).
  assert.deepEqual(checkV2(shippedTokens()), ["v2 paper: ok on okWash over surface2 is 4.46:1, needs 4.5:1"]);
});

test("tokens v2: the CSS has the Deck's names, both schemes, and the phone sizes", () => {
  const c = cssV2(t);
  assert.match(c, /^:root \{/m);
  assert.match(c, /^:root\[data-theme="paper"\] \{/m);
  for (const name of ["--surface-1:", "--surface-3:", "--edge-strong:", "--edge-top:", "--accent-wash:", "--ok-wash:", "--err:", "--primary-ink:", "--code-bg:",
    "--fs-caption:", "--lh-display:", "--fs-label:", "--s-1:", "--s-16:", "--r-card:", "--r-sheet:", "--elev-1:", "--elev-3:", "--dur-4:", "--spring:", "--rail-w:", "--row-h:"])
    assert.ok(c.includes(name), name);
  assert.match(c, /--elev-2: 0 1px 0 var\(--edge-top\) inset, 0 8px 24px -8px rgba\(0,0,0,\.6\), 0 2px 6px rgba\(0,0,0,\.35\);/);
  assert.match(c, /@media \(max-width: 719px\), \(max-height: 500px\) and \(pointer: coarse\) \{\n  :root \{ --fs-secondary: 15px; --lh-secondary: 20px; --fs-body: 16px; --lh-body: 22px; --fs-headline: 17px; --lh-headline: 22px; --fs-read: 17px; --lh-read: 25px; --fs-title: 20px; --lh-title: 25px; --fs-page: 28px; --lh-page: 34px; --fs-display: 34px; --lh-display: 41px; --control: 44px; --control-sm: 36px; --row-h: 64px; \}/);
  assert.equal(cssV2(t), c, "stable output");
});

test("tokens v2: the Swift file carries the v2 roles, the type roles, springs and the emblem", () => {
  const s = swift(t);
  for (const k of Object.keys(t.v2.color.dark)) assert.match(s, new RegExp(`public let ${k}: Color`));
  assert.match(s, /public enum V2 \{/);
  assert.match(s, /public static let body: \(size: CGFloat, line: CGFloat\) = \(14, 20\)/);
  assert.match(s, /public static let `default` = Spring\(damping: 0\.8, stiffness: 380\)/);
  assert.equal([...s.matchAll(/^ {16}\.(circle|rect|ring|path)\(/gm)].length, t.v2.emblem.shapes.length);
});

test("tokens v2: the emblem spec draws exactly what the Deck's renderer draws", () => {
  const e = t.v2.emblem;
  assert.deepEqual(e.palette, PROJECT_COLORS, "the emblem palette is the project colours");
  const f = (/** @type {number} */ n) => String(n);
  const shape = (/** @type {any} */ s, /** @type {number} */ r, /** @type {number} */ x, /** @type {number} */ y, /** @type {string} */ fill) => {
    const rot = s.rotates ? ` transform="rotate(${r * 90} ${x + 30} ${y + 30})"` : "";
    if (s.kind === "circle") return `<circle cx="${x + s.cx}" cy="${y + s.cy}" r="${s.r}" fill="${fill}"/>`;
    if (s.kind === "ring") return `<circle cx="${x + s.cx}" cy="${y + s.cy}" r="${s.r}" fill="none" stroke="${fill}" stroke-width="${s.stroke}"/>`;
    if (s.kind === "rect") return `<rect x="${x + s.x}" y="${y + s.y}" width="${s.w}" height="${s.h}" rx="${s.rx}" fill="${fill}"/>`;
    const d = s.ops.map((/** @type {any[]} */ o) => o[0] === "M" || o[0] === "L" ? `${o[0]}${x + o[1]} ${y + o[2]}`
      : o[0] === "A" ? `A${o[1]} ${o[2]} ${o[3]} ${o[4]} ${o[5]} ${x + o[6]} ${y + o[7]}` : "Z").join(" ");
    return `<path d="${d}" fill="${fill}"${rot}/>`;
  };
  const render = (/** @type {number[]} */ b, /** @type {{ draft: boolean, theme: "dark"|"paper" }} */ { draft, theme }) => {
    const n = e.palette.length, c1 = e.palette[b[0] % n], c2 = e.palette[(b[0] + 2 + (b[1] % (n - 2))) % n], ink = e.ink[theme];
    const cells = e.cells.map((/** @type {number[]} */ [x, y], /** @type {number} */ i) =>
      shape(e.shapes[b[2 + i] % e.shapes.length], (b[2 + i] >> 3) % 4, x, y, (b[6] >> i) & 1 ? c2 : draft ? c1 : ink)).join("");
    const d = e.draft;
    const frame = draft
      ? `<rect x="${d.frame}" y="${d.frame}" width="${e.canvas - 2 * d.frame}" height="${e.canvas - 2 * d.frame}" rx="${e.corner}" fill="none" stroke="${c1}" stroke-width="${d.stroke}" stroke-dasharray="${d.dash.join(" ")}"/><g opacity="${f(d.cellOpacity).replace(/^0/, "")}">${cells}</g>`
      : `<g clip-path="url(#em)"><rect width="${e.canvas}" height="${e.canvas}" fill="${c1}"/>${cells}</g>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${e.canvas} ${e.canvas}" width="${e.canvas}" height="${e.canvas}"><defs><clipPath id="em"><rect x="${e.inset}" y="${e.inset}" width="${e.canvas - 2 * e.inset}" height="${e.canvas - 2 * e.inset}" rx="${e.corner}"/></clipPath></defs>${frame}</svg>`;
  };
  let seed = 12345;
  const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24;
  for (let i = 0; i < 400; i++) {
    const b = Array.from({ length: 8 }, next);
    for (const theme of /** @type {const} */ (["dark", "paper"])) for (const draft of [false, true])
      assert.equal(emblem(b, { draft, theme }), render(b, { draft, theme }), `bytes ${b} ${theme}${draft ? " draft" : ""}`);
  }
});
