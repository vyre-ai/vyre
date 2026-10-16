// @ts-check
// The answers to an Ask step's form (schema.js FORM_KINDS): read from what the person handed in, checked against the form the author wrote, and given to the Flow as `steps.<id>.values`.
// A required question that is empty, a number that is not one, a date that is not a day, a choice that is not on the list: the step fails with the question's own words, so a Flow never carries on
// from an answer the form did not allow. Free text typed here is data to the Flow, never an instruction.

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TEXT_MAX = 2000;

/** @param {any} v */
const empty = v => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/**
 * @param {any} form the step's `form` @param {any} answer the task's answer (the evidence handed in: `{ answer, reason, values }`)
 * @returns {{ ok: true, values: Record<string, any> } | { ok: false, message: string }}
 */
export function readForm(form, answer) {
  const given = answer && typeof answer === "object" && answer.values && typeof answer.values === "object" && !Array.isArray(answer.values) ? answer.values : {};
  /** @type {Record<string, any>} */ const values = {};
  for (const f of Array.isArray(form) ? form : []) {
    const name = String(f.name), label = String(f.label || f.name), raw = given[name];
    if (empty(raw)) {
      if (f.required === true) return { ok: false, message: `the answer to "${label}" is required and was not given` };
      values[name] = null;
      continue;
    }
    switch (f.kind || "text") {
      case "number": {
        const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
        if (!Number.isFinite(n)) return { ok: false, message: `the answer to "${label}" is not a number` };
        values[name] = n; break;
      }
      case "date": {
        const s = String(raw);
        if (!DAY.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`)) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) return { ok: false, message: `the answer to "${label}" is not a day (year-month-day)` };
        values[name] = s; break;
      }
      case "boolean": {
        const s = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
        if (s === true || s === "true" || s === "yes") values[name] = true;
        else if (s === false || s === "false" || s === "no") values[name] = false;
        else return { ok: false, message: `the answer to "${label}" is not yes or no` };
        break;
      }
      case "choice": {
        const s = String(raw);
        if (!Array.isArray(f.choices) || !f.choices.includes(s)) return { ok: false, message: `the answer to "${label}" is not one of its choices` };
        values[name] = s; break;
      }
      case "file": {
        const s = String(raw);
        if (!s || s.length > 500 || s.split("/").includes("..")) return { ok: false, message: `the answer to "${label}" is not a file in Vyre Files` };
        values[name] = s; break;
      }
      default: {
        const s = String(raw);
        if (s.length > TEXT_MAX) return { ok: false, message: `the answer to "${label}" is longer than ${TEXT_MAX} characters` };
        values[name] = s;
      }
    }
  }
  return { ok: true, values };
}
