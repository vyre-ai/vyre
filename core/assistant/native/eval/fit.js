// @ts-check
// The fit score: how natively a model works in Vyre, from five real tasks with deterministic checkers (tasks.js), at a hard dollar cap.
// Behaviour that depends on the provider lives only in the adapter; this file knows nothing of any provider. The score is shown in the model picker.

import { buildFixture } from "./fixture.js";
import { TASKS } from "./tasks.js";

/**
 * @typedef {{ role: "system"|"user"|"assistant"|"tool", content: string, tool_calls?: { id: string, name: string, input: any }[], tool_call_id?: string, name?: string }} Message
 * @typedef {{ name: string, run: (messages: Message[], tools: { name: string, description: string, schema: any }[], opts: { task: string, max_tokens: number }) => Promise<{ content: string, tool_calls?: { id: string, name: string, input: any }[], usage?: { input_tokens: number, output_tokens: number } }> }} Adapter
 * @typedef {{ id: string, title: string, score: number|null, max: number, notes: string[], calls: number, cost_usd: number, state: "scored"|"skipped_budget" }} TaskResult
 * @typedef {{ model: string, fit: number, max: number, partial: boolean, attempted: number, tasks: TaskResult[], cost_usd: number, budget_usd: number }} FitResult
 */

const PER_TASK = 20;
const MAX_TOKENS = 1024;
const MAX_STEPS = 8;
/** Dollars per million tokens when the caller gives no table: deliberately a high guess, so the cap errs on stopping early. */
const DEFAULT_PRICE = { in: 15, out: 75 };

/** Rough input size of a conversation, for the next call's worst case: four characters a token. @param {Message[]} m */
const estimateInput = m => Math.ceil(JSON.stringify(m).length / 4);

/**
 * @param {{ adapter: Adapter, kernelFixture?: () => ReturnType<typeof buildFixture>, budgetUsd?: number, tasks?: typeof TASKS, prices?: Record<string, { in: number, out: number }>, maxSteps?: number }} o
 * @returns {Promise<FitResult>}
 */
export async function evaluateModel({ adapter, kernelFixture = buildFixture, budgetUsd = 5, tasks = TASKS, prices = {}, maxSteps = MAX_STEPS }) {
  const price = prices[adapter.name] || DEFAULT_PRICE;
  const cost = (/** @type {number} */ i, /** @type {number} */ o) => (i * price.in + o * price.out) / 1e6;
  let spent = 0, partial = false;
  /** @type {TaskResult[]} */ const results = [];

  for (const task of tasks) {
    if (partial) { results.push({ id: task.id, title: task.title, score: null, max: PER_TASK, notes: ["not run: the budget was reached"], calls: 0, cost_usd: 0, state: "skipped_budget" }); continue; }
    const fx = kernelFixture();
    /** @type {Message[]} */ const messages = [{ role: "system", content: fx.system }, { role: "user", content: task.prompt }];
    let taskCost = 0, stopped = false, steps = 0;
    for (; steps < maxSteps; steps++) {
      // The worst this call could cost: all of what it reads and the most it may write. If that could pass the cap, stop here.
      if (spent + cost(estimateInput(messages), MAX_TOKENS) > budgetUsd) { stopped = true; partial = true; break; }
      const r = await adapter.run(messages, fx.tools, { task: task.id, max_tokens: MAX_TOKENS });
      const used = cost(r.usage?.input_tokens ?? estimateInput(messages), r.usage?.output_tokens ?? Math.ceil(String(r.content || "").length / 4));
      spent += used; taskCost += used;
      messages.push({ role: "assistant", content: String(r.content || ""), ...(r.tool_calls && r.tool_calls.length ? { tool_calls: r.tool_calls } : {}) });
      if (!r.tool_calls || !r.tool_calls.length) break;
      for (const c of r.tool_calls) {
        const result = await fx.execute(c.name, c.input);
        messages.push({ role: "tool", tool_call_id: c.id, name: c.name, content: JSON.stringify(result) });
      }
    }
    const last = [...messages].reverse().find(m => m.role === "assistant");
    const t = { messages, calls: fx.calls, final: last ? last.content : "" };
    if (stopped) {
      results.push({ id: task.id, title: task.title, score: null, max: PER_TASK, notes: ["stopped part way: the next call could pass the budget"], calls: fx.calls.length, cost_usd: round(taskCost), state: "skipped_budget" });
      continue;
    }
    const { score, notes } = task.check(t, fx);
    results.push({ id: task.id, title: task.title, score: Math.max(0, Math.min(PER_TASK, score)), max: PER_TASK, notes, calls: fx.calls.length, cost_usd: round(taskCost), state: "scored" });
  }
  const scored = results.filter(r => r.state === "scored");
  return { model: adapter.name, fit: scored.reduce((n, r) => n + (r.score || 0), 0), max: tasks.length * PER_TASK, partial, attempted: scored.length, tasks: results, cost_usd: round(spent), budget_usd: budgetUsd };
}

const round = (/** @type {number} */ n) => Math.round(n * 1e6) / 1e6;

/** The table `run.js` prints. @param {FitResult} r */
export function formatFit(r) {
  const rows = r.tasks.map(t => `${t.id.padEnd(10)} ${t.score === null ? "  -" : String(t.score).padStart(3)} / ${t.max}  ${t.notes.join("; ") || "ok"}`);
  return [`Fit for ${r.model}: ${r.fit} of ${r.max}${r.partial ? ` (partial: ${r.attempted} of ${r.tasks.length} tasks scored)` : ""}, cost $${r.cost_usd.toFixed(4)} of $${r.budget_usd}`, ...rows].join("\n");
}
