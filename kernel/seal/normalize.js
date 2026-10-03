// kernel/seal/normalize.js: the one normaliser (contract 8.4 and 8.8). The detectors and the seal ledger both match on
// the normalised form: full-width characters mapped, digits written as words turned into digits, separators dropped.
// `normalize` also returns where each normalised character came from, so a detector can replace the original span.

const WORDS = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
const WORD_RE = /^(zero|one|two|three|four|five|six|seven|eight|nine)(?![a-z])/i;

/** Full-width forms (U+FF10-FF19, U+FF21-FF3A, U+FF41-FF5A) to ASCII; one code unit in, one out. */
function ascii(/** @type {string} */ ch) {
  const c = ch.codePointAt(0) || 0;
  if (c >= 0xff10 && c <= 0xff19) return String.fromCharCode(c - 0xff10 + 48);
  if (c >= 0xff21 && c <= 0xff3a) return String.fromCharCode(c - 0xff21 + 65);
  if (c >= 0xff41 && c <= 0xff5a) return String.fromCharCode(c - 0xff41 + 97);
  return ch;
}

/**
 * @param {string} text
 * @returns {{ norm: string, start: number[], end: number[] }} norm: lowercase letters and digits only (separators dropped, digit words as digits);
 *   start[i], end[i]: the span of `text` the i-th normalised character came from
 */
export function normalize(text) {
  let norm = "";
  const start = [], end = [];
  const s = String(text);
  for (let i = 0; i < s.length; ) {
    const ch = ascii(s[i]);
    const wordHere = /[a-z]/i.test(ch) && (i === 0 || !/[a-z]/i.test(ascii(s[i - 1])));
    if (wordHere) {
      const m = WORD_RE.exec(s.slice(i).split("").map(ascii).join(""));
      if (m) { norm += WORDS[/** @type {"zero"} */ (m[1].toLowerCase())]; start.push(i); end.push(i + m[1].length); i += m[1].length; continue; }
    }
    if (/[0-9a-z]/i.test(ch)) { norm += ch.toLowerCase(); start.push(i); end.push(i + 1); }
    i++;
  }
  return { norm, start, end };
}

/** Just the normalised text, for ledger keys. */
export const normalized = (/** @type {string} */ text) => normalize(text).norm;
