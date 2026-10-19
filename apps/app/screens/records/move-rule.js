// @ts-check
// One rule for changing a stage, wherever the person does it: a drag on a board, a tap on the stage strip, a bulk edit. The box says what a stage still needs (records.move answers { needs: [field names] }
// and writes nothing); this file is the screen's side of that: the words, the fields to ask for, and when "Continue" may be pressed.

/** The field names a records.move answer says are still missing, or null when the move went through. @param {any} res */
export const readNeeds = (res) => (res && Array.isArray(res.needs) && res.needs.length ? res.needs.map(String) : null);

/** The field a need names: the type's own, or a plain text field for the lost reason a type may not define yet. @param {any} def @param {string} name */
export function fieldFor(def, name) {
  const own = (def && Array.isArray(def.fields) ? def.fields : []).find((/** @type {any} */ f) => f && f.name === name);
  if (own) return own;
  return { name, label: name === "lost_reason" ? "Lost reason" : name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), kind: "text" };
}

/** The sentence at the top of the sheet. @param {string} title @param {string} stage @param {string[]} labels */
export const needSentence = (title, stage, labels) => `To move ${title} to ${stage}, fill in: ${labels.join(", ")}.`;

/** The same, for several records at once. @param {number} count @param {string} noun @param {string} stage @param {string[]} labels */
export const needSentenceMany = (count, noun, stage, labels) => `To move ${count} ${noun} to ${stage}, fill in: ${labels.join(", ")}. It is used for any that are missing it.`;

const empty = (/** @type {any} */ v) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);

/** Whether every needed field has a value, so the sheet's Continue is allowed. @param {string[]} needs @param {Record<string, any>} draft */
export const readyToGo = (needs, draft) => needs.every((n) => !empty(draft[n]));

/** The input of records.move. @param {string} urn @param {string} stage @param {Record<string, any>} [patch] */
export const moveInput = (urn, stage, patch) => ({ urn, stage, ...(patch && Object.keys(patch).length ? { patch } : {}) });

/** Whether a board's group-by field is a stage (a move there is a stage move, with the rule) rather than a plain choice. @param {any} def @param {string | undefined} groupBy */
export const isStageGroup = (def, groupBy) => !!groupBy && (def && Array.isArray(def.fields) ? def.fields : []).some((/** @type {any} */ f) => f && f.name === groupBy && f.kind === "stage");
