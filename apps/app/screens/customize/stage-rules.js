// @ts-check
// A stage's rules, in words a person edits: which fields it needs filled in before a record may enter it, and whether it is a lost stage (which needs a reason). The box stores a plain entry condition
// ("not empty(value) and not empty(close_date)"); records.pipeline.set takes the plain list and writes that condition, so no one writes an expression here. This reads the stored form back.

export const LOST_REASON = "lost_reason";

/** The fields a stored entry condition asks for, when it is one that records.pipeline.set wrote; any other condition reads as none (it stays the kernel's). @param {string | undefined} cond */
export function requiresOf(cond) {
  if (typeof cond !== "string" || !cond.trim()) return [];
  const parts = cond.split(" and ").map((p) => /^not empty\(([a-z][a-z0-9_]*)\)$/.exec(p.trim()));
  return parts.every(Boolean) ? parts.map((m) => /** @type {RegExpExecArray} */ (m)[1]) : [];
}

/** The stages of a type as rows the editor shows. @param {any} def @returns {{ name: string, requires: string[], lost: boolean }[]} */
export function stageRows(def) {
  return (def && Array.isArray(def.stages) ? def.stages : []).map((/** @type {any} */ s) => {
    const req = requiresOf(s.enter_if);
    return { name: String(s.name), requires: req.filter((f) => f !== LOST_REASON), lost: req.includes(LOST_REASON) };
  });
}

/** The input of records.pipeline.set for these rows. @param {string} type @param {{ name: string, requires: string[], lost: boolean }[]} rows */
export const pipelineInput = (type, rows) => ({ type, stages: rows.map((r) => ({ name: r.name, ...(r.requires.length ? { requires: r.requires } : {}), ...(r.lost ? { lost: true } : {}) })) });

/** Turn a field on or off in one stage's needs. @param {{ name: string, requires: string[], lost: boolean }[]} rows @param {number} i @param {string} field */
export function toggleNeed(rows, i, field) {
  return rows.map((r, j) => (j === i ? { ...r, requires: r.requires.includes(field) ? r.requires.filter((f) => f !== field) : [...r.requires, field] } : r));
}

/** Mark one stage as lost, or not. @param {{ name: string, requires: string[], lost: boolean }[]} rows @param {number} i */
export const toggleLost = (rows, i) => rows.map((r, j) => (j === i ? { ...r, lost: !r.lost } : r));

/** The fields a stage may ask for: the type's own, not the stage field itself and not a sealed one (a sealed value is never part of a condition). @param {any} def */
export const askable = (def) => (def && Array.isArray(def.fields) ? def.fields : []).filter((/** @type {any} */ f) => f && f.kind !== "stage" && f.kind !== "sealed" && f.name !== LOST_REASON);
