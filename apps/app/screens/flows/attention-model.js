// Runs that need a person (flows.attention) and the one answer each can be given (flows.settle). Pure (attention-model.test.js).

/** The buttons a row offers, in order: Retry and Skip for a run that stopped, Stop for any that can be stopped, Move on for a stage gate (it needs a reason). @param {{ kind: string, gate?: boolean }} row @returns {{ action: "retry" | "skip" | "stop" | "advance", label: string, reason?: boolean }[]} */
export function answersFor(row) {
  if (row.gate) return [{ action: "advance", label: "Move on", reason: true }];
  if (row.kind === "stale") return [{ action: "stop", label: "Stop" }];
  return [{ action: "retry", label: "Retry" }, { action: "skip", label: "Skip" }, { action: "stop", label: "Stop" }];
}

/** The input flows.settle takes for an answer. @param {string} run @param {"retry" | "skip" | "stop" | "advance"} action @param {string} [reason] */
export const settleInput = (run, action, reason) => ({ run, action, ...(reason && reason.trim() ? { reason: reason.trim() } : {}) });

/** One row in plain words: the Flow, the step, what happened. @param {{ label: string, step_label?: string, message?: string }} row */
export const rowWords = (row) => ({ title: row.label, sub: [row.step_label, row.message].filter(Boolean).join(": ") });
