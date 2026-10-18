// @ts-check
// Flow steps tried and retried one at a time, kept out of the runner (kernel/flows/runner.js) so it stays under its size cap: what a step was given, trying one step in the dry mode simulation uses,
// and taking a run back to a chosen step. Behaviour is the runner's own; the runner passes in what these read (its store, its catalog, its scope and its step walker).
import { parse, evaluate, truthy } from "./expr.js";
import { resolveValue, OUTWARD } from "./runner-util.js";
import { compileFlow, deriveCaps } from "./compile.js";
import { walkSteps } from "./schema.js";
import { Suspend, PauseFlow, failOf, showable } from "./runner-faults.js";
import { hideRun } from "./redact.js";
import { labelOf, stepOrder } from "./runner-helpers.js";

/** How much of a step's input the run keeps (a readable 16 KB; over it the ledger says it was cut). */
export const STEP_INPUT_CAP = 16 * 1024;
/** What a step is given that is not its own wiring: everything else on the step is an input. */
const NOT_INPUT = new Set(["id", "kind", "label", "added_by", "enabled", "on_fail", "verify", "retry", "timeout_ms", "approve", "source", "hash", "language", "outputs", "then", "else", "steps"]);

/**
 * What a step was given, as the run page shows it: a decide's test and its value, a code step's inputs, a call's input, a repeat's list, and for the rest the step's own parameters with their values worked out. A value that cannot
 * be worked out here is shown as written. @param {any} s @param {(src: string) => any} ev @param {(v: any) => any} val
 */
export function inputOf(s, ev, val) {
  const safe = (/** @type {() => any} */ f, /** @type {any} */ asWritten) => { try { return f(); } catch { return asWritten; } };
  if (s.kind === "decide") return { if: s.if, value: safe(() => truthy(ev(s.if)), null) };
  if (s.kind === "repeat") return { over: s.over };
  if (s.kind === "parallel" || s.kind === "branch") return undefined;
  if (s.kind === "fn") return safe(() => val(s.inputs), s.inputs);
  // a call step is given its `input`; the action and the resource it names are what it does (the effects say so), not what it is given
  if (s.kind === "call" && s.input && typeof s.input === "object" && !Array.isArray(s.input)) return safe(() => val(s.input), s.input);
  const out = /** @type {Record<string, any>} */ ({});
  for (const [k, v] of Object.entries(s)) if (!NOT_INPUT.has(k)) out[k] = safe(() => val(v), v);
  return Object.keys(out).length ? out : undefined;
}

/**
 * Try ONE step of a Flow against the recorded inputs of a past run (its trigger and the output of every step but this one) or against sample values, in the dry mode simulation uses: reads happen, nothing is
 * created, changed or sent. Answers the step's input (redacted as the ledger shows it), what it would give back, and what it would send or do.
 * @param {{ catalogFn: () => any, store: any, now: () => number, scope: (ctx: any) => any, step: (ctx: any, s: any) => Promise<any> }} h @param {any} flow @param {string} stepId @param {{ approver: any, run?: string, flowId?: string, sample?: any, hideFor?: string }} o
 */
export async function testStepOf(h, flow, stepId, o) {
  const cat = /** @type {any} */ (await h.catalogFn());
  const compiled = compileFlow(flow, cat);
  if (!compiled.ok) return { ok: false, errors: compiled.errors, warnings: compiled.warnings };
  /** @type {any} */ let step = null;
  walkSteps(flow.steps || [], s => { if (s.id === stepId) step = s; }); walkSteps(flow.on_failure || [], s => { if (s.id === stepId) step = s; });
  if (!step) throw Object.assign(new Error(`this Flow has no step ${stepId}`), { code: "no_such_step" });
  if (step.kind === "parallel" || step.kind === "branch") throw Object.assign(new Error("a parallel step is tried one lane step at a time: pick a step inside it"), { code: "bad_input" });
  if ((o.run === undefined) === (o.sample === undefined)) throw Object.assign(new Error("give either run (a past run to take the inputs from) or sample (values to stand in for the trigger)"), { code: "bad_input" });
  /** @type {any} */ let trigger = { kind: "manual", key: "step-test", input: o.sample ?? {} };
  /** @type {Record<string, any>} */ const steps = {};
  if (o.run !== undefined) {
    const stored = await h.store.getRun(String(o.run));
    if (!stored || !o.flowId || stored.flow !== o.flowId) throw Object.assign(new Error("that is not a run of this Flow (flows.runs)"), { code: "not_found" });
    // the run as this viewer may see it: what flows.run would hide from them (a run on someone else's authority) is not there for the step to read or echo
    const rec = o.hideFor ? hideRun(stored, o.hideFor) : stored;
    trigger = rec.trigger;
    for (const [k, l] of Object.entries(rec.steps || {})) if (l && ["done", "skipped", "failed_handled"].includes(l.status) && k.replace(/[@!?].*$/, "") !== stepId && !k.includes("?")) steps[k] = { status: l.status, output: l.output };
  }
  const now = h.now();
  /** @type {any} */ const run = { id: `test_${stepId}`, flow: "simulation", version: 0, hash: "", space: cat.space, trigger, tainted: false, source_spaces: [cat.space], depth: 0, state: "running", started_at: now, updated_at: now, steps, approver: o.approver, dry: true };
  const caps = Array.isArray(flow.caps) ? flow.caps : deriveCaps(flow, cat);
  /** @type {any} */ const ctx = { run, flow, view: { flow, id: "simulation" }, cat, caps, dry: true, count: 0, dryEffects: [], dryAsks: 0, dryTasks: [], softReads: false };
  const scope = h.scope(ctx);
  const input = showable(inputOf(step, (/** @type {string} */ src) => evaluate(parse(src), scope), (/** @type {any} */ v) => resolveValue(v, scope)), STEP_INPUT_CAP);
  /** @type {{ code: string, message: string } | null} */ let error = null;
  let asks = false;
  try { await h.step(ctx, step); }
  catch (e) {
    if (e instanceof Suspend) asks = true;
    else if (e instanceof PauseFlow) error = { code: "paused", message: e.reason };
    else error = failOf(e);
  }
  const led = run.steps[step.id];
  const effects = (ctx.dryEffects || []).map((/** @type {any} */ e) => ({ action: e.action, resource: e.resource, outward: OUTWARD.has(e.risk), would: `${OUTWARD.has(e.risk) ? "would send" : "would do"}: ${labelOf(cat, e.action)}${input === undefined ? "" : ` with ${JSON.stringify(input).slice(0, 300)}`}` }));
  return { ok: !error, step: stepId, kind: step.kind, ...(input !== undefined ? { input } : {}), output: led && led.status !== "started" ? showable(led.output, STEP_INPUT_CAP) : undefined, effects, asks: asks || ctx.dryAsks > 0, tasks: (ctx.dryTasks || []).length, ...(error ? { error } : {}), warnings: compiled.warnings };
}

