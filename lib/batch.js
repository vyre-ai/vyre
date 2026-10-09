// @ts-check
// lib/batch: many tool calls in one model turn (R031-00o, tools_run).
//
// The agent sends a short script of steps as JSON, not code. This runs it step by step and gives back ONE answer. It adds no power: every call step is made by the `call` the host hands in,
// and the host makes it exactly as if the agent had sent that one tool alone (the MCP server posts each step to vyred's tool door under the agent's own identity, so the same grants, reach,
// presence rules and Gate judge it, and the events carry the same chain). Nothing in here decides who may do what.
//
// Language: a step is { id, call, input, when? } or { id, fn, inputs? }. An input value (anywhere in `input`/`inputs`) may be { expr: "..." }, an expression of the Flows expression language
// (kernel/flows/expr.js: no eval, no regular expressions, a fixed list of pure functions, a step counter) over `steps.<id>` (earlier results). `when` is an expression; false skips the step.
// An `fn` step is the Flows Code step unchanged (kernel/flows/code-sandbox.js): an OS-sandboxed process with no network, no files and no tools, so it can shape data and never call a tool.
// There are no loops and no nested scripts.
//
// What ends a script early: a step the Gate held (later steps do not run: the person's yes may change what should happen next), a refusal, an error, or the time limit. The answer always says
// which steps ran and where it stopped.
import crypto from "node:crypto";
import { parse, evaluate, stepRefs, truthy, ExprError } from "../kernel/flows/expr.js";

export const LIMITS = Object.freeze({ steps: 20, ms: 60_000, source: 4000, bytes: 16 * 1024 * 1024, stepMs: 120_000 });

/** Calls that must not run inside a batch: the batch itself, and the tools that wait for another session's whole turn. */
const NEVER = /^(tools_run|tools_call|tools_find|results_read)$|^threads[._]|^agents[._]ask$/;
/** An error code that means "you may not", not "it broke". */
const REFUSALS = new Set(["denied", "presence_required", "no_dialog", "not_found", "no_such_tool", "person_session_required", "not_in_grant", "held_unavailable", "placeholder_unreadable"]);
const ID = /^[a-z][a-z0-9_]{0,23}$/;

/** A Gate-held answer, whichever shape the tool gave it: { state: "held" } (the Gate), { held } (a kernel surface, the hub). @param {any} d */
export const isHeld = (d) => Boolean(d && typeof d === "object" && !Array.isArray(d) && (d.state === "held" || (d.held !== undefined && d.held !== null && d.held !== false)));
/** The id a held answer carries. @param {any} d */
export const heldId = (d) => String(d && (d.id || (typeof d.held === "string" ? d.held : d.held && (d.held.task || d.held.id)) || "")) || null;

/** @param {any} v @returns {boolean} */
const isExpr = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.expr === "string";

/** Every expression string in a value, in order. @param {any} v @param {string[]} [out] */
function exprsIn(v, out = []) {
  if (isExpr(v)) out.push(v.expr);
  else if (Array.isArray(v)) v.forEach((x) => exprsIn(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => exprsIn(x, out));
  return out;
}

/** The value with every { expr } replaced by its result over `scope`. @param {any} v @param {Record<string, any>} scope @returns {any} */
function resolve(v, scope) {
  if (isExpr(v)) return clone(evaluate(parse(v.expr), scope));
  if (Array.isArray(v)) return v.map((x) => resolve(x, scope));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, scope)]));
  return v;
}
/** A copy that shares nothing with the step results (a tool must not be able to change an earlier result). @param {any} v */
const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

/**
 * Check a script before anything runs: its shape, its names and its expressions. Every problem is reported at once.
 * @param {any} script @param {{ known: (name: string) => string | null }} host `known` gives the tool a name resolves to, or null
 * @returns {string[]} problems; empty when the script may run
 */
