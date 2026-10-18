// @ts-check
// Small pure helpers of the Flow runner (kernel/flows/runner.js), kept here so the runner stays under its size cap: a Flow's step order, where a schedule's last fire is kept, the
// service-answer cap, and the few name and label readers.
import { compileFlow, needs as flowNeeds } from "./compile.js";

/** The steps of a Flow in the order a run walks them: a decide's branches and a repeat's steps follow it; a parallel step is one entry (its lanes are runs of their own). @param {any} flow @returns {string[]} */
export function stepOrder(flow) {
  /** @type {string[]} */ const out = [];
  const go = (/** @type {any[]} */ steps) => { for (const s of steps || []) { out.push(s.id); if (s.kind === "decide") { go(s.then); go(s.else); } else if (s.kind === "repeat") go(s.steps); } };
  go(flow.steps);
  return out;
}

/** Where a schedule's last fire is kept: the Flow's id, and for one trigger of several the id and its place in the list. @param {{ id: string, tIndex?: number }} f */
export const schedKey = f => (f.tIndex === undefined ? f.id : `${f.id}#${f.tIndex}`);

/** How much of a service's response a run keeps (a Flow reads data, it does not store documents; a big file goes by Drive reference). */
/** Does a service answer say the Chrome it needs is on a Mac that is off? Returns the plain reason, or null. @param {any} r */
export function deviceOffline(r) {
  if (!r || r.status !== 503 || typeof r.body !== "string") return null;
  try { const j = JSON.parse(Buffer.from(r.body, "base64").toString("utf8")); return j && j.error && j.error.class === "no_browser" && j.error.mac === true ? String(j.error.reason || "the Mac is offline").slice(0, 160) : null; } catch { return null; }
}

export const SERVICE_BODY_CAP = 64 * 1024;
/** @param {any} step @param {import('./compile.js').Catalog} cat */
/** The task events that end a wait: the checker's answer either way, the doer's completion, a skip. */
/** What a run prints when the host cannot find a name: never nothing ("Approved by ."), always words that read in a sentence. */
export const NAME_FALLBACK = Object.freeze({ person: "a team member", space: "this Space" });
export const TASK_ENDS = new Set(["task.approved", "task.rejected", "task.completed", "task.skipped", "task.declined"]);

export function needOf(step, cat) { return flowNeeds({ steps: [step] }, cat)[0]; }

/** @param {any} a */
export const nameOf = a => (a && a.id ? `${a.id}` : "the approver");
/** @param {import('./compile.js').Catalog} cat @param {string} action */
export const labelOf = (cat, action) => (cat.actions[action] && cat.actions[action].label ? cat.actions[action].label.toLowerCase() : action.replace(".", " ").replace(/-/g, " "));

/** @param {any} ctx */
export function flowUsesComputedOutward(ctx) {
  const c = compileFlow(ctx.view.flow, ctx.cat);
  return c.effects.needs_run_ask;
}
