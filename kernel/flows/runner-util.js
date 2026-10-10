// @ts-check
// Small pure helpers of the Flow runner (kernel/flows/runner.js), kept apart so the runner file does not grow: what a run's steps produced, how a value is resolved against a scope, record references,
// time spans, a model's value as a declared kind, and a condition turned into a store filter.
import { parse, evaluate, roots } from "./expr.js";

/** @typedef {import('./store.js').Run} Run */

/** The outputs of finished steps, by step id (the latest turn of a loop wins). @param {Run} run */
export function outputs(run) {
  /** @type {Record<string, any>} */ const o = {};
  for (const [k, v] of Object.entries(run.steps)) {
    if (k.includes("?")) continue;
    if (v.status !== "done" && v.status !== "started" && v.status !== "skipped" && v.status !== "failed_handled") continue;
    if (k.includes("!")) continue;                          // a failure path's own steps are read by the failure path, not by steps.<id> of the main line
    const id = k.replace(/@.*$/, "");
    // a parallel step's lanes made steps of their own: they read as `steps.<id>` after the join, like any step before it
    if (v.output && typeof v.output === "object" && v.output.branches) for (const b of Object.values(/** @type {Record<string, any>} */ (v.output.branches))) Object.assign(o, b.steps);
    if (v.output !== undefined) o[id] = v.output;
  }
  return o;
}

/** @param {any} v @param {any} scope @returns {any} */
export function resolveValue(v, scope) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(x => resolveValue(x, scope));
  if (Object.hasOwn(v, "expr")) return evaluate(parse(v.expr), scope);
  /** @type {Record<string, any>} */ const o = {};
  for (const k of Object.keys(v)) o[k] = resolveValue(v[k], scope);
  return o;
}

/** @param {any} v */
export function recordId(v) {
  if (!v) return null;
  if (typeof v === "string") return v.includes("/") ? v.split("/").pop() || null : v;
  if (typeof v === "object" && typeof v.id === "string") return v.id;
  if (typeof v === "object" && typeof v.urn === "string") return v.urn.split("/").pop() || null;
  return null;
}

/** @param {any} ctx @param {any} v @param {string} [type] */
export function urnOf(ctx, v, type) {
  if (typeof v === "string" && v.startsWith("vyre://")) return v;
  if (v && typeof v === "object" && typeof v.urn === "string") return v.urn;
  const id = recordId(v);
  const t = (v && typeof v === "object" && v.type) || type;
  return id && t ? `vyre://${ctx.cat.space}/${t}/${id}` : undefined;
}

/** Keep a record's useful fields only. @param {any} r */
export const plain = r => (r ? { id: r.id, type: r.type, version: r.version, data: r.data, urn: r.urn } : r);

/** A model's value as the declared kind, or null when it is not that kind (an extracted field is never a guess dressed as another type). @param {any} v @param {string} kind */
export function coerce(v, kind) {
  if (v === undefined || v === null || v === "") return null;
  if (kind === "number") { const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s$]/g, "")); return Number.isFinite(n) ? n : null; }
  if (kind === "boolean") return typeof v === "boolean" ? v : /^(true|yes)$/i.test(String(v)) ? true : /^(false|no)$/i.test(String(v)) ? false : null;
  if (kind === "date") { const d = String(v).trim(); return /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) ? d : null; }
  return typeof v === "object" ? null : String(v).slice(0, 2000);
}

/** @param {number} ms */
export function describeSpan(ms) {
  const d = Math.round(ms / 86_400_000);
  if (d >= 56) return `${Math.round(d / 30)} months`;
  if (d >= 14) return `${Math.round(d / 7)} weeks`;
  if (d >= 2) return `${d} days`;
  const h = Math.round(ms / 3_600_000);
  return h >= 2 ? `${h} hours` : "an hour";
}

/** @param {any} v @returns {number|null} */
export function toMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  return null;
}

/**
 * Turn a condition into the store's Filter where it is simple enough: comparisons of `record.<field>` with a value computed from the rest of the scope,
 * joined by and, or and not. Anything else returns null and the rows are checked in memory (the in-memory check always runs, so this is only an optimisation).
 * @param {import('./expr.js').Node} n @param {any} scope @returns {any|null}
 */
export function toFilter(n, scope) {
  /** @param {import('./expr.js').Node} x */
  const field = x => (x.k === "member" && x.obj.k === "id" && x.obj.name === "record" ? x.name : null);
  const pureRight = (/** @type {import('./expr.js').Node} */ x) => !roots(x).has("record");
  if (n.k === "bin" && (n.op === "and" || n.op === "or")) {
    const a = toFilter(n.a, scope), b = toFilter(n.b, scope);
    return a && b ? { [n.op]: [a, b] } : null;
  }
  if (n.k === "un" && n.op === "not") { const a = toFilter(n.a, scope); return a ? { not: a } : null; }
  if (n.k === "bin" && ["==", "!=", "<", "<=", ">", ">="].includes(n.op)) {
    const f = field(n.a);
    if (f && pureRight(n.b)) return { field: f, op: { "==": "eq", "!=": "ne", "<": "lt", "<=": "lte", ">": "gt", ">=": "gte" }[/** @type {'=='} */ (n.op)], value: evaluate(n.b, scope) };
  }
  return null;
}
