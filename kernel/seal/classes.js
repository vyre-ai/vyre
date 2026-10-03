// kernel/seal/classes.js: the class registry (contract 8.3, R5-8). A fixed set of declarative validators the kernel
// ships: checksums and patterns, no code from a Kit. `valid_format` is computed from these at write time. A class either
// has a fixed shape the ledger and detectors can match inside text (`fixed: true`) or is free-shape (guarantee rests on
// placeholders alone, 8.4).

const digits = (/** @type {string} */ s) => s.replace(/[\s.-]/g, "");
const allDigits = (/** @type {string} */ s) => /^[0-9]+$/.test(s);

export const luhn = (/** @type {string} */ d) => {
  if (!allDigits(d) || d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) { let n = d.charCodeAt(d.length - 1 - i) - 48; if (i % 2) { n *= 2; if (n > 9) n -= 9; } sum += n; }
  return sum % 10 === 0;
};
/** ABA routing: 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) is a multiple of 10. */
export const aba = (/** @type {string} */ d) => {
  if (!/^[0-9]{9}$/.test(d)) return false;
  const n = [...d].map(Number);
  return (3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8])) % 10 === 0 && d !== "000000000";
};
export const ssn = (/** @type {string} */ d) => /^[0-9]{9}$/.test(d) && !/^(000|666|9)/.test(d) && d.slice(3, 5) !== "00" && d.slice(5) !== "0000";
export const itin = (/** @type {string} */ d) => /^9[0-9]{8}$/.test(d) && (() => { const g = Number(d.slice(3, 5)); return (g >= 50 && g <= 65) || (g >= 70 && g <= 88) || (g >= 90 && g <= 92) || (g >= 94 && g <= 99); })();
export const ein = (/** @type {string} */ d) => /^[0-9]{9}$/.test(d) && !/^(00|07|08|09|17|18|19|28|29|49|69|70|78|79|89|96|97)/.test(d);
/** IBAN: country, two check digits, up to 30 alphanumerics; mod 97 over the rearranged number is 1. */
export const iban = (/** @type {string} */ raw) => {
  const s = raw.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  let rem = 0;
  for (const ch of s.slice(4) + s.slice(0, 4)) { const v = /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55); for (const c of v) rem = (rem * 10 + Number(c)) % 97; }
  return rem === 1;
};

/**
 * @typedef {object} SealClassDef
 * @property {string} label the words on a card and in a placeholder
 * @property {(v: string) => boolean} valid
 * @property {boolean} fixed has a fixed shape a detector can find inside text
 * @property {(v: string) => string} [hint] only used if the field's seal config allows a hint
 */
/** @type {Readonly<Record<string, SealClassDef>>} */
export const CLASSES = Object.freeze({
  "us-ssn": { label: "US SSN", valid: v => ssn(digits(v)), fixed: true, hint: v => digits(v).slice(-4) },
  "us-itin": { label: "US ITIN", valid: v => itin(digits(v)), fixed: true, hint: v => digits(v).slice(-4) },
  "us-ein": { label: "US EIN", valid: v => ein(digits(v)) && /^[0-9]{2}-?[0-9]{7}$/.test(v.trim()), fixed: false },
  "card": { label: "card number", valid: v => luhn(digits(v)), fixed: true, hint: v => digits(v).slice(-4) },
  "bank-account": { label: "bank account", valid: v => allDigits(digits(v)) && digits(v).length >= 4 && digits(v).length <= 17, fixed: false, hint: v => digits(v).slice(-4) },
  "routing-number": { label: "routing number", valid: v => aba(digits(v)), fixed: true },
  "iban": { label: "IBAN", valid: v => iban(v), fixed: true, hint: v => v.replace(/\s/g, "").slice(-4) },
  "passport": { label: "passport number", valid: v => /^[A-Za-z0-9]{6,9}$/.test(v.trim()), fixed: false },
  "tax-id": { label: "tax id", valid: v => /^[A-Za-z0-9 .-]{5,20}$/.test(v.trim()), fixed: false },
  "medical": { label: "medical note", valid: v => v.trim().length > 0, fixed: false },
  "free": { label: "sealed value", valid: v => v.length > 0, fixed: false },
});

export const classLabel = (/** @type {string} */ c) => (CLASSES[c] ? CLASSES[c].label : "sealed value");
