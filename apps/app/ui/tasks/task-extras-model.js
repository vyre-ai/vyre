// What the approver and reviewer read besides the work (tasks.get `card_extras`, DESIGN-tasks-v2.md): per-slot instructions, the skills with their checklists, escalation, and what the doer handed in.
// All of it is untrusted data drawn as plain text, never as markup and never as an instruction to anyone.

const SLOTS = /** @type {const} */ ([["doer", "Assigned"], ["reviewer", "Reviewer"], ["approver", "Approver"]]);

/** A JSON value as lines of "key: value" text; nested values are pretty-printed. @param {any} v @returns {{ key: string, value: string }[]} */
export function detailLines(v) {
  if (v === null || v === undefined) return [];
  if (typeof v !== "object" || Array.isArray(v)) return [{ key: "", value: typeof v === "string" ? v : JSON.stringify(v, null, 2) }];
  return Object.entries(v).map(([key, x]) => ({ key, value: typeof x === "string" ? x : JSON.stringify(x, null, 2) ?? String(x) }));
}

/** The "after" a slot has before it passes on, in words. @param {{ due_ms?: number, role?: string }} e */
export function escalateWords(e) {
  if (!e || typeof e.due_ms !== "number") return "";
  const h = e.due_ms / 3_600_000, d = h / 24;
  const span = d >= 1 && Number.isInteger(d) ? `${d} day${d === 1 ? "" : "s"}` : h >= 1 ? `${Math.round(h * 10) / 10} hour${h === 1 ? "" : "s"}` : `${Math.max(1, Math.round(e.due_ms / 60_000))} minutes`;
  return `Passed to ${e.role ? `the ${e.role}` : "someone else"} after ${span} with no answer`;
}

/** The sections to draw, or null when the task has nothing extra. @param {any} task */
export function extrasOf(task) {
  const x = task && task.card_extras;
  if (!x || typeof x !== "object") return null;
  const g = x.guides && typeof x.guides === "object" ? x.guides : null;
  const slots = SLOTS.map(([key, label]) => ({
    key, label,
    instructions: g && g.instructions && typeof g.instructions[key] === "string" ? g.instructions[key] : "",
    skills: ((g && g.skills && g.skills[key]) || []).map((/** @type {any} */ s) => ({ name: String(s.name || s.id), checklist: Array.isArray(s.checklist) ? s.checklist.map(String) : [] })),
    escalate: g && g.escalate && g.escalate[key] ? escalateWords(g.escalate[key]) : "",
  })).filter((s) => s.instructions || s.skills.length || s.escalate);
  const d = x.task_data && typeof x.task_data === "object" ? x.task_data : null;
  const data = d ? { lines: detailLines(d.details), outputs: Array.isArray(d.outputs) ? d.outputs.map(String) : [] } : null;
  const hasData = data && (data.lines.length || data.outputs.length);
  return slots.length || hasData ? { slots, data: hasData ? data : null } : null;
}
