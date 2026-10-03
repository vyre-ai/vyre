// @ts-check
// Sealed values in a model-facing view (contract 8.3, invariant 5). A sealed field holds a reference; a model, an index, a log and a
// suggestion hold only the placeholder. These helpers are the one place that decides what "shown to a model" means, and they never see a value.

/** @param {any} v a field value */
export const isSealedValue = v => Boolean(v) && typeof v === "object" && typeof v.sealed === "string" && ("present" in v || "ref" in v);

/** The placeholder a model sees: no ref, no hint. @param {any} v @returns {{ sealed: string, present: boolean, valid_format: boolean }} */
export const placeholderOf = v => ({ sealed: String(v.sealed), present: Boolean(v.present), valid_format: Boolean(v.valid_format) });

/**
 * A record's data with every sealed field turned into its placeholder. Applied again at every boundary, because a store or a caller may have
 * handed over the reference form. @param {Readonly<Record<string, any>>} data
 */
export function modelView(data) {
  /** @type {Record<string, any>} */ const out = {};
  for (const [k, v] of Object.entries(data || {})) out[k] = isSealedValue(v) ? placeholderOf(v) : v;
  return out;
}

/** Text for a model or an index: a sealed field reads "[name: sealed, present]" and nothing more. @param {string} name @param {any} v */
export const sealedText = (name, v) => `[${name}: sealed${v && v.present ? ", present" : ", empty"}]`;

/** The field names of `data` that are sealed. @param {Readonly<Record<string, any>>} data */
export const sealedFields = data => Object.entries(data || {}).filter(([, v]) => isSealedValue(v)).map(([k]) => k);
