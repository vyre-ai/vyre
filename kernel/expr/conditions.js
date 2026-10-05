// @ts-check
// kernel/expr/conditions.js: what a record's own values decide about its definition. Pure functions over a type definition and a record's values, so the
// gateway (which refuses), the Flows stage module (which advances) and the app (which shows and hides fields) judge the same record the same way.
//
//   visible_if / required_if   on a field: an Expression over the record's other stored fields. A field whose visible_if is false is not shown and takes no
//                              new value; a field whose required_if is true (and that is visible) must hold a value.
//   enter_if                   on a stage: the stage can be entered only while the record, as it would be, satisfies it.
//   stage_sets                 on a type: `[{ name, when, stages }]`. The first set whose `when` holds picks the record's stages; otherwise `stages` is the default set.
//
// An expression that cannot be evaluated is never true. Nothing here throws on a record's values; a bad definition is refused when it is defined.
import { parseExpr as parse, evalExpr as evaluate } from "./expr.js";

/** @typedef {{ parseExpr: (s: string) => any, evalExpr: (n: any, ctx: any) => any }} Evaluator */
/** @type {Evaluator} */
export const defaultEvaluator = Object.freeze({ parseExpr: parse, evalExpr: evaluate });

/** @param {any} v the field holds nothing: null, empty text or an empty list */
export const isEmpty = (v) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** Is `src` true for these values? An expression that fails to parse or evaluate is false. @param {string} src @param {Record<string, any>} values @param {Evaluator} [ex] @param {Record<string, string[]>} [stageOrder] */
export function holds(src, values, ex = defaultEvaluator, stageOrder) {
  try { return ex.evalExpr(ex.parseExpr(src), { values: values || {}, ...(stageOrder ? { stageOrder } : {}) }) === true; } catch { return false; }
}

/** @param {any} def a type definition @returns {Record<string, string[]>} the stage field's order, for `<` and `>` on stages in an expression */
function orderOf(def) {
  const sf = (def.fields || []).find((/** @type {any} */ f) => f.kind === "stage");
  return sf ? { [sf.name]: stageNamesOf(def) } : {};
}

/** Shown and required, for one field of a record. A field with no condition is visible, and required only if `required` says so. @param {any} f @param {Record<string, any>} values @param {Evaluator} [ex] @param {Record<string, string[]>} [order] */
export function fieldState(f, values, ex = defaultEvaluator, order) {
  const visible = typeof f.visible_if === "string" ? holds(f.visible_if, values, ex, order) : true;
  const required = visible && (f.required === true || (typeof f.required_if === "string" && holds(f.required_if, values, ex, order)));
  return { visible, required };
}

/** The names of the fields that are visible, and of those that are required, for a record's values. @param {any} def @param {Record<string, any>} values @param {Evaluator} [ex] */
export function fieldStates(def, values, ex = defaultEvaluator) {
  const order = orderOf(def);
  /** @type {Record<string, { visible: boolean, required: boolean }>} */ const out = {};
  for (const f of def.fields || []) out[f.name] = fieldState(f, values, ex, order);
  return out;
}

/** Every stage name a type can hold: the default set first, then each set's own, once each. @param {any} def @returns {string[]} */
export function stageNamesOf(def) {
  const seen = new Set();
  for (const s of def.stages || []) seen.add(s.name);
  for (const set of def.stage_sets || []) for (const s of set.stages || []) seen.add(s.name);
  return [...seen];
}

/** The stages this record follows: the first stage set whose `when` holds, else the type's default stages. @param {any} def @param {Record<string, any>} values @param {Evaluator} [ex] @returns {{ set: string | null, stages: any[] }} */
export function stagesFor(def, values, ex = defaultEvaluator) {
  for (const set of def.stage_sets || []) if (holds(set.when, values, ex)) return { set: set.name, stages: set.stages || [] };
  return { set: null, stages: def.stages || [] };
}
