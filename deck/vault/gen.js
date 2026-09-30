// @ts-check
// Generator settings as a payload, and the card helpers the add form uses. Pure; node tests it.
//
// The generator never makes a value in the page. The form sends
// `generate: { field, length, symbols }` or `generate: { field, words }` inside vault.update, and
// vyred makes the value on the box. The page shows only how strong the settings are.

export const LIMITS = { length: [8, 64], words: [3, 10] };
const SYMBOLS = 13, SYLLABLE_BITS = Math.log2(16 * 5);

/**
 * The payload for vault.update's `generate`, clamped to what vyred accepts.
 * @param {{ field: string, mode?: "chars" | "words", length?: number, symbols?: boolean, words?: number }} s
 */
export function generatePayload({ field, mode = "chars", length = 24, symbols = true, words = 5 }) {
  if (!field) throw new Error("a field to generate into");
  const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, Math.round(Number(v) || lo)));
  return mode === "words" ? { field, words: clamp(words, LIMITS.words) } : { field, length: clamp(length, LIMITS.length), symbols: Boolean(symbols) };
}

/** Bits of the settings (not of any value), as vyred's generate.js counts them. */
export function settingsBits(p) {
  if ("words" in p && p.words) return Math.floor(p.words * 3 * SYLLABLE_BITS * 10) / 10;
  const pool = 26 + 26 + 10 + (p.symbols ? SYMBOLS : 0);
  return Math.floor((p.length || 0) * Math.log2(pool) * 10) / 10;
}

/** Plain words for a strength. */
export const strengthWord = bits => (bits >= 100 ? "Very strong" : bits >= 70 ? "Strong" : bits >= 50 ? "Fair" : "Weak");

// ---- cards -------------------------------------------------------------------------------

/** Digits only. */
export const digits = s => String(s || "").replace(/\D/g, "");

/** @param {string} number */
export function luhn(number) {
  const d = digits(number);
  if (d.length < 12) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let x = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) { x *= 2; if (x > 9) x -= 9; }
    sum += x;
  }
  return sum % 10 === 0;
}

/** The card network from the leading digits. */
export function brand(number) {
  const d = digits(number);
  if (/^4/.test(d)) return "Visa";
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(d)) return "Mastercard";
  if (/^3[47]/.test(d)) return "Amex";
  if (/^(6011|65|64[4-9]|622)/.test(d)) return "Discover";
  if (/^35(2[89]|[3-8]\d)/.test(d)) return "JCB";
  if (/^3(0[0-5]|[68])/.test(d)) return "Diners";
  return "";
}

/** "4242 4242 4242 4242", or Amex's 4-6-5. */
export function group(number) {
  const d = digits(number).slice(0, 19);
  const sizes = brand(d) === "Amex" ? [4, 6, 5] : [4, 4, 4, 4, 3];
  const out = [];
  let i = 0;
  for (const s of sizes) { if (i >= d.length) break; out.push(d.slice(i, i + s)); i += s; }
  return out.join(" ");
}

/** "MM/YY" from what someone typed, or "" while incomplete. */
export function expiry(s) {
  const d = digits(s).slice(0, 4);
  if (d.length < 3) return d;
  return d.slice(0, 2) + "/" + d.slice(2);
}
