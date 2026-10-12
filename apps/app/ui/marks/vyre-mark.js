// The Vyre mark as a function of time. The approved master SVG is used as given; only the draw-in of the wire (a stroke-dash reveal of the masks the glass tube is cut with)
// and the light of the bead (opacity and a halo) are driven from outside. Pure: markup in, markup out, so a test can hold it.
import { MASTER, SMALL } from "./vyre-art.js";

/** The wire's length with its round caps (two segments, 466.5 and 268.2) and a little over. */
export const WIRE = 740;
const WIRE_D = 'd="M256 320 L496 720 L634 490"';
const GLOW_RING = '<circle cx="736" cy="320" r="360" fill="url(#g_vyre)" opacity=".5"/>';
const GLOW_MASK = '<g transform="translate(496 480) scale(1.08) translate(-496 -480)" filter="url(#b14)">';
const BEAD_OPEN = '<clipPath id="c20">';
const BEAD_CLOSE = '</g><rect width="1024" height="1024" filter="url(#grain)"';

const must = (s, a) => { if (!s.includes(a)) throw new Error(`vyre-mark: the master changed, anchor not found: ${a.slice(0, 40)}`); };
[WIRE_D, GLOW_RING, GLOW_MASK, BEAD_OPEN, BEAD_CLOSE].forEach((a) => must(MASTER, a));

/**
 * @param {{ wire?: number, bead?: number, glow?: number, halo?: number, haloR?: number }} s
 *  wire 0..1 how much of the tube is drawn; bead 0..1 the bead's opacity; glow 0..1 the light on the tube; halo 0..1 an extra ring of light (the "done" pulse) at radius haloR.
 */
export function markup({ wire = 1, bead = 1, glow = 1, halo = 0, haloR = 120 } = {}) {
  const off = (1 - Math.max(0, Math.min(1, wire))) * WIRE;
  const dash = `${WIRE_D} stroke-dasharray="${WIRE}" stroke-dashoffset="${off.toFixed(1)}"`;
  let s = MASTER.split(WIRE_D).join(dash);
  s = s.replace(GLOW_RING, `<circle cx="736" cy="320" r="360" fill="url(#g_vyre)" opacity="${(0.5 * glow).toFixed(3)}"/>`);
  s = s.replace(GLOW_MASK, `<g opacity="${glow.toFixed(3)}">${GLOW_MASK}`);
  // the glow group closes with two </g>; the extra opening above is closed right after the group it wraps
  s = s.replace('<circle cx="736" cy="320" r="60" fill="#fff"/></g></g>', '<circle cx="736" cy="320" r="60" fill="#fff"/></g></g></g>');
  s = s.replace(BEAD_OPEN, `<g opacity="${bead.toFixed(3)}">${BEAD_OPEN}`);
  const ring = halo > 0.001 ? `<circle cx="736" cy="320" r="${haloR.toFixed(0)}" fill="url(#g_vyre)" opacity="${halo.toFixed(3)}" filter="url(#b24)"/>` : "";
  s = s.replace(BEAD_CLOSE, `${ring}</g>${BEAD_CLOSE}`);
  return s;
}
export const small = () => SMALL;

const ease = (t) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);
const span = (t, a, b) => Math.max(0, Math.min(1, (t - a) / (b - a)));

/** INTRO (900 ms): the wire draws in over the first 62 percent, then the bead's light comes on. t in 0..1. */
export const intro = (t) => ({ wire: ease(span(t, 0, 0.62)), bead: ease(span(t, 0.55, 0.85)), glow: ease(span(t, 0.6, 1)) });
/** WORKING: a slow breath of the bead's light, 2.4 s a cycle, between 55 and 100 percent. t in ms. */
export const working = (ms) => ({ glow: 0.775 + 0.225 * Math.sin((ms / 2400) * Math.PI * 2), halo: 0 });
/** DONE (700 ms): one bright pulse out of the bead, then rest. t in 0..1. */
export const done = (t) => ({ glow: 1, halo: (1 - ease(t)) * 0.9, haloR: 90 + ease(t) * 240 });
