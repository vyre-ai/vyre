// @ts-check
// An agent's look is picked from a small grid: one of eight shapes (the agent family's bodies, faces and marks, ADR 0043) in one of eight colours. The look is a seed the agent family draws from:
// the shape's own seed, then "~c" and the colour's number. Pure.

export const SHAPES = /** @type {const} */ (["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
export const COLOR_COUNT = 8;

/** The seed for a shape (0 to 7) in a colour (0 to 7). Out-of-range numbers wrap. @param {number} shape @param {number} color */
export const lookSeed = (shape, color) => `${SHAPES[((shape % 8) + 8) % 8]}~c${((color % COLOR_COUNT) + COLOR_COUNT) % COLOR_COUNT}`;

/** The shape and colour a look seed names, or null for a seed that is not a look. The character parts after them (see PARTS) are not read here. @param {string} seed */
export function lookOf(seed) {
  const m = /^s([0-7])~c([0-7])(?:~e[0-5])?(?:~m[0-4])?(?:~t[0-6])?(?:~b[01])?(?:~h[0-5])?$/.exec(String(seed));
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

/** A small stable hash (FNV-1a) of a string, as a number. @param {string} s */
const fnv = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/** The parts a seed names, by key; a part it does not name is absent. @param {string} seed @returns {Record<string, number>} */
export function partsOf(seed) {
  /** @type {Record<string, number>} */ const out = {};
  const m = /(?:~c[0-7])?(?:~e([0-5]))?(?:~m([0-4]))?(?:~t([0-6]))?(?:~b([01]))?(?:~h([0-5]))?$/.exec(String(seed));
  if (m) PARTS.forEach((p, i) => { if (m[i + 1] !== undefined) out[p.key] = Number(m[i + 1]); });
  return out;
}

/** The look seed without its parts (what the shape and colour, or a bare id, still say). @param {string} seed */
export const baseOf = (seed) => String(seed).replace(/(?:~e[0-5])?(?:~m[0-4])?(?:~t[0-6])?(?:~b[01])?(?:~h[0-5])?$/, "");

/** A look seed with every part present: a part it names stays, one it leaves out is drawn from a hash of the agent's uid, so every agent has a character of its own that never changes. @param {string} seed @param {string} uid */
export function withParts(seed, uid) {
  const have = partsOf(seed);
  let out = baseOf(seed);
  for (const p of PARTS) out += `~${p.key}${have[p.key] ?? fnv(`${uid}:${p.key}`) % p.words.length}`;
  return out;
}

/** A look seed with one part changed (the picker's tap), the others kept or derived from the uid. @param {string} seed @param {string} uid @param {string} key @param {number} value */
export function setPart(seed, uid, key, value) {
  const spec = PARTS.find((p) => p.key === key);
  if (!spec) return withParts(seed, uid);
  const v = ((Math.trunc(value) % spec.words.length) + spec.words.length) % spec.words.length;
  const base = baseOf(withParts(seed, uid));
  const parts = { ...partsOf(withParts(seed, uid)), [key]: v };
  return base + PARTS.map((p) => `~${p.key}${parts[p.key]}`).join("");
}

// The looks the app has seen, by agent name, so a face that is only given a name (a chat's header, a message) draws the agent as its sidebar row does.
/** @type {Map<string, string>} */ const seen = new Map();
/** Remember an agent's look (what agents.list says). @param {string} name @param {string | null | undefined} look */
export const rememberLook = (name, look) => { if (name && look) seen.set(String(name).toLowerCase(), String(look)); };
/** The look the app has seen for an agent, or "". @param {string} name */
export const lookFor = (name) => seen.get(String(name || "").toLowerCase()) ?? "";
