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

import { toRecipe } from "../lib/recipes.js";
import { remember } from "./recipe.js";
import { originOf } from "../lib/observe.js";
import { records } from "./net.js";
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

/**
 * Is this write one the approved plan covers? It must be made on the plan's own tab, that tab must still be on the plan's site, and the request must go to an
 * origin that tab's own traffic has talked to (the app's own API), never some other site the step names. A step's own tab wins over the batch's, so it is checked too.
 * @param {any} ctx @param {any} wb the budget @param {any} merged the step's args as it will be called (the batch's tab filled in) @param {any} res the held write
 */
async function budgetFits(ctx, wb, merged, res) {
  try {
    // The tab exactly as the op will read it: both spellings present and different is refused, and neither is refused.
    const a = merged && typeof merged.tabId === "number" ? merged.tabId : undefined, b = merged && typeof merged.tab === "number" ? merged.tab : undefined;
    if (a !== undefined && b !== undefined && a !== b) return false;
    const tab = a !== undefined ? a : b;
    if (typeof tab !== "number") return false;
    if (wb.tab !== undefined && tab !== wb.tab) return false;
    if (wb.tabOrigin) { const t = await ctx.tabs.get(tab); if (originOf(String((t && (t.pendingUrl || t.url)) || "")) !== wb.tabOrigin) return false; }
    const ro = typeof res.origin === "string" ? res.origin : "";
    if (!ro) return false;
    if (wb.origin) return ro === wb.origin;
    const seen = new Set((await records(ctx, tab)).map((/** @type {any} */ r) => { try { return new URL(r.url).origin; } catch { return ""; } }));
    return seen.has(ro) || ro === wb.tabOrigin;
  } catch { return false; }
}

/** @type {{ name: string, ops: Record<string, (args: any, ctx: any) => Promise<any>> }} */
export default {
  name: "batch",
  ops: {
    "batch.run": async (args, ctx, trust = {}) => {
      const steps = args.steps;
      if (!Array.isArray(steps) || !steps.length) throw err("bad_request", "batch.run needs steps: [{op, args}]");
      if (steps.length > MAX_STEPS) throw err("bad_request", `batch.run takes at most ${MAX_STEPS} steps`);
      const stopOnError = args.stopOnError !== false;
      /** What the module's approved plan still covers, set only by the module. @type {any} */
      const wb = trust.writeBudget ? { ...trust.writeBudget } : null;
      /** @type {{ kind: string, res: any }[]} */ const covered = [];
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
          const onTab = typeof args.tabId === "number" && stepArgs.tabId === undefined && stepArgs.tab === undefined && !/^(tabs\.|ghl\.section)/.test(step.op) ? { tabId: args.tabId, tab: args.tabId } : {};
          let result = await ctx.call(step.op, { ...onTab, ...(wants ? { wait: args.wait && typeof args.wait === "object" ? args.wait : { timeoutMs: 3000 } } : {}), ...stepArgs }, { asked: trust.asked === true });
          // A write the module's approved plan covers (it sent a budget; a model's input cannot): run it again with writeOk, up to the budget, on the one API origin.
          if (wb && result && typeof result === "object" && result.held === true && result.write === true && (wb[result.kind] || 0) > 0 && (!wb.origin || result.origin === wb.origin) && await budgetFits(ctx, wb, { ...onTab, ...stepArgs }, result)) {
            wb[result.kind]--; if (!wb.origin && result.origin) wb.origin = result.origin;
            const again = await ctx.call(step.op, { ...onTab, ...stepArgs }, { writeOk: true });
            covered.push({ kind: result.kind, res: again });
            result = again;
          }
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
      if (covered.length) /** @type {any} */ (out).covered = covered.map(c => ({ kind: c.kind, res: c.res }));
      // A batch that was given a name and did every step is kept as a recipe: its steps with every literal turned into a {parameter}.
      if (typeof args.saveAs === "string" && args.saveAs && out.ok && out.done === steps.length) {
        try {
          const name = args.saveAs.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
          const t = typeof args.tabId === "number" && ctx.tabs ? await ctx.tabs.get(args.tabId) : null;
          const origin = originOf(String((t && (t.pendingUrl || t.url)) || ""));
          const saved = origin && name ? await remember(ctx, origin, toRecipe(name, steps, results)) : null; // toRecipe refuses a step it cannot make into parameters
          if (saved) /** @type {any} */ (out).recipe = { name: saved.name, steps: saved.steps.length, params: saved.params.map((/** @type {any} */ p) => p.name) };
        } catch (e) { /** @type {any} */ (out).recipe = { saved: false, why: String(/** @type {any} */ (e)?.message || e).slice(0, 200) }; /* a recipe that cannot be kept is not a failed batch */ }
      }
      return out;
    },
  },
};
