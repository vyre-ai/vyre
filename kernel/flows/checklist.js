// @ts-check
// Task briefs and checklists (s2). A stage's task template may carry:
//   brief        words for the doer, with `{record.field}` filled from the record when the task is made
//   checklist    [{ say, check }]: what must hold before the task counts as done. The runner (the stage gate) evaluates it; a doer saying "done" is not enough.
//   credentials  the names of the Connections the doer may use, chosen up front
// A check is exactly one of:
//   { field: "<expression over the record>" }                                   a record field has what it should
//   { answer: { event: "<event type>", within_ms? } }                           a named event (a webhook's answer) arrived after the task began
//   { status: { connection, operation, input?, expect: "<expression over response>" } }   one read through a Connection
//   { poll: { connection, operation, input?, until: "<expression over response>", every_ms, max } }   a bounded poll of a read
// Every read goes through the gateway as a read: a check never sends, writes or pays.

import { parse, evaluate, roots, truthy } from "./expr.js";
import { holds } from "../../lib/expr/conditions.js";
import { nearest } from "./places.js";

export const CHECKLIST_LIMITS = Object.freeze({ items: 10, brief: 2000, say: 160, pollMax: 20, pollEveryMin: 60_000, credentials: 10 });
const CHECK_KINDS = ["field", "answer", "status", "poll"];
const NAME = /^[a-z][a-z0-9_.-]*$/;

/** @param {any} v */
const isObj = v => v && typeof v === "object" && !Array.isArray(v);

/** Is this expression text one the Flows language parses, reading only these names? @param {any} src @param {string[]} allowed @returns {string | null} the problem */
function exprProblem(src, allowed) {
  if (typeof src !== "string" || !src.trim() || src.length > 500) return "give an expression (text of at most 500 characters)";
  try { for (const r of roots(parse(src))) if (!allowed.includes(r)) { const c = nearest(r, allowed); return `${r} is not available here; ${c ? `did you mean ${c}?` : `it reads ${allowed.join(", ")}`}`; } } catch (e) { return e instanceof Error ? e.message : "that expression does not parse"; }
  return null;
}

/**
 * The problems in one task template's brief, checklist and credentials. `fields` are the names of the record type's fields; `connections` the Connections of the Space (by their short names).
 * @param {any} task @param {string} at where it is, for the message @param {{ fields: string[], connections: string[], readOps?: (connection: string) => string[] | null }} env
 * @returns {{ path: string, message: string }[]}
 */
export function checkTaskExtras(task, at, env) {
  /** @type {{ path: string, message: string }[]} */ const out = [];
  const bad = (/** @type {string} */ path, /** @type {string} */ message) => out.push({ path: `${at}${path}`, message });
  if (task.brief !== undefined) {
    if (typeof task.brief !== "string" || !task.brief.trim() || task.brief.length > CHECKLIST_LIMITS.brief) bad(".brief", `a brief is text of at most ${CHECKLIST_LIMITS.brief} characters`);
    else for (const m of task.brief.matchAll(/\{record\.([A-Za-z_][A-Za-z0-9_]*)\}/g)) if (!env.fields.includes(m[1])) { const c = nearest(m[1], env.fields); bad(".brief", `{record.${m[1]}} is not a field of the record; ${c ? `did you mean ${c}?` : `the fields are ${env.fields.slice(0, 6).join(", ")}`}`); }
  }
  if (task.credentials !== undefined) {
    if (!Array.isArray(task.credentials) || task.credentials.length > CHECKLIST_LIMITS.credentials || !task.credentials.every((/** @type {any} */ c) => typeof c === "string" && NAME.test(c))) bad(".credentials", `credentials is a list of at most ${CHECKLIST_LIMITS.credentials} Connection names`);
    else for (const c of task.credentials) if (!env.connections.includes(c)) { const n = nearest(c, env.connections); bad(".credentials", `there is no Connection ${c}; ${n ? `did you mean ${n}?` : `the Connections are ${env.connections.slice(0, 6).join(", ") || "none yet"}`}`); }
  }
  if (task.checklist !== undefined) {
    if (!Array.isArray(task.checklist) || !task.checklist.length || task.checklist.length > CHECKLIST_LIMITS.items) { bad(".checklist", `a checklist is 1 to ${CHECKLIST_LIMITS.items} items`); return out; }
    task.checklist.forEach((/** @type {any} */ item, /** @type {number} */ i) => {
      const p = `.checklist[${i}]`;
      if (!isObj(item) || typeof item.say !== "string" || !item.say.trim() || item.say.length > CHECKLIST_LIMITS.say || !isObj(item.check)) { bad(p, `an item is { say, check }: say is a short sentence for the doer when it fails`); return; }
      for (const k of Object.keys(item)) if (k !== "say" && k !== "check") bad(`${p}.${k}`, `${k} is not part of a checklist item`);
      const kinds = Object.keys(item.check);
      if (kinds.length !== 1 || !CHECK_KINDS.includes(kinds[0])) { bad(`${p}.check`, `a check is exactly one of ${CHECK_KINDS.join(", ")}`); return; }
      const kind = kinds[0], c = item.check[kind];
      if (kind === "field") { const pr = exprProblem(c, env.fields); if (pr) bad(`${p}.check.field`, pr); return; }
      if (!isObj(c)) { bad(`${p}.check.${kind}`, `${kind} is an object`); return; }
      if (kind === "answer") {
        if (typeof c.event !== "string" || !/^[a-z][a-z0-9_.*-]*$/.test(c.event)) bad(`${p}.check.answer.event`, "name the event type that must arrive, like web.intake or task.completed");
        if (c.within_ms !== undefined && !(Number.isInteger(c.within_ms) && c.within_ms >= 1000)) bad(`${p}.check.answer.within_ms`, "within_ms is a whole number of milliseconds");
        return;
      }
      if (typeof c.connection !== "string" || !env.connections.includes(c.connection)) { const n = typeof c.connection === "string" ? nearest(c.connection, env.connections) : null; bad(`${p}.check.${kind}.connection`, `there is no Connection ${c.connection}; ${n ? `did you mean ${n}?` : `the Connections are ${env.connections.slice(0, 6).join(", ") || "none yet"}`}`); }
      else if (env.readOps) { const ops = env.readOps(c.connection); if (ops && !ops.includes(String(c.operation))) bad(`${p}.check.${kind}.operation`, `${c.connection} has no read operation ${c.operation}; a check only reads (${ops.slice(0, 6).join(", ") || "none"})`); }
      if (typeof c.operation !== "string" || !c.operation) bad(`${p}.check.${kind}.operation`, "name the operation to read");
      const key = kind === "status" ? "expect" : "until";
      const pr = exprProblem(c[key], ["response"]); if (pr) bad(`${p}.check.${kind}.${key}`, pr);
      if (kind === "poll") {
        if (!(Number.isInteger(c.every_ms) && c.every_ms >= CHECKLIST_LIMITS.pollEveryMin)) bad(`${p}.check.poll.every_ms`, `every_ms is at least ${CHECKLIST_LIMITS.pollEveryMin} (a minute)`);
        if (!(Number.isInteger(c.max) && c.max >= 1 && c.max <= CHECKLIST_LIMITS.pollMax)) bad(`${p}.check.poll.max`, `max is 1 to ${CHECKLIST_LIMITS.pollMax} tries`);
      }
    });
  }
  return out;
}

