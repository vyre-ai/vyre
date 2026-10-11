// @ts-check
// holds.js: shared by tests (not a test itself). Two ways to look for a value in a serialized log, frame list or event list without being fooled by the random ids and the millisecond times such a log
// always holds. JSON.stringify(log).includes("4200") says yes about a uuid, a message id or a time about one run in a hundred (measured: 3 hits in 500 runs of core/stream/chat-kernel.test.js).

/** @param {string} s */
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does the structure hold `needle` as a VALUE? A number matches only when equal; a string only as a whole word (not inside a longer run of letters, digits, `-` or `_`). Keys are not searched.
 * Use it where the needle is a whole value (a fee, a word). Use leaks() where the needle may be a fragment of a secret.
 * @param {unknown} value @param {string | number} needle
 */
export function holds(value, needle) {
  const re = new RegExp(`(?<![A-Za-z0-9_-])${esc(String(needle))}(?![A-Za-z0-9_-])`);
  const walk = (/** @type {any} */ v) => v == null ? false : typeof v === "string" ? re.test(v) : typeof v === "number" || typeof v === "boolean" ? String(v) === String(needle) : Array.isArray(v) ? v.some(walk) : typeof v === "object" ? Object.values(v).some(walk) : false;
  return walk(value);
}

/**
 * The runs the system itself makes up, which can contain any short digit string by chance and never hold a secret: a uuid (dashed, with or without a `name_` prefix), a hex hash of 32 characters
 * or more (a sha-256, a uuid without dashes), a `name_` id followed by 16 or more hex digits (a seal ref, a message id),, and a millisecond epoch time (exactly 13 digits, 1.5 to 1.9 trillion). Nothing else is excused: a card number is 16 digits, an SSN 9, a passport shorter.
 */
const NOISE = [
  /^(?:[A-Za-z][A-Za-z0-9]*_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  /^[0-9a-f]{32,}$/,
  /^[A-Za-z][A-Za-z0-9]*_[0-9a-f]{16,}$/,
  /^1[5-9]\d{11}$/,
];

/**
 * Does the structure carry `needle` anywhere, as a value, as a fragment of a longer string or in a key, EXCEPT inside a uuid, a long hex hash or a millisecond time? It is for "this secret, or any part of
 * it, must not be in the log": it fails for `***6789`, `ab4471zk9`, `x6789y` and a bare 16-digit card number, exactly like a plain substring search, and passes only when every occurrence sits inside one of
 * the system's own random runs. A run is the longest stretch of letters, digits, `_` and `-` around the occurrence.
 * @param {unknown} value @param {string | number} needle
 */
export function leaks(value, needle) {
  const text = JSON.stringify(value) ?? "";
  const n = String(needle);
  if (!n) return false;
  for (let i = text.indexOf(n); i >= 0; i = text.indexOf(n, i + 1)) {
    let a = i, b = i + n.length;
    while (a > 0 && /[A-Za-z0-9_-]/.test(text[a - 1])) a--;
    while (b < text.length && /[A-Za-z0-9_-]/.test(text[b])) b++;
    const run = text.slice(a, b);
    if (!NOISE.some(re => re.test(run))) return true;
  }
  return false;
}
