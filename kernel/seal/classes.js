// kernel/seal/classes.js: the sealed classes and their detectors. Declarative: a fixed set of checksums and patterns the kernel ships.
// A Kit or module cannot supply a class with code (R5-8). Detectors are best effort and say so; field seals are the deterministic part.
import { compact, fold } from "./normalise.js";

const digits = v => compact(v).replace(/[^0-9]/g, "");
const luhn = d => { let s = 0; for (let i = 0; i < d.length; i++) { let n = +d[d.length - 1 - i]; if (i % 2) { n *= 2; if (n > 9) n -= 9; } s += n; } return s % 10 === 0; };
const aba = d => d.length === 9 && (3 * (+d[0] + +d[3] + +d[6]) + 7 * (+d[1] + +d[4] + +d[7]) + (+d[2] + +d[5] + +d[8])) % 10 === 0;
const IBAN_LEN = { DE: 22, GB: 22, FR: 27, ES: 24, IT: 27, NL: 18, BE: 16, CH: 21, AT: 20, IE: 22, PT: 25, SE: 24, NO: 15, DK: 18, FI: 18, PL: 28, LU: 20, MT: 31 };
const iban = v => {
  const s = String(v).replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s) || IBAN_LEN[s.slice(0, 2)] !== s.length) return false;
  let r = 0; for (const ch of s.slice(4) + s.slice(0, 4)) r = (r * (/\d/.test(ch) ? 10 : 100) + (/\d/.test(ch) ? +ch : ch.charCodeAt(0) - 55)) % 97;
  return r === 1;
};
const ssn = d => d.length === 9 && !/^(000|666|9)/.test(d) && d.slice(3, 5) !== "00" && d.slice(5) !== "0000";
const itin = d => d.length === 9 && d[0] === "9" && /^(5\d|6[0-5]|7\d|8[0-8]|9[0-2]|9[4-9])$/.test(d.slice(3, 5));
const EIN_PREFIX = new Set("01 02 03 04 05 06 10 11 12 13 14 15 16 20 21 22 23 24 25 26 27 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 50 51 52 53 54 55 56 57 58 59 60 61 62 63 64 65 66 67 68 71 72 73 74 75 76 77 80 81 82 83 84 85 86 87 88 90 91 92 93 94 95 98 99".split(" "));
const ein = d => d.length === 9 && EIN_PREFIX.has(d.slice(0, 2));
const card = d => d.length >= 13 && d.length <= 19 && /^[2-6]/.test(d) && luhn(d);

/** label: what a model is told is there; validate: whether the value looks like the class (valid_format), computed at write time. */
export const CLASSES = Object.freeze({
  "us-ssn": { label: "US SSN", validate: v => ssn(digits(v)) },
  "us-itin": { label: "US ITIN", validate: v => itin(digits(v)) },
  "us-ein": { label: "US EIN", validate: v => ein(digits(v)) },
  "card": { label: "card number", validate: v => card(digits(v)) },
  "bank-account": { label: "bank account", validate: v => /^\d{4,17}$/.test(digits(v)) && digits(v) === compact(v) },
  "routing-number": { label: "routing number", validate: v => aba(digits(v)) },
  "iban": { label: "IBAN", validate: iban },
  "passport": { label: "passport", validate: v => /^[a-z0-9]{6,9}$/.test(compact(v)) },
  "tax-id": { label: "tax id", validate: v => /^[a-z0-9]{8,15}$/.test(compact(v)) },
  "medical": { label: "medical", validate: v => String(v).length > 0 },
  "free": { label: "sealed", validate: v => String(v).length > 0 },
});

/** The hint a field may carry when its seal config allows it: the last four, only of a value long enough that they reveal little. */
export const hintOf = v => { const c = compact(v); return c.length >= 8 ? `last4 ${c.slice(-4)}` : undefined; };

const DW = "(?:zero|oh|nought|one|two|three|four|five|six|seven|eight|nine)";
const RUN = new RegExp(`(?<![0-9a-z])(?:[0-9０-９][\\s\\-.]?){8,18}[0-9０-９](?![0-9a-z])|(?<![a-z])(?:${DW}[\\s,.\\-]*){8,18}${DW}(?![a-z])|\\b\\d{2}-\\d{7}\\b|\\b[A-Z]{2}\\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\\b`, "gi");

/** Classify one candidate run, or null. A 9-digit run is an SSN only as 9 together or grouped 3-2-4, so a ZIP+4 is not one. */
function classify(run, before) {
  if (iban(run)) return "iban";
  const d = digits(fold(run)), grouped = /^\d{3}[\s\-.]\d{2}[\s\-.]\d{4}$/.test(run) || /^\d{9}$/.test(run) || !/\d/.test(run);
  if (/^\d{2}-\d{7}$/.test(run)) return ein(d) ? "us-ein" : null;
  if (d.length === 9) {
    if (/routing|aba|transit/i.test(before) && aba(d)) return "routing-number";
    if (!grouped) return null;
    return itin(d) ? "us-itin" : ssn(d) ? "us-ssn" : null;
  }
  return card(d) ? "card" : null;
}

/** Find sealed-looking values in text: [{ start, end, class }], non overlapping, in order. Best effort: it misses unusual formats. */
export function detect(text) {
  const t = String(text), out = [];
  for (const m of t.matchAll(RUN)) { const cls = classify(m[0], t.slice(Math.max(0, m.index - 30), m.index)); if (cls) out.push({ start: m.index, end: m.index + m[0].length, class: cls }); }
  return out;
}
/** Replace each find with `[sealed: US SSN #n]`. `number(class, value)` keeps a session's numbers stable (the same value is the same n). @returns {{ text: string, found: { class: string, n: number, value: string }[] }} */
export function redact(text, number = (() => { const seen = new Map(); return (cls, value) => { const k = `${cls}\0${compact(value)}`; if (!seen.has(k)) seen.set(k, [...seen.keys()].filter(x => x.startsWith(cls + "\0")).length + 1); return seen.get(k); }; })()) {
  const t = String(text), found = [];
  let out = "", at = 0;
  for (const f of detect(t)) {
    const n = number(f.class, t.slice(f.start, f.end));
    out += t.slice(at, f.start) + `[sealed: ${CLASSES[f.class].label} #${n}]`; at = f.end;
    found.push({ class: f.class, n, value: t.slice(f.start, f.end) });
  }
  return { text: out + t.slice(at), found };
}
