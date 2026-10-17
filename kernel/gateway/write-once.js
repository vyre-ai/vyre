// @ts-check
// Write-once fields (roadmap 7): a field marked `write_once` keeps the first value it was given. The gateway asks this file whether a definition or a write breaks that, and says no in words.
import { isEmpty } from "../../lib/expr/conditions.js";

/** The words a definition is refused with when write_once is not true or false, or sits on a field that is worked out. @param {any} f @returns {string | null} */
export function writeOnceShape(f) {
  if (f.write_once === undefined) return null;
  if (typeof f.write_once !== "boolean") return `${f.name}: write_once is true or false`;
  return f.write_once && (f.computed !== undefined || f.kind === "stage") ? `${f.name}: a ${f.computed !== undefined ? "computed" : "stage"} field cannot be write-once` : null;
}

/** The words an update is refused with when it changes or clears a write-once field that already holds a value (a write of the same value passes). @param {any[]} fields @param {any} before @param {any} input @param {string} type @returns {string | null} */
export function writeOnceBreach(fields, before, input, type) {
  for (const f of fields) {
    if (f.write_once !== true || !input || !Object.prototype.hasOwnProperty.call(input, f.name)) continue;
    const was = before && before.data ? before.data[f.name] : undefined;
    if (!isEmpty(was) && JSON.stringify(was) !== JSON.stringify(input[f.name])) return `${f.label || f.name} can only be set once, and this ${type} already has it. Leave it as it is.`;
  }
  return null;
}

/** The names of a type's write-once fields. @param {any} def */
export const writeOnceNames = (def) => new Set(((def && def.fields) || []).filter((/** @type {any} */ f) => f.write_once === true).map((/** @type {any} */ f) => f.name));
