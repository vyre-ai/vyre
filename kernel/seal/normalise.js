// kernel/seal/normalise.js: how a sealed value is recognised in text that is not the value itself. Pure functions, shared by the sealing
// process (which computes ledger entries) and the inference door (which checks prompts), so both fold text the same way (invariant 6).
// Forms covered: case, spacing and separators, full-width digits, digits written as words, percent and \uXXXX escapes, hex, base64 (all three
// byte alignments, standard and url alphabets), a value split across tokens (separators and word breaks are dropped), and a long partial match.
// A transformation beyond that is covered by never giving the model the value, not by this file.
import crypto from "node:crypto";

const WORDS = { zero: 0, oh: 0, nought: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const WORD_RE = new RegExp(`\\b(${Object.keys(WORDS).join("|")})\\b`, "g");

/** Shortest compact value the ledger tracks: below this, a substring match would flag ordinary text, and the placeholders alone protect it. */
export const MIN_LEDGER = 6;

/** Undo the encodings a prompt may carry, then NFKC (full-width to ASCII), lower case, digit words to digits. */
export function fold(text) {
  let s = String(text);
  s = s.replace(/(?:%[0-9a-f]{2})+/gi, m => { try { return decodeURIComponent(m); } catch { return m; } });
  s = s.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return s.normalize("NFKC").toLowerCase().replace(WORD_RE, (_, w) => String(WORDS[w]));
}
/** Stream A: letters and digits only, so spacing, dots, dashes and word breaks cannot hide a value. */
export const compact = text => fold(text).replace(/[^a-z0-9]/g, "");
/** Stream B: case-preserved base64 text, whitespace and padding gone, the url alphabet mapped to the standard one. */
export const b64stream = text => String(text).replace(/[^A-Za-z0-9+/_-]/g, "").replace(/-/g, "+").replace(/_/g, "/");

/** The base64 text of `value` that does not depend on its neighbours, for each of the three byte alignments. */
function b64forms(buf) {
  const out = [];
  for (let k = 0; k < 3; k++) {
    const s = Buffer.concat([Buffer.alloc(k), buf]).toString("base64").replace(/=+$/, "");
    const head = [0, 2, 3][k], tail = [0, 2, 3][(k + buf.length) % 3];
    const part = s.slice(head, tail ? s.length - tail : s.length);
    if (part.length >= MIN_LEDGER) out.push(part);
  }
  return out;
}

/** Every form of `value` to look for: { a: stream A strings, b: stream B strings }. */
export function forms(value) {
  const raw = Buffer.from(String(value), "utf8"), c = compact(value);
  const a = new Set(), b = new Set();
  if (c.length >= MIN_LEDGER) { a.add(c); a.add(raw.toString("hex")); a.add(Buffer.from(c).toString("hex")); }
  for (const f of b64forms(raw)) b.add(f);
  if (c !== String(value)) for (const f of b64forms(Buffer.from(c))) b.add(f);
  return { a: [...a], b: [...b] };
}

/** The windows to hash for one form: the whole form, and for a long one every window of 75% (at least 8) so a long partial match is caught too. */
export function windowLengths(len) { return len >= 9 ? [len, Math.max(8, Math.ceil(len * 0.75))] : [len]; }
export function* windows(form) {
  for (const w of new Set(windowLengths(form.length))) for (let i = 0; i + w <= form.length; i++) yield form.slice(i, i + w);
}

/** A keyed hash of a window. The key is per session and in memory only; the plaintext is never kept. */
export const keyed = (key, s) => crypto.createHash("sha256").update(key).update("\0").update(s).digest("hex").slice(0, 32);

/** Ledger entries for a value: [{ len, h, class }], the only thing the sealing process hands the door about a value. */
export function ledgerEntries(value, cls, key) {
  const f = forms(value), out = [];
  for (const [stream, list] of [["a", f.a], ["b", f.b]]) for (const form of list) for (const w of windows(form)) out.push({ s: stream, len: w.length, h: keyed(key, w), class: cls });
  return out;
}
