// @ts-check
// What may enter the engine's tables (contract 7.9, 8.8): text is scrubbed before it is stored or indexed, so a credential or a value shaped like
// a sealed class never lands in a row even when a person typed it into a chat. The gateway already gives placeholders for sealed fields; this is
// the second wall, for free text (transcripts, notes, mail). Normalised forms count: spaces, dashes and case do not hide a value.

import { findSecrets } from "../../../lib/secret-text.js";

/** @type {{ kind: string, re: RegExp }[]} */
const SHAPES = [
  { kind: "us-ssn", re: /(?<![\d])\d{3}[\s.-]?\d{2}[\s.-]?\d{4}(?![\d])/g },
  { kind: "card", re: /(?<![\d])(?:\d[\s-]?){13,19}(?![\d])/g },
  { kind: "iban", re: /\b[A-Z]{2}\d{2}(?:[\s]?[A-Z0-9]){11,30}\b/gi },
  { kind: "us-ein", re: /(?<![\d])\d{2}-\d{7}(?![\d])/g },
];

/**
 * @typedef {(text: string) => string} Redactor  an extra detector (the real ledger match is the kernel's), returns the text with matches removed
 */

/** The text with every sealed-class shape and credential replaced by "[redacted: kind]". @param {string} text @param {Redactor[]} [extra] @returns {{ text: string, hits: string[] }} */
export function scrub(text, extra = []) {
  let t = String(text ?? "");
  /** @type {string[]} */ const hits = [];
  if (findSecrets(t).length) {
    // A whole line holding a credential shape is dropped, never partly kept.
    t = t.split("\n").map(line => { const f = findSecrets(line); if (f.length) { hits.push(f[0].kind); return "[redacted: credential]"; } return line; }).join("\n");
  }
  for (const s of SHAPES) t = t.replace(s.re, () => { hits.push(s.kind); return `[redacted: ${s.kind}]`; });
  for (const r of extra) { const n = r(t); if (n !== t) { hits.push("ledger"); t = n; } }
  return { text: t, hits };
}

/** True when scrubbing would change the text. @param {string} text @param {Redactor[]} [extra] */
export const looksSealed = (text, extra) => scrub(text, extra).hits.length > 0;
