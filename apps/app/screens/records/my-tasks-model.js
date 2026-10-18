// @ts-check
// "My tasks": three lists, one per slot a person holds on a task (tasks.list mine: assigned | reviewing | approving), each with the states that mean "your turn".

/** The groups in order, with the state each one asks tasks.list for and the words above it. */
export const MY_GROUPS = [
  { slot: "assigned", title: "Assigned to you", states: ["ready", "working", "changes_requested", "stuck"], empty: "Nothing is waiting on you." },
  { slot: "reviewing", title: "Reviewing", states: ["in_review"], empty: "Nothing is waiting for your review." },
  { slot: "approving", title: "Approving", states: ["needs_check"], empty: "Nothing is waiting for your approval." },
];

/** Plain words for a state. @param {string} s */
export const stateWords = (s) => ({ ready: "Ready", working: "In progress", in_review: "In review", changes_requested: "Changes asked", needs_check: "Awaiting approval", stuck: "Stuck", done: "Done", skipped: "Skipped", waiting: "Waiting" })[s] || s;

/** Rows sorted for reading: the ones with a due date first, soonest first, then the rest in the order given. @param {any[]} tasks */
export function dueFirst(tasks) {
  const t = (/** @type {any} */ x) => { const n = typeof x.due === "number" ? x.due : x.due ? Date.parse(String(x.due)) : NaN; return Number.isFinite(n) ? n : null; };
  const list = Array.isArray(tasks) ? tasks : [];
  return [...list.filter((x) => t(x) !== null).sort((a, b) => /** @type {number} */ (t(a)) - /** @type {number} */ (t(b))), ...list.filter((x) => t(x) === null)];
}
