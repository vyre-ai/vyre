// @ts-check
// lib/session-state: one canonical shape of "what is a session doing right now" for a
// person-facing surface — Capsule, CLI, harness, chat, pwa. No feature state: nothing here reads
// config, the store or another module (boundaries: any part may import a lib).
//
// Why this exists: today three readers of the same session already disagree. switchboard's own
// five-state record status (core/switchboard/index.js's STATE map) is starting/working/waiting/
// idle/stopped, but "working" is relabelled "running" only inside the thread.state EVENT
// (STATE[fields.status]) — threads.get's own `status` field, and core/harness's own read of it
// (checking raw values ["starting","working","waiting","idle"]), both see the un-relabelled word.
// Capsule and CLI each fold that raw status into their own idea of "queued / asking / waiting /
// stopped" separately today. This lib is the one fold, used by all of them.
//
// Not yet true: sessions has not shipped thread.status (its own canonical event) yet. Until it
// does, canonicalOf's input is built from what switchboard already exposes (threads.get's status,
// plus whether the thread has an open ask/gate or queued-but-undelivered words — neither of which
// a single status field carries). Once thread.status lands, swap the caller's input to it
// directly; canonicalOf's four-state output and its rules do not need to change for that.

/** switchboard's own raw record states (core/switchboard/index.js STATE map's keys). */
export const RAW_STATES = ["starting", "working", "waiting", "idle", "stopped"];

/** The one canonical shape every surface should show for a session. */
export const STATES = ["queued", "asking", "waiting", "stopped"];

/**
 * Fold a session's raw status, plus the two facts no single status field carries, into the one
 * four-state shape every surface should show:
 *   - "stopped": the thread has stopped, or the status is not a raw state this lib knows (fails
 *     to the state a person can least mistake for "still going").
 *   - "asking": an unanswered ask or gate is open for this thread — the person, not the model, is
 *     what it is waiting on.
 *   - "queued": words are queued for this thread but not yet handed to a turn (the thread is busy
 *     elsewhere, or not running yet).
 *   - "waiting": everything else live (starting, working, waiting-on-a-tool, or idle) — a person
 *     watching the session does not need those four told apart at this level; a surface that does
 *     (Capsule's own richer state, `Vyred/State.swift`) reads switchboard's raw status directly
 *     for that, on top of this.
 * @param {{ status: string, hasOpenAsk?: boolean, hasQueued?: boolean }} s
 * @returns {"queued"|"asking"|"waiting"|"stopped"}
 */
export function canonicalOf(s) {
  const status = String((s && s.status) || "");
  if (status === "stopped" || !RAW_STATES.includes(status)) return "stopped";
  if (s && s.hasOpenAsk) return "asking";
  if (s && s.hasQueued) return "queued";
  return "waiting";
}
