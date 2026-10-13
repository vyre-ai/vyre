// The Vyre mark as a function of time: the icon the site and the app use everywhere (the halftone V on a card with a folded corner, site/favicon.svg), used as given.
// It is a vector, so it is crisp at any size. The states move the whole icon (it settles in, breathes while something waits, and gives one ring when something is done); nothing is redrawn.
// Pure: markup in, markup out, so a test can hold it. The ring is ink, never violet: violet means "needs you" only.
import { MASTER, SMALL } from "./vyre-art.js";

const INK = String.fromCharCode(35) + "F1EEE6";
const OPEN_END = MASTER.indexOf(">") + 1;
if (!MASTER.startsWith("<svg") || OPEN_END < 5 || !MASTER.endsWith("</svg>")) throw new Error("vyre-mark: the icon is not an svg");

/**
 * @param {{ wire?: number, bead?: number, glow?: number, halo?: number, haloR?: number }} s
 *  wire 0..1 how much the icon has settled in (its opacity and size); glow 0..1 its light (a breath dims it to 60 percent); halo 0..1 a ring around the card (the "done" pulse).
 *  bead and haloR are kept for the callers that pass them and do nothing.
 */
export function markup({ wire = 1, glow = 1, halo = 0 } = {}) {
  const w = Math.max(0, Math.min(1, wire)), g = Math.max(0, Math.min(1, glow));
  const opacity = (w * (0.6 + 0.4 * g)).toFixed(3), scale = (0.94 + 0.06 * w).toFixed(3);
  const ring = halo > 0.001 ? `<rect x="-1" y="-1" width="66" height="66" rx="12" fill="none" stroke="${INK}" stroke-width="1.6" opacity="${Math.min(1, halo).toFixed(3)}"/>` : "";
  const open = MASTER.slice(0, OPEN_END).replace(/ width="[^"]*"/, "").replace(/ height="[^"]*"/, "");
  return `${open}<g opacity="${opacity}" transform="translate(32 32) scale(${scale}) translate(-32 -32)">${MASTER.slice(OPEN_END, -"</svg>".length)}</g>${ring}</svg>`;
}
export const small = () => SMALL;

const ease = (t) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);
const span = (t, a, b) => Math.max(0, Math.min(1, (t - a) / (b - a)));

/** INTRO (900 ms): the icon settles in over the first 62 percent, then its light comes fully on. t in 0..1. */
export const intro = (t) => ({ wire: ease(span(t, 0, 0.62)), bead: ease(span(t, 0.55, 0.85)), glow: ease(span(t, 0.6, 1)) });
/** WORKING: a slow breath of the icon's light, 2.4 s a cycle, between 55 and 100 percent. t in ms. */
export const working = (ms) => ({ glow: 0.775 + 0.225 * Math.sin((ms / 2400) * Math.PI * 2), halo: 0 });
/** DONE (700 ms): one ring out of the card, then rest. t in 0..1. */
export const done = (t) => ({ glow: 1, halo: (1 - ease(t)) * 0.9, haloR: 90 + ease(t) * 240 });
