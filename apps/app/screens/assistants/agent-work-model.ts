// An agent's Work: its threads from threads.list (agent filter), newest first, told apart by the thread's own purpose. A Flow step or a task that gives an agent work records no thread today
// (team audit, 13 Oct), so there is no "From Flows" group: a thread started by a job is a Job, anything else is a person's chat.
import { threadStatus } from "../../../../lib/thread-status.js";

export type WorkFilter = "all" | "people" | "jobs";
export const WORK_FILTERS: [WorkFilter, string][] = [["all", "All"], ["people", "From people"], ["jobs", "Jobs"]];

export type WorkRow = { id: string; title: string; kind: "people" | "job"; state: "running" | "waiting" | "done" | "failed" | "paused"; stateText: string; sub: string; last: number; needsYou: boolean };

const JOB_PURPOSES = new Set(["job", "helper", "planner"]);
const STATE_TEXT: Record<WorkRow["state"], string> = { running: "Running", waiting: "Waiting on you", done: "Done", failed: "Failed", paused: "Paused" };

const s = (v: unknown): string => (typeof v === "string" ? v : "");

/** threads.list's rows for one agent as Work rows. Anything that is not a thread of that agent is dropped. */
export function workRows(list: unknown, agent: string, now = Date.now()): WorkRow[] {
  if (!Array.isArray(list)) return [];
  const out: WorkRow[] = [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, any>;
    const id = s(o.id);
    if (!id || s(o.agent) !== agent || o.archived) continue;
    const kind = JOB_PURPOSES.has(s(o.purpose)) ? "job" : "people";
    const canon = s(o.canonical_status) || threadStatus(s(o.status) || "idle", s(o.stopped_reason) || null);
    const asks = typeof o.asks === "number" ? o.asks : 0;
    const state: WorkRow["state"] = asks > 0 || canon === "asking" ? "waiting" : canon === "failed" ? "failed" : canon === "starting" || canon === "working" ? "running" : canon === "paused" || canon === "stopped" ? "paused" : "done";
    const last = typeof o.last === "number" ? o.last : 0;
    const named = s(o.name) && s(o.name) !== agent ? s(o.name) : "";
    const title = named || (kind === "job" ? "Job" : "Chat");
    out.push({ id, title, kind, state, stateText: STATE_TEXT[state], sub: [kind === "job" ? "Started by a job" : "Started by a person", STATE_TEXT[state], last ? ago(last, now) : ""].filter(Boolean).join(" · "), last, needsYou: state === "waiting" });
  }
  return out.sort((a, b) => b.last - a.last);
}

export function filterWork(rows: WorkRow[], f: WorkFilter): WorkRow[] {
  return f === "all" ? rows : rows.filter((r) => (f === "jobs" ? r.kind === "job" : r.kind === "people"));
}

export function ago(at: number, now: number): string {
  const m = Math.max(0, Math.round((now - at) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** The empty line for a filter, with what to do next. */
export function emptyWork(name: string, f: WorkFilter): string {
  if (f === "jobs") return `${name} has run no jobs yet. A job runs when a scheduled task of ${name}'s rings.`;
  if (f === "people") return `Nobody has chatted with ${name} yet. Use Talk to ${name} above to start.`;
  return `${name} has no threads yet. Talk to ${name}, or schedule a task for it.`;
}
