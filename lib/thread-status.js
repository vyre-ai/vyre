// @ts-check
// The one canonical, person-facing vocabulary for a thread's lifecycle. Pure, no feature state:
// any part may import it (test/boundaries.test.js's KERNEL/lib rule).
//
// core/switchboard's own bookkeeping column (threads_runs.status) stays starting / working /
// waiting / idle / stopped, unchanged since ADR 0030 — that's Vyre's internal vocabulary, not a
// person's. Two of those five words already mean something a person would not guess:
//   - internal "waiting" is set only while an ask (a permission or a question) is open
//     (core/switchboard raiseAsk) — a person calls that "asking", not "waiting".
//   - internal "idle" is what a person calls "waiting": no turn running, nothing open, ready for
//     them to type.
// Left as raw strings, two different parts read the same word to mean different things: cohesion
// found core/harness checking the raw internal strings directly (["starting","working","waiting",
// "idle"]) while core/switchboard's own STATE map and the CLI relabel "working" to "running" for
// people — three names for one state, inside one blast radius (2026-09-28).
//
// queued is not covered here: it happens before a thread exists at all (core/sessions/slots.js, a
// concurrency limit keyed by owner/kind, not by thread id). A surface combines slot.queued with
// this thread's status once the thread actually starts.

/** The canonical, ordered vocabulary every surface (Deck, phone, Capsule, CLI, harness
 * statusline) should read instead of the raw internal status. */
export const THREAD_STATUSES = Object.freeze(["starting", "working", "asking", "waiting", "stopped", "finished", "failed"]);

/**
 * The canonical status for a thread, from switchboard's raw internal status and (only for
 * "stopped") its stopped_reason.
 * @param {string} raw threads_runs.status: starting | working | waiting | idle | stopped
 * @param {string|null} [reason] stopped_reason; only read when raw is "stopped"
 * @returns {string} one of THREAD_STATUSES
 */
export function threadStatus(raw, reason = null) {
  if (raw === "waiting") return "asking";
  if (raw === "idle") return "waiting";
  if (raw === "stopped") return reason === "done" || reason === "exited" ? "finished" : "stopped";
  return THREAD_STATUSES.includes(raw) ? raw : raw;
}