/** The brief with `{record.field}` filled from the record. A field that is empty or not on the record reads as nothing, and a sealed value is never in the data it is given. @param {string} brief @param {Record<string, any>} data */
export function renderBrief(brief, data) {
  return String(brief).replace(/\{record\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, k) => { const v = data ? data[k] : undefined; return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); });
}

/** The body of a read answer as a value an expression can look into. @param {any} r */
function responseOf(r) {
  let body = r && r.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* text stays text */ } }
  return { status: r ? r.status : 0, ok: Boolean(r && r.ok), body };
}

/**
 * Evaluate a checklist. Items already satisfied by an answer or a poll stay satisfied (an event does not un-arrive); a status or a field is looked at again every time.
 * @param {{ say: string, check: any }[]} items
 * @param {{ data: Record<string, any>, since: number, now: number, seen: { type: string, at: number }[], read?: (spec: any) => Promise<any>, memo?: Record<string, any> }} ctx
 * `memo` holds, per item index, { ok, tries, last } and is returned updated.
 * @returns {Promise<{ results: { say: string, ok: boolean, why?: string }[], ok: boolean, memo: Record<string, any>, due?: number }>}
 */
export async function evalChecklist(items, ctx) {
  /** @type {Record<string, any>} */ const memo = { ...(ctx.memo || {}) };
  /** @type {{ say: string, ok: boolean, why?: string }[]} */ const results = [];
  let due;
  for (let i = 0; i < items.length; i++) {
    const { say, check } = items[i];
    const kind = Object.keys(check)[0], c = check[kind];
    const prev = memo[i] || {};
    let ok = false, why;
    try {
      if (kind === "field") ok = holds(c, ctx.data);
      else if (kind === "answer") ok = prev.ok === true || ctx.seen.some(e => (e.type === c.event || (c.event.endsWith(".*") && e.type.startsWith(c.event.slice(0, -1)))) && e.at >= ctx.since && (c.within_ms === undefined || e.at <= ctx.since + c.within_ms));
      else if (kind === "status") {
        if (!ctx.read) why = "this Space cannot read that Connection from here";
        else ok = truthy(evaluate(parse(c.expect), { response: responseOf(await ctx.read(c)) }));
      } else if (kind === "poll") {
        if (prev.ok === true) ok = true;
        else if ((prev.tries || 0) >= c.max) why = `gave up after ${c.max} tries`;
        else if (prev.last !== undefined && ctx.now - prev.last < c.every_ms) { why = "not yet"; due = Math.min(due ?? Infinity, prev.last + c.every_ms); }
        else if (!ctx.read) why = "this Space cannot read that Connection from here";
        else {
          const r = await ctx.read(c);
          ok = truthy(evaluate(parse(c.until), { response: responseOf(r) }));
          memo[i] = { ok, tries: (prev.tries || 0) + 1, last: ctx.now };
          if (!ok) due = Math.min(due ?? Infinity, ctx.now + c.every_ms);
        }
      }
    } catch (e) { ok = false; why = e instanceof Error ? e.message.slice(0, 120) : "could not be checked"; }
    if (kind === "answer" || kind === "poll") memo[i] = { ...(memo[i] || prev), ok: ok || prev.ok === true };
    results.push({ say, ok, ...(ok ? {} : { why: why || say }) });
  }
  return { results, ok: results.every(r => r.ok), memo, ...(due !== undefined && due !== Infinity ? { due } : {}) };
}
