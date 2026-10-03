// kernel/seal/detect.js: detectors (contract 8.8). Best effort, said plainly: they find common patterns in text on
// its way to a model, after normalising, and the caller replaces each match with a reference. They miss unusual formats
// and split numbers, and they flag lookalikes. Field seals are deterministic; detectors are not.
import { normalize } from "./normalize.js";
import { luhn, aba, ssn, itin, iban, ein } from "./classes.js";

/** Class, label and validator for each fixed-length digit class, in the order they are claimed (first match wins a span). */
const DIGIT_CLASSES = /** @type {const} */ ([
  { cls: "us-itin", label: "US ITIN", lens: [9], ok: itin },
  { cls: "us-ssn", label: "US SSN", lens: [9], ok: ssn },
  { cls: "routing-number", label: "routing number", lens: [9], ok: aba },
  { cls: "card", label: "card number", lens: [19, 18, 17, 16, 15, 14, 13], ok: luhn },
]);

/** IBAN length by country, for the common ones. A candidate with another length is not an IBAN (a bare mod-97 check passes by luck about one time in 97). */
const IBAN_LEN = /** @type {Record<string, number>} */ ({ GB: 22, DE: 22, FR: 27, ES: 24, IT: 27, NL: 18, BE: 16, CH: 21, AT: 20, IE: 22, PL: 28, PT: 25, SE: 24, NO: 15, DK: 18, FI: 18, LU: 20, AE: 23, SA: 24, GR: 27, CZ: 24, HU: 28, RO: 24, TR: 26, IL: 23, QA: 29, KW: 30, BH: 22, PK: 24, MT: 31 });

/**
 * @param {string} text
 * @returns {{ cls: string, label: string, from: number, to: number }[]} non-overlapping matches over the ORIGINAL text, left to right
 */
export function detect(text) {
  const { norm, start, end } = normalize(text);
  /** @type {{ cls: string, label: string, from: number, to: number }[]} */ const found = [];
  const taken = new Array(norm.length).fill(false);
  const free = (/** @type {number} */ a, /** @type {number} */ b) => { for (let i = a; i < b; i++) if (taken[i]) return false; return true; };
  const claim = (/** @type {string} */ cls, /** @type {string} */ label, /** @type {number} */ a, /** @type {number} */ b) => {
    for (let i = a; i < b; i++) taken[i] = true;
    found.push({ cls, label, from: start[a], to: end[b - 1] });
  };
  const alnum = (/** @type {string | undefined} */ c) => c !== undefined && /[0-9a-z]/i.test(c);
  const edgeOk = (/** @type {number} */ a, /** @type {number} */ b) => !alnum(text[start[a] - 1]) && !alnum(text[end[b - 1]]);

  // An EIN is told apart from other nine-digit numbers only by its dash, so the dashed form is claimed first.
  for (const m of text.matchAll(/(?<![0-9])[0-9]{2}-[0-9]{7}(?![0-9])/g)) {
    const from = m.index ?? 0, to = from + m[0].length;
    if (!ein(m[0].replace("-", ""))) continue;
    const a = start.findIndex(x => x >= from), b = start.findIndex(x => x >= to);
    claim("us-ein", "US EIN", a, b === -1 ? norm.length : b);
  }
  // IBANs: the country's length, the checksum, and a clean edge on both sides.
  for (const m of norm.matchAll(/[a-z]{2}[0-9]{2}[a-z0-9]{11,30}/g)) {
    const i = m.index ?? 0, want = IBAN_LEN[m[0].slice(0, 2).toUpperCase()];
    if (want && i + want <= norm.length && free(i, i + want) && edgeOk(i, i + want) && iban(norm.slice(i, i + want))) claim("iban", "IBAN", i, i + want);
  }
  // Digit groups: a gap in the original (a space, dash or dot) separates groups. A window is accepted when it starts and
  // ends on a gap between groups of two or more digits (or at the edge of the run), so "123-45-6789 987-65-4321" is two numbers.
  // A gap is a space, dash or dot (or their full-width forms). Any other character between two written digits (a comma, a slash,
  // a colon) ends the number, so "1,234,567.89" and "2024/10/03" are not read as one long digit run. Spoken digits may take commas.
  const SEP = /^[\s\-.\u2010-\u2015\u2212\uFF0D\uFF0E]*$/;
  const spoken = (/** @type {number} */ i) => end[i] - start[i] > 1;
  const hard = (/** @type {number} */ i) => i > 0 && start[i] > end[i - 1] && !SEP.test(text.slice(end[i - 1], start[i])) && !spoken(i) && !spoken(i - 1);
  const grp = new Array(norm.length).fill(0);
  for (let i = 1; i < norm.length; i++) grp[i] = grp[i - 1] + (start[i] > end[i - 1] || !/[0-9]/.test(norm[i]) || !/[0-9]/.test(norm[i - 1]) ? 1 : 0);
  const size = /** @type {Record<number, number>} */ ({});
  for (const g of grp) size[g] = (size[g] || 0) + 1;
  const isDigit = (/** @type {number} */ i) => /[0-9]/.test(norm[i]);
  const boundary = (/** @type {number} */ i) => i <= 0 || i >= norm.length || !isDigit(i - 1) || !isDigit(i) || (grp[i] !== grp[i - 1] && size[grp[i - 1]] >= 2 && size[grp[i]] >= 2);
  // Runs of digits with no hard break inside.
  /** @type {{ base: number, run: string }[]} */ const runs = [];
  for (const m of norm.matchAll(/[0-9]+/g)) {
    let from = m.index ?? 0;
    for (let i = from + 1; i <= (m.index ?? 0) + m[0].length; i++) if (i === (m.index ?? 0) + m[0].length || hard(i)) { runs.push({ base: from, run: norm.slice(from, i) }); from = i; }
  }
  for (const { base, run } of runs) {
    {
    for (const c of DIGIT_CLASSES) for (const len of c.lens) {
      for (let k = 0; k + len <= run.length; k++) {
        const a = base + k, b = a + len;
        if (!boundary(a) || !boundary(b) || !free(a, b) || !c.ok(norm.slice(a, b))) continue;
        claim(c.cls, c.label, a, b);
      }
    }
    }
  }
  return found.sort((x, y) => x.from - y.from);
}

/**
 * Replace each detection with `[sealed: US SSN #1]`, numbering per class. Returns the sanitised text and the originals
 * (the caller keeps those only in the sealing process, bound to the session, and deletes them when the session ends).
 * @param {string} text
 */
export function sanitize(text) {
  const hits = detect(text);
  const n = /** @type {Record<string, number>} */ ({});
  let out = "", at = 0;
  const originals = [];
  for (const h of hits) {
    n[h.cls] = (n[h.cls] || 0) + 1;
    out += text.slice(at, h.from) + `[sealed: ${h.label} #${n[h.cls]}]`;
    originals.push({ cls: h.cls, label: h.label, index: n[h.cls], value: text.slice(h.from, h.to) });
    at = h.to;
  }
  return { text: out + text.slice(at), detections: hits.length, originals };
}
