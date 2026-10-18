// @ts-check
// The halftone field behind the whole welcome flow: a grid of dots, each on a spring at its grid point. The cursor pushes dots aside and drags them along, clicks and step
// changes send a shockwave ring across, three unseen agents wander on slow orbits and stir small vortices, and each dot's size and violet follow its energy. The numbers are the
// owner's, taken from polish-proposal/onboarding.html (startBg, the toned-down pass). No DOM and no clock in here: the canvas component feeds it time and draws what it returns. Pure.

/** The spacing of the dots: a lighter grid on a phone. */
export const GRID = 22;
export const GRID_PHONE = 32;
/** How strongly the field shows: full on the welcome screen, calmer on the forms. */
export const INTENSITY = Object.freeze({ welcome: 1, form: 0.38 });
/** The spring pulling a dot home, the damping per 16 ms, a wave's life in ms and how many waves at once. */
export const SPRING = 0.022;
export const DAMP = 0.84;
export const WAVE_MS = 2000;
export const MAX_WAVES = 5;

/** @typedef {{ bx: number, by: number, ox: number, oy: number, vx: number, vy: number }} Dot */
/** @typedef {{ x: number, y: number, w: number, h: number }} Calm */
/** @typedef {{ intensity: number, target: number, calm: Calm | null, waves: { x: number, y: number, t: number, p: number }[], pointer: { x: number, y: number, vx: number, vy: number, on: boolean } }} Field */

/** A new field at rest, at full strength. @returns {Field} */
export function createField() {
  return { intensity: 1, target: 1, calm: null, waves: [], pointer: { x: -1e4, y: -1e4, vx: 0, vy: 0, on: false } };
}

/** Send a ring across the field from a point. @param {Field} F @param {number} x @param {number} y @param {number} [power] */
export function shock(F, x, y, power = 1) {
  F.waves.push({ x, y, t: 0, p: power });
  if (F.waves.length > MAX_WAVES) F.waves.shift();
}

/** The dots for a canvas of this size. @param {number} W @param {number} H @param {number} [g] @returns {Dot[]} */
export function buildDots(W, H, g = GRID) {
  /** @type {Dot[]} */
  const dots = [];
  for (let y = g / 2; y < H; y += g) for (let x = g / 2; x < W; x += g) dots.push({ bx: x, by: y, ox: 0, oy: 0, vx: 0, vy: 0 });
  return dots;
}

/** The three wandering agents' orbits. */
export const AGENTS = Object.freeze([0, 1, 2].map((i) => Object.freeze({ ph: i * 2.1, sp: 0.00011 + i * 0.00004, ax: 0.32 + i * 0.07, ay: 0.26 + i * 0.05, spin: i % 2 ? 1 : -1 })));

/** Where the agents are at time `tm` (ms). @param {number} W @param {number} H @param {number} tm */
export function agentsAt(W, H, tm) {
  return AGENTS.map((a) => ({ x: W * (0.5 + a.ax * Math.sin(tm * a.sp + a.ph)), y: H * (0.5 + a.ay * Math.sin(tm * a.sp * 1.37 + a.ph * 1.7)), s: a.spin }));
}

/**
 * One step of the physics for every dot, in place. `dt` is the time since the last frame in ms (capped by the caller at 40).
 * @param {Field} F @param {Dot[]} dots @param {{ dt: number, tm: number, W: number, H: number }} t
 */
export function stepField(F, dots, { dt, tm, W, H }) {
  F.intensity += (F.target - F.intensity) * Math.min(1, dt * 0.004);
  const I = F.intensity, P = F.pointer;
  const ag = agentsAt(W, H, tm);
  for (const w of F.waves) w.t += dt;
  F.waves = F.waves.filter((w) => w.t < WAVE_MS);
  const damp = Math.pow(DAMP, dt / 16), f = dt / 16;
  for (const d of dots) {
    const px = d.bx + d.ox, py = d.by + d.oy;
    let fx = -d.ox * SPRING, fy = -d.oy * SPRING;
    // the cursor pushes away, and drags along the way it moves
    if (P.on) {
      const dx = px - P.x, dy = py - P.y, dd = dx * dx + dy * dy;
      if (dd < 25600) { const dm = Math.sqrt(dd) || 1, fall = 1 - dm / 160, s = fall * fall; fx += (dx / dm) * s * 1.1 + P.vx * s * 0.12; fy += (dy / dm) * s * 1.1 + P.vy * s * 0.12; }
    }
    // vortices around the wandering agents
    for (const a of ag) {
      const dx = px - a.x, dy = py - a.y, dd = dx * dx + dy * dy;
      if (dd < 48400) { const dm = Math.sqrt(dd) || 1, s = (1 - dm / 220) * 0.16 * I; fx += (-dy / dm) * s * a.s; fy += (dx / dm) * s * a.s; }
    }
    // shockwave rings
    for (const w of F.waves) {
      const r = w.t * 0.55, dx = px - w.x, dy = py - w.y, dm = Math.hypot(dx, dy) || 1, band = Math.abs(dm - r);
      if (band < 38) { const s = (1 - band / 38) * w.p * (1 - w.t / WAVE_MS) * 1.6; fx += (dx / dm) * s; fy += (dy / dm) * s; }
    }
    d.vx = (d.vx + fx * f) * damp; d.vy = (d.vy + fy * f) * damp;
    d.ox += d.vx * f; d.oy += d.vy * f;
  }
  P.vx *= 0.85; P.vy *= 0.85;
}

/** What to draw for a dot now: where, how big, how opaque and how violet (0 to 1). @param {Field} F @param {Dot} d @param {number} tm @returns {{ x: number, y: number, r: number, a: number, mix: number }} */
export function lookOf(F, d, tm) {
  const I = F.intensity, cal = F.calm;
  const nx = d.bx + d.ox, ny = d.by + d.oy;
  const w1 = Math.sin(d.bx * 0.006 + tm * 0.00037) + Math.sin(d.by * 0.008 - tm * 0.00029);
  const w2 = Math.sin((d.bx + d.by) * 0.004 + tm * 0.00048 + Math.sin(tm * 0.00022 + d.by * 0.003) * 2);
  let v = Math.pow(Math.max(0, (w1 * 0.3 + w2 * 0.7) * 0.5 + 0.5), 1.7) * I;
  const e = Math.min(1, Math.hypot(d.vx, d.vy) * 0.22 + Math.hypot(d.ox, d.oy) * 0.025);
  v = Math.min(1, v + e * 0.45);
  if (cal) { const qx = (nx - cal.x) / cal.w, qy = (ny - cal.y) / cal.h, qd = Math.sqrt(qx * qx + qy * qy); v *= 0.12 + 0.88 * Math.min(1, Math.max(0, (qd - 0.7) / 0.6)); }
  return { x: nx, y: ny, r: 0.65 + v * 2.6, a: Math.min(0.95, 0.11 + v * 0.78), mix: Math.min(1, Math.max(0, w1 * 0.6 - 0.15) * 1.6 * I + e * 0.55) };
}

/** The ellipse of calm around a screen's content (a box in canvas pixels): dots dim inside it so the words stay readable. @param {{ left: number, top: number, width: number, height: number }} box @param {{ left: number, top: number }} canvas @returns {Calm} */
export function calmAround(box, canvas) {
  return { x: box.left - canvas.left + box.width / 2, y: box.top - canvas.top + box.height / 2, w: Math.max(200, box.width * 0.78), h: Math.max(160, box.height * 0.8) };
}
