#!/usr/bin/env node
// gen-mark: the Vyre mark as the site draws it (site/v2.js `mark`): the V and its dot sampled onto a dot grid, each dot as large as the stroke under it, the dot in the corner in the
// accent. Written as SVG circles, so the app icon, the Android layers, the favicons and the splash all come from one drawing.
//   node scripts/gen-mark.mjs [out-folder]     writes the SVGs. The PNGs the app and the site ship (apps/app/assets, site/) are these SVGs rendered at their sizes in headless
// Chromium, and site/favicon.ico from the 32 px one; web/ and site/favicon.svg are the SVGs themselves.
import fs from "node:fs";
import path from "node:path";

const INK = "#F1EEE6", ACCENT = "#B8A4FF", BG = "#141312";
// The mark in its own 24-unit box (the same path as the site's MARK and the app's tab icon)
const SEG = [[3.5, 5.5, 12, 19.5], [12, 19.5, 17.96, 9.69]], STROKE = 2.6 / 2, DOT = { x: 20.5, y: 5.5, r: 2.3 };

const segDist = (/** @type {number} */ px, /** @type {number} */ py, /** @type {number[]} */ [x1, y1, x2, y2]) => {
  const dx = x2 - x1, dy = y2 - y1, t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};
/** How much of the mark covers a point of the 24-unit box, 0 to 1, with a soft one-pixel edge as the site's canvas has. */
const cover = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ edge) => {
  const d = Math.min(...SEG.map(s => segDist(x, y, s) - STROKE), Math.hypot(x - DOT.x, y - DOT.y) - DOT.r);
  return Math.max(0, Math.min(1, 0.5 - d / edge));
};

/**
 * The dots, in a unit square: the site's sampling (the mark at 78 percent of the box, nudged as the site nudges it), its 3 by 3 softening and its curve.
 * @param {number} n dots across @param {{ accent?: boolean, specks?: boolean }} [o]
 */
export function dots(n, o = {}) {
  const k = 0.78, ox = (1 - k) / 2 + 1.2 / 24 * k, oy = (1 - k) / 2 + 0.6 / 24 * k, edge = 24 / 96 / k * 1.5;
  const at = (/** @type {number} */ u, /** @type {number} */ v) => cover((u - ox) / k * 24, (v - oy) / k * 24, edge);
  const out = [], cell = 1 / n, step = 3 / 96;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n, v = (j + 0.5) / n;
    let sum = 0, cnt = 0;
    for (const a of [-step, 0, step]) for (const b of [-step, 0, step]) { sum += at(u + a, v + b); cnt++; }
    const s = at(u, v) * 0.6 + (sum / cnt) * 0.4;
    const r = cell * 0.5 * Math.pow(s, 0.8) * 0.9;
    if (r * n > 0.06) out.push({ x: u, y: v, r, fill: o.accent !== false && i > n * 0.74 && j < n * 0.34 ? ACCENT : INK });
    else if (o.specks && (i + j) % 2 === 0 && Math.sin(i * 12.9898 + j * 78.233) > 0.93) out.push({ x: u, y: v, r: cell * 0.09, fill: INK, opacity: 0.18 });
  }
  return out;
}

/**
 * The card the mark sits on, as the site's .art: gently rounded corners (a continuous curve, softer than an app icon's) and the top-right corner folded down. Returns the card's
 * outline and the folded flap, in a box of side S.
 * @param {number} S @param {number} round corner radius as a share of the side @param {number} fold the fold's leg as a share of the side
 */
function card(S, round, fold) {
  const r = round * S, F = fold * S, c = r * 0.552, f = (/** @type {number} */ v) => Math.round(v * 100) / 100;
  // clockwise from the top edge; each rounded corner a cubic (a circle's 0.552 handles: smooth, no kink), the folded corner a straight diagonal
  const outline = `M${f(r)} 0H${f(S - F)}L${f(S)} ${f(F)}V${f(S - r)}C${f(S)} ${f(S - r + c)} ${f(S - r + c)} ${f(S)} ${f(S - r)} ${f(S)}H${f(r)}C${f(r - c)} ${f(S)} 0 ${f(S - r + c)} 0 ${f(S - r)}V${f(r)}C0 ${f(r - c)} ${f(r - c)} 0 ${f(r)} 0Z`;
  // the flap: the cut-off corner turned down onto the card, its fold line the diagonal
  const flap = `M${f(S - F)} 0L${f(S - F)} ${f(F)}L${f(S)} ${f(F)}Z`;
  return { outline, flap, F };
}

