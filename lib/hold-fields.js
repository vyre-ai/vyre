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

/** The most the person is shown of one field, and of one call. */
export const WORDS_FIELD_MAX = 4000, WORDS_TOTAL_MAX = 12_000;

/**
 * The exact words of a held call, for the person to read: every string field of its input, in the input's order, each cut at WORDS_FIELD_MAX and the whole at WORDS_TOTAL_MAX. They are made from the same input
 * the digest in holdFields covers, so what is shown is what a yes covers.
 * @param {any} input @returns {{ field: string, text: string, cut: boolean }[]}
 */
export function wordsOf(input) {
  /** @type {{ field: string, text: string, cut: boolean }[]} */ const out = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  let left = WORDS_TOTAL_MAX;
  for (const k of Object.keys(input)) {
    const v = input[k];
    if (typeof v !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(k) || left <= 0) continue;
    const take = Math.min(WORDS_FIELD_MAX, left, v.length);
    out.push({ field: k, text: v.slice(0, take), cut: take < v.length });
    left -= take;
  }
  return out;
}

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
