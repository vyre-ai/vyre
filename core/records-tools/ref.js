// @ts-check
// The ID a record is given when it is made: a short readable counter with a prefix for its type (PER-0001, ORG-0001, TSK-0001), shown as the type's first field, never changed afterwards. Pure helpers; the tool that
// makes a record (records.create) mints it for a type that has a `ref` field and refuses a change to it (records.update).

/** The prefix of each starting type; any other type uses its first three letters. */
export const REF_PREFIX = Object.freeze({ contact: "PER", organization: "ORG", task: "TSK", memo: "NOT" });

/** @param {string} type */
export const refPrefix = (type) => /** @type {Record<string, string>} */ (REF_PREFIX)[type] || (String(type).replace(/[^a-z0-9]/gi, "").slice(0, 3).toUpperCase() || "REC");

/** The number inside an ID of this prefix, or 0. @param {string} prefix @param {unknown} value */
export const refNumber = (prefix, value) => { const m = new RegExp(`^${prefix}-(\\d+)$`).exec(String(value ?? "")); return m ? Number(m[1]) : 0; };

/** @param {string} prefix @param {number} n */
export const formatRef = (prefix, n) => `${prefix}-${String(n).padStart(4, "0")}`;

/** The next ID after the highest one among the values given (any order, any junk). @param {string} type @param {unknown[]} values */
export function nextRef(type, values) {
  const prefix = refPrefix(type);
  return formatRef(prefix, values.reduce((/** @type {number} */ m, v) => Math.max(m, refNumber(prefix, v)), 0) + 1);
}
