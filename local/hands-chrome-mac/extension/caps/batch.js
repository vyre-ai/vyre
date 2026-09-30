// @ts-check
// batch: run a list of ops inside the worker with no host round trip between steps.
//
// Per-call cost is one host round trip (ADR 0049), so a ten-step form fill would pay ten of
// them. batch.run keeps the steps in the worker, in order, and calls the registry through
// ctx.call, so every step gets the same guard rails as a request from the module: the floor, the
// stop flag, the op name check. It also checks ctx.stopped() itself before every step, so the
// person's Esc halts a batch between steps and says which one.
//
// Steps may use an earlier result: a string argument of the exact form "$0.path.to.value" is
// replaced by that value. Nothing else is interpreted (no expressions, no eval); a reference that
// does not resolve fails that step. The batch halts at the first failure or hold, and the result
// says which step and why so the module can turn a hold into a Gate card and resume from there.

import { err } from "../lib/err.js";

const MAX_STEPS = 200;
const REF = /^\$(\d{1,3})((?:\.[A-Za-z0-9_-]+)*)$/;

/**
 * @param {any} v @param {any[]} results @param {number} depth
 * @returns {any}
 */
function subst(v, results, depth = 0) {
  if (depth > 8) throw err("bad_request", "step arguments nest too deeply");
  if (typeof v === "string") {
    const m = REF.exec(v);
    if (!m) return v;
    const i = Number(m[1]);
    if (i >= results.length) throw err("bad_request", `${v} refers to a step that has not run`);
    let cur = results[i];
    for (const key of m[2].split(".").filter(Boolean)) {
      if (cur == null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, key)) throw err("bad_request", `${v} does not exist in the result of step ${i}`);
      cur = cur[key];
    }
    return cur;
  }
  if (Array.isArray(v)) return v.map(x => subst(x, results, depth + 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x, results, depth + 1)]));
  return v;
}

/** @type {{ name: string, ops: Record<string, (args: any, ctx: any) => Promise<any>> }} */
export default {
  name: "batch",
  ops: {
    "batch.run": async (args, ctx) => {
      const steps = args.steps;
      if (!Array.isArray(steps) || !steps.length) throw err("bad_request", "batch.run needs steps: [{op, args}]");
      if (steps.length > MAX_STEPS) throw err("bad_request", `batch.run takes at most ${MAX_STEPS} steps`);
      const stopOnError = args.stopOnError !== false;
      /** @type {any[]} */
      const results = [];
      /** @type {{ ok: boolean, done: number, results: any[], failedAt?: number, why?: string, code?: string, held?: any, haltMs?: number, detail?: any }} */
      const out = { ok: true, done: 0, results };
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const halt = (/** @type {string} */ why, /** @type {string} */ code, /** @type {any} */ result, /** @type {any} */ detail) => {
          results.push(result === undefined ? { ok: false, error: { code, message: why, ...(detail !== undefined ? { detail } : {}) } } : result);
          if (out.ok) { out.ok = false; out.failedAt = i; out.why = why; out.code = code; if (detail !== undefined) out.detail = detail; }
        };
        if (ctx.stopped()) { halt("the person pressed stop", "stopped"); out.haltMs = ctx.stoppedAt ? Date.now() - ctx.stoppedAt : undefined; break; }
        if (!step || typeof step.op !== "string") { halt(`step ${i} has no op`, "bad_request"); if (stopOnError) break; continue; }
        if (step.op === "batch.run") { halt("a batch cannot contain a batch", "bad_request"); if (stopOnError) break; continue; }
        try {
          const stepArgs = subst(step.args || {}, results);
          // A page acts on whatever a person's last click just caused: look for the control for a moment instead of failing on the first
          // look (a table that fills after its section opens). Set `wait` on a step, or `wait: false` on the batch, to change it.
          const wants = (step.op === "page.act" || step.op === "page.fill") && stepArgs.wait === undefined && args.wait !== false;
          // A batch that names a tab runs its steps on that tab, not on whichever is in front (the agent's tab need not be the active one).
          const onTab = typeof args.tabId === "number" && stepArgs.tabId === undefined && stepArgs.tab === undefined && !/^(tabs|ghl)\./.test(step.op) ? { tabId: args.tabId, tab: args.tabId } : {};
          const result = await ctx.call(step.op, { ...onTab, ...(args.asked === true ? { asked: true } : {}), ...(wants ? { wait: args.wait && typeof args.wait === "object" ? args.wait : { timeoutMs: 3000 } } : {}), ...stepArgs });
          results.push(result);
          if (result && result.ok === false) {
            if (out.ok) {
              out.ok = false; out.failedAt = i; out.why = String(result.why || (result.error && result.error.message) || "the step did not succeed"); if (result.held) out.held = result;
              // The failed step's own trace and page snippet travel with the halt, so the caller need not dig in results.
              if (result.trace || result.dom) out.detail = { ...(result.trace ? { trace: result.trace } : {}), ...(result.dom ? { dom: result.dom } : {}) };
            }
            if (stopOnError) break;
            continue;
          }
          out.done++;
        } catch (e) {
          const code = /** @type {any} */ (e)?.code || "error";
          halt(String(/** @type {any} */ (e)?.message || e), code, undefined, /** @type {any} */ (e)?.detail);
          if (stopOnError) break;
        }
      }
      return out;
    },
  },
};