export function check(script, host) {
  /** @type {string[]} */ const bad = [];
  if (!script || typeof script !== "object" || !Array.isArray(script.steps) || !script.steps.length) return ["steps must be a list of at least one step"];
  if (script.steps.length > LIMITS.steps) bad.push(`at most ${LIMITS.steps} steps`);
  /** @type {Set<string>} */ const seen = new Set();
  const exprOk = (/** @type {string} */ where, /** @type {string} */ src) => {
    try { for (const ref of stepRefs(parse(src))) if (!seen.has(ref)) bad.push(`${where}: steps.${ref} is not an earlier step`); } catch (e) { bad.push(`${where}: ${e instanceof ExprError ? e.message : String(e)}`); }
  };
  script.steps.slice(0, LIMITS.steps).forEach((/** @type {any} */ s, /** @type {number} */ i) => {
    const at = `step ${i + 1}`;
    if (!s || typeof s !== "object" || Array.isArray(s)) return void bad.push(`${at}: a step is an object`);
    if (typeof s.id !== "string" || !ID.test(s.id)) bad.push(`${at}: id must be lower-case letters, digits and _ (starting with a letter)`);
    else if (seen.has(s.id)) bad.push(`${at}: id "${s.id}" is used twice`);
    const name = typeof s.id === "string" ? `${at} (${s.id})` : at;
    if ((s.call === undefined) === (s.fn === undefined)) bad.push(`${name}: give exactly one of call and fn`);
    if (s.call !== undefined) {
      if (typeof s.call !== "string" || !s.call) bad.push(`${name}: call is a tool name`);
      else if (NEVER.test(s.call) || NEVER.test(s.call.replace(/[^A-Za-z0-9_]/g, "_"))) bad.push(`${name}: ${s.call} cannot run inside tools_run; call it on its own`);
      else if (!host.known(s.call)) bad.push(`${name}: no tool "${s.call.slice(0, 60)}" that you may use`);
      else if (NEVER.test(String(host.known(s.call)))) bad.push(`${name}: ${s.call} cannot run inside tools_run; call it on its own`);
      if (s.input !== undefined && (typeof s.input !== "object" || s.input === null || Array.isArray(s.input))) bad.push(`${name}: input is an object`);
    }
    if (s.fn !== undefined) {
      if (typeof s.fn !== "string" || !s.fn.trim()) bad.push(`${name}: fn is the body of a function that returns an object`);
      else if (s.fn.length > LIMITS.source) bad.push(`${name}: fn is at most ${LIMITS.source} characters`);
      if (s.inputs !== undefined && (typeof s.inputs !== "object" || s.inputs === null || Array.isArray(s.inputs))) bad.push(`${name}: inputs is an object`);
    }
    if (s.when !== undefined) { if (typeof s.when !== "string") bad.push(`${name}: when is an expression`); else exprOk(`${name} when`, s.when); }
    for (const src of exprsIn(s.input).concat(exprsIn(s.inputs))) exprOk(name, src);
    if (typeof s.id === "string") seen.add(s.id);
  });
  if (script.return !== undefined) {
    if (typeof script.return !== "object" || script.return === null || Array.isArray(script.return)) bad.push("return is an object of names and expressions");
    else for (const src of exprsIn(script.return)) exprOk("return", src);
  }
  return bad;
}

/**
 * Run a checked script.
 * @param {any} script
 * @param {{
 *   call: (name: string, input: any, o: { timeoutMs: number }) => Promise<{ data?: any, error?: { code: string, message: string } }>,
 *   fn?: (req: { language: string, source: string, hash: string, inputs: any, outputs: string[], needs: string[] }) => Promise<{ outputs: Record<string, any> }>,
 *   now?: () => number,
 * }} host
 * @returns {Promise<{ status: "done" | "held" | "refused" | "error", ran: string[], skipped: string[], steps: Record<string, any>, stopped?: { step: string, code?: string, message?: string, held?: string | null }, ret?: any }>}
 */
export async function run(script, host) {
  const now = host.now || Date.now, t0 = now();
  /** @type {Record<string, any>} */ const results = {};
  /** @type {string[]} */ const ran = [], skipped = [];
  const out = (/** @type {any} */ status, /** @type {any} */ stopped) => ({ status, ran, skipped, steps: results, ...(stopped ? { stopped } : {}) });
  for (const s of script.steps) {
    const left = LIMITS.ms - (now() - t0);
    if (left <= 0) return out("error", { step: s.id, code: "timeout", message: `the script ran longer than ${LIMITS.ms / 1000} s; later steps did not run` });
    try {
      if (s.when !== undefined && !truthy(evaluate(parse(s.when), { steps: results }))) { skipped.push(s.id); results[s.id] = null; continue; }
      if (s.call !== undefined) {
        const r = await host.call(s.call, resolve(s.input ?? {}, { steps: results }), { timeoutMs: Math.min(LIMITS.stepMs, left) });
        if (r.error) return out(REFUSALS.has(r.error.code) ? "refused" : "error", { step: s.id, code: r.error.code, message: r.error.message });
        results[s.id] = r.data === undefined ? null : r.data;
        ran.push(s.id);
        if (isHeld(r.data)) return out("held", { step: s.id, held: heldId(r.data), message: "held at the Gate: later steps did not run. When the person has decided, send a new tools_run from the next step." });
      } else {
        if (!host.fn) return out("error", { step: s.id, code: "unavailable", message: "fn steps are not available here" });
        const hash = crypto.createHash("sha256").update(s.fn).digest("hex");
        const r = await host.fn({ language: "js", source: s.fn, hash, inputs: resolve(s.inputs ?? {}, { steps: results }), outputs: [], needs: [] });
        results[s.id] = r.outputs;
        ran.push(s.id);
      }
    } catch (e) {
      const err = /** @type {any} */ (e);
      return out("error", { step: s.id, code: err instanceof ExprError ? "bad_input" : err.code || "failed", message: String(err.message || err).slice(0, 300) });
    }
    if (bytesOf(results) > LIMITS.bytes) return out("error", { step: s.id, code: "too_large", message: "the steps' results grew past what a script may hold" });
  }
  const r = out("done", undefined);
  if (script.return !== undefined) {
    try { r.ret = resolve(script.return, { steps: results }); } catch (e) { return { ...out("error", { step: "return", code: "bad_input", message: String(/** @type {Error} */ (e).message).slice(0, 300) }) }; }
  }
  return r;
}

/** @param {any} v */
const bytesOf = (v) => Buffer.byteLength(JSON.stringify(v) ?? "");
