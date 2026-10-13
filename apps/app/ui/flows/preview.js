// @ts-check
// ui/flows/expr.js is a copy of kernel/flows/expr.js (the app bundle cannot reach outside its folders); a test fails if the two differ.
// A live preview of a formula or a condition, against made-up sample data, using the engine's own expression language (kernel/flows/expr.js), so what the preview says is what the Flow will do.
import { FUNCTIONS, parse, run, ExprError } from "./expr.js";

/** The functions a formula may call, with a one-line example each, for the "Functions" help. */
export const FUNCTION_HELP = /** @type {[string, string][]} */ ([
  ["round(x)", "round a number: round(trigger.amount * 1.2)"], ["floor(x)", "round down"], ["min(a, b)", "the smaller"], ["max(a, b)", "the larger"], ["number(x)", "text to a number, or nothing"],
  ["len(x)", "how many characters or items"], ["lower(x)", "lower case"], ["upper(x)", "upper case"], ["trim(x)", "cut spaces at the ends"], ["text(x)", "make it text"],
  ["startsWith(a, b)", "does a start with b"], ["endsWith(a, b)", "does a end with b"], ["coalesce(a, b)", "the first one that is not empty"], ["isnull(x)", "is it empty"],
  ["days(n)", "n days in milliseconds"], ["hours(n)", "n hours in milliseconds"], ["minutes(n)", "n minutes in milliseconds"],
]);

const NUMERIC = /amount|total|price|value|count|qty|quantity|fee|balance|sum|age|hours|days/i;

/** A made-up value for a field, by what its name suggests. @param {string} name */
export function sampleValue(name) {
  if (/^(rows|items|list)$/i.test(name)) return [{ id: "rec_1" }, { id: "rec_2" }];
  if (/^id$/i.test(name) || /_id$/.test(name)) return "rec_1";
  if (/email/i.test(name)) return "pat@example.com";
  if (/phone|mobile|sms/i.test(name)) return "+15555550123";
  if (/name/i.test(name)) return "Pat Lopez";
  if (NUMERIC.test(name)) return 120;
  return "sample";
}

/** The scope a source needs: every `trigger.x.y`, `steps.id.a`, `event.subject` it reads, filled with sample values. @param {string} src */
export function sampleScope(src) {
  /** @type {Record<string, any>} */ const scope = {};
  for (const m of String(src).matchAll(/\b(trigger|event|steps|row|item)((?:\.[A-Za-z_][A-Za-z0-9_]*)+)/g)) {
    const path = m[2].slice(1).split(".");
    /** @type {any} */ let at = scope[m[1]] && typeof scope[m[1]] === "object" ? scope[m[1]] : (scope[m[1]] = {});
    path.forEach((k, i) => { if (i === path.length - 1) { if (!(k in at)) at[k] = sampleValue(k); } else { if (!at[k] || typeof at[k] !== "object") at[k] = {}; at = at[k]; } });
  }
  return scope;
}

/** What a formula gives on the sample data. @param {string} src @returns {{ ok: true, value: any, text: string } | { ok: false, text: string }} */
export function previewExpr(src) {
  const s = String(src || "").trim();
  if (!s) return { ok: false, text: "Type a formula to see what it gives." };
  try {
    const v = run(s, sampleScope(s));
    return { ok: true, value: v, text: v === null || v === undefined ? "nothing (empty)" : typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) };
  } catch (e) {
    return { ok: false, text: e instanceof ExprError || e instanceof Error ? e.message : "That is not a formula the engine can read." };
  }
}

/** Whether the engine can read this formula at all (for a problem line). @param {string} src */
export function formulaProblem(src) {
  try { parse(String(src || "").trim() || "0"); return null; } catch (e) { return e instanceof Error ? e.message : "That is not a formula the engine can read."; }
}

export { FUNCTIONS };
