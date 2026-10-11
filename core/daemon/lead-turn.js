// @ts-check
// core/daemon/lead-turn.js: what a project lead is asked, and what it may answer (G08). The lead is a teammate whose turn is woken like any other (core/daemon/task-wake.js); what is different is the brief
// (the team and the project's tasks, in plain words) and the reply, which is a message for the person plus, optionally, picks the daemon applies. The lead proposes and the daemon applies through the
// kernel: the lead's own chain never changes a task. A pick moves a STUCK task to a teammate of the same project whose role fits; anything else is flagged to the person with a next step.

export const PLAN = "Plan ", REPORT = "Report on ";
export const MAX_STUCK_TIMES = 2;
const cut = (/** @type {unknown} */ s, /** @type {number} */ n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

/** Which lead turn a task is, from its title, or null. @param {string} title */
export function leadKind(title) {
  const t = String(title || "");
  return t.startsWith(PLAN) ? "plan" : t.startsWith(REPORT) ? "report" : null;
}

/**
 * The brief for a lead turn. Tasks are numbered for this turn only (the number is how a pick names one; no ids reach the model or the chat).
 * @param {{ kind: "plan"|"report", project: string, roster: { agent: string, role: string }[], tasks: { n: number, title: string, who: string, state: string, why?: string, times?: number }[], skipped?: string[] }} q
 */
export function leadBrief(q) {
  const lines = [
    q.kind === "plan" ? `You are the project lead of ${q.project}. This is a new project: plan it.` : `You are the project lead of ${q.project}. Write this project's report.`,
    "Your team:", ...q.roster.map(r => `- ${r.agent}, ${r.role}`),
    "The project's tasks now:", ...(q.tasks.length ? q.tasks.map(t => `${t.n}. ${cut(t.title, 120)} (${t.who}, ${t.state}${t.why ? `: ${cut(t.why, 120)}` : ""}${t.times && t.times > 1 ? `, stuck ${t.times} times` : ""})`) : ["none yet"]),
    ...(q.skipped && q.skipped.length ? ["Tasks that could not be made because no one on the team has the role:", ...q.skipped.map(s => `- ${cut(s, 120)}`)] : []),
    q.kind === "plan"
      ? "Write a short plan in plain words for the person: what happens first, who does it, and what you need from them. No ids, no jargon."
      : "Write a short report in plain words for the person: what is done, what is stuck and why, what is overdue, and what you need from them. No ids, no jargon.",
    "You may recommend giving a stuck task to a teammate whose role fits it, once, by ending your reply with one line: REASSIGN: {\"picks\":[{\"task\":3,\"to\":\"design\"}]} (task is its number above, to is the teammate's role).",
    "The person makes the move. Anything else (no fitting teammate, a task stuck twice, a task a person is doing) you do not recommend: say it in the message and what the person should do next.",
  ];
  return lines.join("\n");
}

/**
 * Split a lead's reply into the message for the person and the picks. A malformed pick line is ignored, and says so in `ignored`.
 * @param {string} text @returns {{ message: string, picks: { task: number, to: string }[], ignored: boolean }}
 */
export function parseLead(text) {
  const raw = String(text || "");
  const i = raw.search(/^REASSIGN:/m);
  const message = (i < 0 ? raw : raw.slice(0, i)).trim();
  if (i < 0) return { message, picks: [], ignored: false };
  const line = raw.slice(i).split("\n")[0].replace(/^REASSIGN:\s*/, "");
  try {
    const j = JSON.parse(line);
    const picks = (Array.isArray(j && j.picks) ? j.picks : []).filter((/** @type {any} */ p) => p && Number.isInteger(p.task) && typeof p.to === "string" && p.to).slice(0, 20).map((/** @type {any} */ p) => ({ task: p.task, to: String(p.to) }));
    return { message, picks, ignored: false };
  } catch { return { message, picks: [], ignored: true }; }
}
