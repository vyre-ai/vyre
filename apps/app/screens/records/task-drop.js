// @ts-check
// A card dropped on a column of the Tasks board. A task's status belongs to the kernel, so a drop is never a plain field write: the states a person may put a task in (start it, flag it stuck, skip it, put it back to ready) go through tasks.move; the others are the kernel's own and the board says so.

/** The tasks.move targets a drop can ask for. */
export const DROP_TARGETS = ["ready", "working", "stuck", "skipped"];

/** What a drop on `to` does for a task now in `from`: { call } to send, { same } when it did not move, or { say } with the reason it cannot. @param {string} from @param {string} to */
export function taskDrop(from, to) {
  if (from === to) return { same: true };
  if (to === "done") return { say: "A task is done when its check passes. Open it to finish it." };
  if (to === "needs_check") return { say: "A task reaches Needs check when its doer submits it." };
  if (to === "waiting") return { say: "A task waits on what it depends on. That is not set by hand." };
  if (!DROP_TARGETS.includes(to)) return { say: "That column is not one a task can be moved to." };
  return { call: { to, ...(to === "stuck" ? { reason: "Flagged from the board" } : {}) } };
}
