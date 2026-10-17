// @ts-check
// An agent's look is picked from a small grid: one of eight shapes (the agent family's bodies, faces and marks, ADR 0043) in one of eight colours. The look is a seed the agent family draws from:
// the shape's own seed, then "~c" and the colour's number. Pure.

export const SHAPES = /** @type {const} */ (["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
export const COLOR_COUNT = 8;

/** The seed for a shape (0 to 7) in a colour (0 to 7). Out-of-range numbers wrap. @param {number} shape @param {number} color */
export const lookSeed = (shape, color) => `${SHAPES[((shape % 8) + 8) % 8]}~c${((color % COLOR_COUNT) + COLOR_COUNT) % COLOR_COUNT}`;

/** The shape and colour a look seed names, or null for a seed that is not a look. @param {string} seed */
export function lookOf(seed) {
  const m = /^s([0-7])~c([0-7])$/.exec(String(seed));
  return m ? { shape: Number(m[1]), color: Number(m[2]) } : null;
}