/**
 * One SVG. `inset` is how much of the box the mark's square takes (an adaptive icon keeps it in the middle 66 percent); `bg` the card's colour or none; `under` what shows past the card
 * (an app icon must be opaque, so its folded corner shows this darker ground); `round` and `fold` shape the card.
 * @param {{ size: number, n: number, inset?: number, bg?: string | null, under?: string, round?: number, fold?: number, accent?: boolean, specks?: boolean, mono?: boolean }} o
 */
export function svg(o) {
  const S = o.size, inset = o.inset ?? 1, pad = (1 - inset) / 2 * S, span = inset * S;
  const ds = dots(o.n, { accent: o.mono ? false : o.accent, specks: o.specks });
  const f = (/** @type {number} */ v) => Math.round(v * 100) / 100;
  const body = ds.map(d => `<circle cx="${f(pad + d.x * span)}" cy="${f(pad + d.y * span)}" r="${f(d.r * span)}" fill="${o.mono ? "#fff" : d.fill}"${d.opacity ? ` opacity="${d.opacity}"` : ""}/>`).join("");
  if (!o.bg) return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${body}</svg>\n`;
  const { outline, flap, F } = card(S, o.round ?? 0.12, o.fold ?? 0.11);
  const defs = `<defs><clipPath id="card"><path d="${outline}"/></clipPath><linearGradient id="flap" x1="1" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#34302C"/><stop offset="1" stop-color="#22201D"/></linearGradient><linearGradient id="shade" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></linearGradient></defs>`;
  const under = o.under ? `<rect width="${S}" height="${S}" fill="${o.under}"/>` : "";
  // the flap casts a soft shadow onto the card below its fold line, then sits on top
  const shadow = `<path d="M${f(S - F)} 0L${f(S - F - F * 0.18)} ${f(F * 1.18)}L${f(S)} ${f(F * 1.18)}L${f(S)} ${f(F)}Z" fill="url(#shade)" opacity=".7"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${defs}${under}<g clip-path="url(#card)"><rect width="${S}" height="${S}" fill="${o.bg}"/>${body}</g>${shadow}<path d="${flap}" fill="url(#flap)"/></svg>\n`;
}

/** Every file the app and the site take, by name: the drawing and its size. */
export const TARGETS = {
  "icon.svg": { size: 1024, n: 56, bg: BG, under: "#0B0A09", round: 0.12, specks: true }, // iOS and the stores: opaque, so the folded corner shows a darker ground
  "adaptive-icon.svg": { size: 1024, n: 48, inset: 0.62 },                         // Android foreground: the mark inside the safe circle
  "adaptive-icon-background.svg": { size: 1024, n: 1, bg: BG, accent: false },     // Android background: the ground alone
  "adaptive-icon-monochrome.svg": { size: 1024, n: 48, inset: 0.62, mono: true },  // Android themed icon: one colour
  "splash.svg": { size: 1024, n: 56, bg: BG, round: 0.12, specks: true },          // the splash's image: the card, on the splash's darker ground
  "favicon.svg": { size: 64, n: 22, bg: BG, round: 0.14, fold: 0.16 },            // browsers: fewer, larger dots so it reads at 16 px; a larger fold so it shows
  "favicon-large.svg": { size: 512, n: 40, bg: BG, round: 0.12, specks: true },    // touch icons and the site's 192 and 512
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = path.resolve(process.argv[2] || "mark-out");
  fs.mkdirSync(out, { recursive: true });
  for (const [name, o] of Object.entries(TARGETS)) fs.writeFileSync(path.join(out, name), name === "adaptive-icon-background.svg" ? `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="${BG}"/></svg>\n` : svg(o));
  console.log(`wrote ${Object.keys(TARGETS).length} files to ${out}`);
}
