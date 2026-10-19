// @ts-check
// An agent's look is picked from a small grid: one of eight shapes (the agent family's bodies, faces and marks, ADR 0043) in one of sixteen colours (c0 to c7 as first shipped, c8 to c15 added 19 Oct). The look is a seed the agent family draws from:
// the shape's own seed, then "~c" and the colour's number. Pure.

export const SHAPES = /** @type {const} */ (["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
export const COLOR_COUNT = 16;

/** The seed for a shape (0 to 7) in a colour (0 to 15). Out-of-range numbers wrap. @param {number} shape @param {number} color */
export const lookSeed = (shape, color) => `${SHAPES[((shape % 8) + 8) % 8]}~c${((color % COLOR_COUNT) + COLOR_COUNT) % COLOR_COUNT}`;

/** The shape and colour a look seed names, or null for a seed that is not a look. The character parts after them (see PARTS) are not read here. @param {string} seed */
export function lookOf(seed) {
  const m = /^s([0-7])~c(1[0-5]|[0-9])(?:~e[0-5])?(?:~m[0-4])?(?:~t[0-6])?(?:~b[01])?(?:~h[0-5])?$/.exec(String(seed));
  return m ? { shape: Number(m[1]), color: Number(m[2]) } : null;
}

// A look may go on past shape and colour to a little character: eyes, mouth, a top piece, a blush and a charm. Same order everywhere (core/agents/index.js checks it).
/** How many choices each part has, in the order they are written: eyes e, mouth m, top t, blush b, charm h. The words are for the picker. */
export const PARTS = /** @type {const} */ ([
  { key: "e", label: "Eyes", words: ["Round", "Big", "Sleepy", "Happy", "Wink", "Wide"] },
  { key: "m", label: "Mouth", words: ["Smile", "Grin", "Smirk", "Surprised", "Cat"] },
  { key: "t", label: "Top", words: ["None", "Antenna", "Leaf", "Tuft", "Bow", "Hat", "Sprout"] },
  { key: "b", label: "Blush", words: ["None", "Blush"] },
  { key: "h", label: "Charm", words: ["None", "Star", "Heart", "Bolt", "Moon", "Drop"] },
]);

// The hash and the filling-in are shared with the server (lib/agent-look-parts.js), which stores every agent's look whole: the same name always draws the same character.
export { partsOf, baseOf, withParts } from "../../../../lib/agent-look-parts.js";
import { withParts as fill, partsOf as read, baseOf as base } from "../../../../lib/agent-look-parts.js";

/** A look seed with one part changed (the picker's tap), the others kept or derived from the uid. @param {string} seed @param {string} uid @param {string} key @param {number} value */
export function setPart(seed, uid, key, value) {
  const spec = PARTS.find((p) => p.key === key);
  if (!spec) return fill(seed, uid);
  const v = ((Math.trunc(value) % spec.words.length) + spec.words.length) % spec.words.length;
  const whole = fill(seed, uid);
  const parts = { ...read(whole), [key]: v };
  return base(whole) + PARTS.map((p) => `~${p.key}${parts[p.key]}`).join("");
}

// The looks the app has seen, by agent name, so a face that is only given a name (a chat's header, a message) draws the agent as its sidebar row does.
/** @type {Map<string, string>} */ const seen = new Map();
/** Remember an agent's look (what agents.list says). @param {string} name @param {string | null | undefined} look */
export const rememberLook = (name, look) => { if (name && look) seen.set(String(name).toLowerCase(), String(look)); };
/** The look the app has seen for an agent, or "". @param {string} name */
export const lookFor = (name) => seen.get(String(name || "").toLowerCase()) ?? "";
