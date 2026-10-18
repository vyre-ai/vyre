// @ts-check
// The character of an agent, as the one thing the server and the app share: a look is a shape and a colour and may go on to eyes, mouth, a top piece, a blush and a charm ("s3~c5~e2~m1~t4~b1~h0").
// A part a look leaves out is drawn from a hash of the agent's name, always the same. The server fills a look in when an agent is made, so a rename never changes how it looks; the app uses the same
// function for an agent it has not read a look for. Pure.

/** How many choices each part has, in the order they are written. */
export const PART_COUNTS = /** @type {const} */ ({ e: 6, m: 5, t: 7, b: 2, h: 6 });
export const PART_KEYS = /** @type {const} */ (["e", "m", "t", "b", "h"]);

/** A small stable hash (FNV-1a) of a string. @param {string} s */
export const fnv = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/** The parts a seed names, by key; a part it does not name is absent. @param {string} seed @returns {Record<string, number>} */
export function partsOf(seed) {
  /** @type {Record<string, number>} */ const out = {};
  const m = /(?:~c[0-7])?(?:~e([0-5]))?(?:~m([0-4]))?(?:~t([0-6]))?(?:~b([01]))?(?:~h([0-5]))?$/.exec(String(seed));
  if (m) PART_KEYS.forEach((k, i) => { if (m[i + 1] !== undefined) out[k] = Number(m[i + 1]); });
  return out;
}

/** The seed without its parts. @param {string} seed */
export const baseOf = (seed) => String(seed).replace(/(?:~e[0-5])?(?:~m[0-4])?(?:~t[0-6])?(?:~b[01])?(?:~h[0-5])?$/, "");

/** Every part present: those the seed names stay, the rest come from the hash of `key` (the agent's name, lower case). @param {string} seed @param {string} key */
export function withParts(seed, key) {
  const have = partsOf(seed);
  let out = baseOf(seed);
  for (const k of PART_KEYS) out += `~${k}${have[k] ?? fnv(`${key}:${k}`) % PART_COUNTS[k]}`;
  return out;
}

/** A whole look for an agent: its shape and colour (the look's, else drawn from the name) and every part. Valid for agents.create. @param {string | null | undefined} look @param {string} name */
export function fullLook(look, name) {
  const key = String(name).toLowerCase();
  const l = String(look || "");
  const m = /^(s[0-7]~c[0-7])/.exec(l);
  const base = m ? m[1] : `s${fnv(`${key}:s`) % 8}~c${fnv(`${key}:c`) % 8}`;
  return withParts(base + (m ? l.slice(m[1].length) : ""), key);
}
