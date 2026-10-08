// @ts-check
// What a held outward call's card is made of (the one yes, DESIGN-one-yes): the same three functions for the registry that holds a call and the approvals queue that shows, groups and lets the person
// edit it, so a card and the call it covers are computed one way.
import { createHash } from "node:crypto";

/** @param {any} v @returns {any} */
const canonOf = v => (Array.isArray(v) ? v.map(canonOf) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonOf(v[k])])) : v);

/**
 * What a held outward call's card is bound to: its plain short fields (so the phone can show them) and a digest of the whole input (so the yes covers exactly this call, whatever is long or nested in it).
 * @param {any} input @returns {Record<string, string | number | boolean>}
 */
export function holdFields(input) {
  /** @type {Record<string, string | number | boolean>} */ const f = {};
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const k of Object.keys(input)) {
      const v = input[k];
      if (Object.keys(f).length < 10 && /^[a-z][a-z0-9_]{0,31}$/.test(k) && k !== "input_sha256" && (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 200))) f[k] = v;
    }
  }
  f.input_sha256 = createHash("sha256").update(JSON.stringify(canonOf(input === undefined ? null : input))).digest("hex").slice(0, 32);
  return f;
}

/** The most the person is shown of one value, of one call, and how many values and how deep a call may go before part of it is not shown. */
export const WORDS_FIELD_MAX = 4000, WORDS_TOTAL_MAX = 12_000, WORDS_LEAVES_MAX = 200, WORDS_DEPTH_MAX = 6;
const PATH_MAX = 80;

/**
 * Everything a held call carries, for the person to read: EVERY value in its input, flattened with its path (`to[0]`, `headers.bcc`, `attachments[1].name`, `amount`), strings, numbers, booleans and empty
 * values alike, in the input's order. The yes covers the digest of the WHOLE input (holdFields), so nothing a yes covers may be left out of what is shown. Where a value is cut, the input has more values than
 * WORDS_LEAVES_MAX, is nested deeper than WORDS_DEPTH_MAX or the whole is longer than WORDS_TOTAL_MAX, the call is `partial`: part of it is not shown, and the card says so.
 * @param {any} input @returns {{ words: { field: string, text: string, cut: boolean }[], partial: boolean }}
 */
export function viewOf(input) {
  /** @type {{ field: string, text: string, cut: boolean }[]} */ const words = [];
  let partial = false, left = WORDS_TOTAL_MAX;
  const clean = (/** @type {string} */ s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "\uFFFD");
  /** @param {any} v @param {string} path @param {number} depth */
  const walk = (v, path, depth) => {
    if (words.length >= WORDS_LEAVES_MAX) { partial = true; return; }
    if (v !== null && typeof v === "object") {
      if (depth >= WORDS_DEPTH_MAX) { partial = true; return; }
      const entries = Array.isArray(v) ? v.map((x, i) => [`${path}[${i}]`, x]) : Object.keys(v).map(k => [path ? `${path}.${k}` : k, v[k]]);
      if (!entries.length) { words.push({ field: clean(path).slice(0, PATH_MAX), text: Array.isArray(v) ? "[]" : "{}", cut: false }); return; }
      for (const [p, x] of entries) walk(x, /** @type {string} */ (p), depth + 1);
      return;
    }
    if (left <= 0) { partial = true; return; }
    const full = v === null || v === undefined ? "(empty)" : typeof v === "string" ? v : String(v);
    const take = Math.min(WORDS_FIELD_MAX, left, full.length);
    const cut = take < full.length;
    if (cut) partial = true;
    words.push({ field: clean(path || "(input)").slice(0, PATH_MAX), text: clean(full.slice(0, take)), cut });
    left -= take;
  };
  walk(input === undefined ? null : input, "", 0);
  return { words, partial };
}

/** The words only (see viewOf). @param {any} input */
export const wordsOf = input => viewOf(input).words;

/**
 * The person's edit of a held call: new text for some of the string fields the input already has. Nothing else changes, no field is added, and a field that was not text is not touched. Throws a
 * reason when an edit is not that. @param {any} input @param {any} edits @returns {Record<string, any>} the edited input
 */
export function editedInput(input, edits) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("this call has nothing to edit");
  if (!edits || typeof edits !== "object" || Array.isArray(edits) || !Object.keys(edits).length || Object.keys(edits).length > 12) throw new Error("name the fields to change and their new text");
  const out = { ...input };
  for (const [k, v] of Object.entries(edits)) {
    if (typeof input[k] !== "string") throw new Error(`${k} is not a text field of this call`);
    if (typeof v !== "string" || v.length > WORDS_FIELD_MAX * 2) throw new Error(`${k} must be text up to ${WORDS_FIELD_MAX * 2} characters`);
    out[k] = v;
  }
  return out;
}
