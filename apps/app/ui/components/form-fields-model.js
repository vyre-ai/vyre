// The questions of a card's form (an Ask step's `form`, kernel/flows/schema.js FORM_KINDS): the blank answers, what is still missing, and what is handed in.
// Pure, no React (form-fields-model.test.js). The engine checks the answers again when the Flow reads them (kernel/flows/form.js); this is what lets the person see it first.

/** @typedef {{ name: string, label?: string, kind?: string, required?: boolean, choices?: string[] }} FormField */

/** The text a question is shown with. @param {FormField} f */
export const labelOf = (f) => String(f.label || f.name);

/** Blank answers: text for every kind except a yes or no, which starts as no. @param {FormField[]} fields @returns {Record<string, string | boolean>} */
export const blank = (fields) => Object.fromEntries(fields.map((f) => [f.name, f.kind === "boolean" ? false : ""]));

/** The labels of the required questions with no answer yet (a yes or no always has one). @param {FormField[]} fields @param {Record<string, any>} values */
export const missing = (fields, values) => fields.filter((f) => f.required && f.kind !== "boolean" && String(values[f.name] ?? "").trim() === "").map(labelOf);

/** What is handed in: only the answered questions; a yes or no as true or false, everything else as the text typed (the engine reads a number or a day from it). @param {FormField[]} fields @param {Record<string, any>} values */
export function submission(fields, values) {
  /** @type {Record<string, string | boolean>} */ const out = {};
  for (const f of fields) {
    const v = values[f.name];
    if (f.kind === "boolean") out[f.name] = v === true;
    else if (String(v ?? "").trim() !== "") out[f.name] = String(v).trim();
  }
  return out;
}

/** Whether a task's `form` is a list of questions this component can show (an older card's form is an object with other words and is left alone). @param {any} form */
export const isQuestions = (form) => Array.isArray(form) && form.length > 0 && form.every((f) => f && typeof f === "object" && typeof f.name === "string");