/**
 * Retry from a chosen step: that step and every step after it (in the Flow's order) are cleared from the ledger, so they run again; what came before keeps its recorded output. Refuses, naming why, when
 * a step that would run again already sent something. Changes `run` in place.
 * @param {{ store: any, catalogFn: () => any }} h @param {any} run @param {string} from
 */
export async function retryFrom(h, run, from) {
  const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
  const def = await h.store.getVersion(run.flow, run.version);
  if (!def) throw fail("gone", "the Flow version this run started on no longer exists");
  const order = stepOrder(def.flow);
  const at = order.indexOf(String(from));
  if (at < 0) throw fail("no_such_step", `${String(from)} is not a step this run can start again from (steps inside a parallel lane are not listed; start from the parallel step)`);
  const again = new Set(order.slice(at));
  // Fail closed: a step that sends, posts, pays or publishes is not run again from here if the run shows it was done or begun and not known to have failed. Whether the other side would drop a repeat is not
  // something this runner can know, so it does not ask it to.
  const cat = /** @type {any} */ (await h.catalogFn());
  const outwardOf = (/** @type {any} */ flow) => new Set(compileFlow(flow, cat).effects.outward.map((/** @type {any} */ o) => o.step));
  const sentIn = (/** @type {Record<string, any>} */ steps, /** @type {Set<string>} */ outward, /** @type {(id: string, k: string) => boolean} */ counts) => Object.entries(steps || {}).some(([k, l]) => {
    // a `?ask` entry is the question put to a person before a send (its yes, not the send), so it is not the act; the send is the step's own entry
    const id = k.replace(/[@!?].*$/, "");
    return Boolean(l) && !k.includes("?") && outward.has(id) && counts(id, k) && (l.status === "done" || l.status === "started" || l.status === "waiting" || Boolean(l.sent_at));
  });
  const refuse = () => fail("already_sent", "that run already sent something; start a new run to send again");
  const outward = outwardOf(def.flow);
  // the steps that would run again, and every entry of the Flow's own failure path (all of them are cleared below)
  if (sentIn(run.steps, outward, (id, k) => again.has(id) || k.includes("!"))) throw refuse();
  // a parallel or sub-flow step that would run again has runs of its own (lanes, a called Flow): what they sent counts, judged against the version each started on
  for (const [k, l] of Object.entries(run.steps)) {
    if (!l || !Array.isArray(l.children) || !again.has(k.replace(/[@!?].*$/, ""))) continue;
    for (const cid of l.children) {
      const child = await h.store.getRun(String(cid));
      const cdef = child ? await h.store.getVersion(child.flow, child.version) : null;
      // a run or version that cannot be read cannot be shown to have sent nothing, so it counts as having sent
      if (!child || !cdef || sentIn(child.steps, outwardOf(cdef.flow), () => true)) throw refuse();
    }
  }
  for (const k of Object.keys(run.steps)) if (k.includes("!") || again.has(k.replace(/[@!?].*$/, ""))) delete run.steps[k];
  run.result = undefined; run.waiting = undefined; run.queued = undefined; run.cancelled = undefined; run.finished_at = undefined;
}
