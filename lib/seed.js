// @ts-check
// seed — the block Vyre puts in front of a rolled session's first message (core/switchboard/rollover.js builds it).
//
// A rolled session's first user turn is the seed followed by the person's own words. Anything that reads the person's words (memory search, learning, a title, a pointer
// label) must read only those: this is the one place that says where the seed ends.

/** The seed opens with this. */
export const SEED_OPEN = "[Vyre continuation:";
/** and ends at the first closing bracket on a line of its own, then a blank line, then the person's words. */
const SEED_END = /\n\]\n\n/;

/**
 * A message's own words, without any Vyre block carried in front of it: a rollover's or a switch's seed, a note of what happened while a provider was away. Each is
 * `[Vyre ...` and ends at the first closing bracket on a line of its own followed by a blank line (the Switchboard joins its blocks that way).
 * @param {string} text
 */
export function withoutVyre(text) {
  let t = String(text);
  for (let n = 0; n < 4 && /^\[Vyre[ :]/.test(t); n++) {
    const m = SEED_END.exec(t);
    if (!m) return "";
    t = t.slice(m.index + m[0].length);
  }
  return t;
}

/**
 * A message's own words, without a seed carried in front of it. A message that is only a seed has no words of its own: "".
 * @param {string} text
 */
export function withoutSeed(text) {
  const t = String(text);
  if (!t.startsWith(SEED_OPEN)) return t;
  const m = SEED_END.exec(t);
  return m ? t.slice(m.index + m[0].length) : "";
}
