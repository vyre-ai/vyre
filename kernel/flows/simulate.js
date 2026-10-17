// kernel/flows/simulate: what a Flow would have done over a window of past events, with its actions stubbed (the runner's `simulate`). It reads through the runner's own catalog, chains and event log and
// walks the steps with the runner's own `walk`, so a simulated step goes through the same code as a real one; nothing here stores or emits anything.
import { compileFlow, deriveCaps } from "./compile.js";
import { triggerScope } from "./triggers.js";
import { dueTimes } from "./schedule.js";
import { describeSpan, slim, OUTWARD } from "./runner-util.js";
import { Suspend, PauseFlow } from "./runner-faults.js";

/**
 * Replay a window of past events against a Flow with its actions stubbed, and say what it would have done: how many runs, how many approvals it
 * would have asked for, what it would have written, sent and run. Reads are real (as the approver, read-only), so a `find` sees today's data;
 * writes, tasks, calls, http, code and models are stubbed; waits do not wait. Nothing is stored and nothing is emitted.
 * @param {any} flow a stored Flow (a draft or an active one)
 * @param {{ approver: any, events?: any[], since?: number, until?: number, limit?: number, samples?: any[], cat?: any, softReads?: boolean }} o
 * @param {{ catalogFn: () => Promise<any>, chains: any, k: any, holidays: any, now: () => number, zone: (t: any, cat: any) => string, walk: (ctx: any, steps: any[], prefix: string, locals: any) => Promise<any> }} deps
 */
export async function simulate(deps, flow, o) {
  const cat = o.cat || await deps.catalogFn();
  const compiled = compileFlow(flow, cat);
  if (!compiled.ok) return { ok: false, errors: compiled.errors, warnings: compiled.warnings };
  const caps = Array.isArray(flow.caps) ? flow.caps : deriveCaps(flow, cat);
  const limit = o.limit || 1000;
  /** @type {{ trigger: string, key: string, scope: any, env: any, at: number }[]} */
  const hits = [];
  let seen = 0;
  const t = flow.trigger;
  if (t.on === "event" || t.on === "stage") {
    let evs = o.events;
    if (!evs) {
      const chain = deps.chains.forFlow({ flow: "simulation", space: cat.space, approver: o.approver, tainted: false, run: "sim", source_spaces: [cat.space] });
      evs = await deps.k.events.read(chain, { type: "*", limit: 20_000 });
    }
    for (const env of evs) {
      if (o.since && env.received_at !== undefined && env.received_at < o.since) continue;
      if (o.until && env.received_at !== undefined && env.received_at > o.until) continue;
      seen++;
      const scope = triggerScope(t, env);
      if (scope && hits.length < limit) hits.push({ trigger: t.on, key: String(env.id), scope, env, at: env.received_at ?? env.time });
    }
  } else if (t.on === "time" && (t.cron !== undefined || t.every_ms !== undefined) && o.since !== undefined && o.until !== undefined) {
    // the schedule's real times: in its zone, inside its hours, off holidays (an interval counts from the window that opens, as it does live)
    const first = t.cron !== undefined ? o.since - 1 : o.since;
    for (const at of dueTimes(t, first, o.until, deps.zone(t, cat), deps.holidays, Math.min(limit, 1000)).times) hits.push({ trigger: "time", key: `sim@${at}`, scope: { trigger: { at } }, env: null, at });
  } else for (const [i, sample] of (o.samples || []).entries()) hits.push({ trigger: t.on, key: `sample${i}`, scope: { trigger: sample }, env: null, at: deps.now() });

  const runs = [];
  /** @type {Record<string, number>} */ const writes = {};
  /** @type {Record<string, { action: string, risk: string, count: number }>} */ const outward = {};
  let asks = 0, tasks = 0, completed = 0, paused = 0, failed = 0;
  for (const h of hits) {
    /** @type {Run} */
    const run = { id: "sim_" + h.key, flow: "simulation", version: 0, hash: "", space: cat.space, trigger: { kind: h.trigger, key: h.key, ...(h.env ? { event: slim(h.env) } : { input: h.scope.trigger }) },
      tainted: Boolean(h.env && (h.env.trust === "external" || h.env.trust === "untrusted")), source_spaces: (h.env && h.env.source_spaces) || [cat.space], depth: 0, state: "running", started_at: h.at, updated_at: h.at, steps: {}, approver: o.approver, dry: true };
    const ctx = { run, flow, view: { flow, id: "simulation" }, cat, caps, dry: true, count: 0, dryEffects: /** @type {any[]} */ ([]), dryAsks: 0, dryTasks: /** @type {any[]} */ ([]), softReads: Boolean(o.softReads) };
    /** @type {{ outcome: string, reason?: string }} */ let result = { outcome: "completed" };
    try { await deps.walk(ctx, flow.steps, "", {}); }
    catch (e) {
      if (e instanceof PauseFlow) result = { outcome: "paused", reason: e.reason };
      else if (e instanceof Suspend) result = { outcome: "completed" };
      else result = { outcome: "failed", reason: e instanceof Error ? e.message : String(e) };
    }
    if (result.outcome === "completed") completed++; else if (result.outcome === "paused") paused++; else failed++;
    asks += ctx.dryAsks; tasks += ctx.dryTasks.length;
    for (const eff of ctx.dryEffects) {
      if (/^records\.(create|update|remove)$/.test(eff.action)) { const ty = eff.resource.split("/")[3]; writes[ty] = (writes[ty] || 0) + 1; }
      if (OUTWARD.has(eff.risk)) { const k = eff.action; outward[k] = outward[k] || { action: eff.action, risk: eff.risk, count: 0 }; outward[k].count++; }
    }
    const ran = [...new Set(Object.entries(run.steps).filter(([k, v]) => !k.includes("?") && !k.includes("!") && (/** @type {any} */ (v)).status === "done").map(([k]) => k.replace(/@.*$/, "")))];
    runs.push({ event: h.env ? h.env.id : null, at: h.at, ...result, ran, asks: ctx.dryAsks, tasks: ctx.dryTasks.length, effects: ctx.dryEffects.length, tainted: run.tainted });
  }
  const span = o.since !== undefined && o.until !== undefined ? ` in ${describeSpan(o.until - o.since)}` : " in that window";
  return {
    ok: true, warnings: compiled.warnings, events_seen: seen, matched: hits.length,
    summary: `This Flow would have run ${hits.length} ${hits.length === 1 ? "time" : "times"}${span} and asked for ${asks} ${asks === 1 ? "approval" : "approvals"}.`
      + (paused ? ` ${paused} would have paused.` : "") + (failed ? ` ${failed} would have failed.` : ""),
    totals: { runs: hits.length, completed, paused, failed, asks, tasks, writes, outward: Object.values(outward) },
    runs: runs.slice(0, 200),
    cannot_prove: ["what the actions really do (they are stubbed)", "how long a person takes to answer a question or a task", "what a model or a Code step returns", "events that have not happened yet"],
  };
}
