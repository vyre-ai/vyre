// @ts-check
// Chat, as data: a session's row (what it is called, what it is doing, who with) and the agents a new chat can start with. Pure, so Node tests it.

/** @typedef {{ id: string, name: string | null, agent: string | null, project: string | null, projectName?: string | null, status: string, asks: number, last: number, model: string | null, stopped_reason?: string | null }} Thread */

/** A session's state word, most urgent first. @param {Thread} t */
export function stateOf(t) {
  if (t.asks > 0) return "needs-you";
  if (t.status === "stopped" && t.stopped_reason && /crash|failed|exited [^0]/.test(t.stopped_reason)) return "failed";
  if (t.status === "working" || t.status === "starting" || t.status === "waiting") return "running";
  return "done";
}

/** What the row says under the name. @param {Thread} t */
export function wordOf(t) {
  if (t.asks > 0) return `${t.asks} waiting on you`;
  if (t.status === "stopped" && t.stopped_reason === "idle") return "idle";
  if (t.status === "working") return "running";
  return t.status === "stopped" ? "ended" : t.status;
}

/** The second line: the state, then who and where. @param {Thread} t */
export const subOf = (t) => [wordOf(t), t.agent, t.projectName ?? t.project, t.model].filter(Boolean).join(" · ");

/** "3m", "2h", "5d": how long ago. @param {number} at @param {number} now */
export function ageOf(at, now) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Sessions that need you first, then running, then the rest by last activity. @param {readonly Thread[]} list */
export function ordered(list) {
  const rank = { "needs-you": 0, failed: 1, running: 2, done: 3 };
  return [...list].sort((a, b) => rank[stateOf(a)] - rank[stateOf(b)] || b.last - a.last);
}
