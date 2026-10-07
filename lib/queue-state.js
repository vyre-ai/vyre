// @ts-check
// The life of a message a person types while the assistant works (steer), as a pure state machine.
// No state of its own and no imports: the switchboard's events go in, per-message states come out,
// so core/stream's adapter, the Deck and the tests all read one answer.
//
//   sent --> queued --> picked-up
//              |  \--> edited (stays queued, words changed) --> picked-up | cancelled
//              \-----> cancelled
//   sent --> picked-up          (typed to an idle thread: it is a turn at once)
//
// "queued" is both a steer (joins the running turn at its next safe point: between tool calls or
// turns, never mid-tool) and a message queued for the turn's end; "picked-up" is when Claude has it.
// A stop, an interrupt or a restart never moves a queued message to cancelled: only the person
// (thread.unqueued) does. picked-up and cancelled are final.

export const STATES = Object.freeze(["sent", "queued", "edited", "picked-up", "cancelled"]);

/** What can follow each state. */
const NEXT = Object.freeze({
  sent: ["queued", "picked-up"],
  queued: ["edited", "picked-up", "cancelled"],
  edited: ["edited", "picked-up", "cancelled"],
  "picked-up": [],
  cancelled: [],
});

/** Is this state final (nothing follows). @param {string} s */
export const isFinal = s => (NEXT[s] || []).length === 0;

/** Does the message still wait (it can be edited, sent now or taken back). @param {string} s */
export const isWaiting = s => s === "queued" || s === "edited";

/**
 * The state after an event, or the same state when the event does not apply (a late or repeated
 * event never moves a message backwards, so replaying a log is safe).
 * @param {string|null} from null for a message not seen yet
 * @param {string} to
 */
export function transition(from, to) {
  if (from == null) return STATES.includes(to) ? to : "sent";
  return (NEXT[from] || []).includes(to) ? to : from;
}

/**
 * The message a switchboard event is about, as the state it puts it in; null for any other event.
 * thread.sent: via "steer" is queued (joins the turn at its next step); via turn, now or restored
 * is picked-up; no via is a turn of its own at once (picked-up).
 * thread.queued: queued (edited when it says so). thread.steered: picked-up. thread.unqueued: cancelled.
 * @param {{ type: string, payload?: any, at?: number, time?: number }} ev
 * @returns {{ uuid: string|null, queued: number|null, state: string, text?: string, queued_at?: number, step?: number }|null}
 */
export function describe(ev) {
  const p = (ev && ev.payload) || {};
  const base = { uuid: p.uuid || null, queued: Number.isInteger(p.queued) ? p.queued : null };
  const more = { ...(typeof p.text === "string" ? { text: p.text } : {}), ...(typeof p.queued_at === "number" ? { queued_at: p.queued_at } : {}), ...(typeof p.step === "number" ? { step: p.step } : {}) };
  switch (ev && ev.type) {
    case "thread.sent": return { ...base, state: p.via === "steer" ? "queued" : "picked-up", ...more };
    case "thread.queued": return { ...base, state: p.edited ? "edited" : "queued", ...more };
    case "thread.steered": return { ...base, state: "picked-up", ...more };
    case "thread.unqueued": return { ...base, state: "cancelled", ...more };
    default: return null;
  }
}

/**
 * Fold events (oldest first) into each message's state, keyed by uuid (a message queued without
 * one is keyed "queued:<row id>"). Each entry keeps the words and times the first event that had
 * them gave, so a picked-up message still shows what it said.
 * @param {{ type: string, payload?: any, at?: number, time?: number }[]} events
 * @returns {Map<string, { uuid: string|null, queued: number|null, state: string, text?: string, queued_at?: number, step?: number }>}
 */
export function reduce(events) {
  /** @type {Map<string, any>} */
  const out = new Map();
  for (const ev of events || []) {
    const d = describe(ev);
    if (!d) continue;
    const key = d.uuid || (d.queued != null ? `queued:${d.queued}` : null);
    if (!key) continue;
    const was = out.get(key);
    // thread.sent via a queue hand-over names the row, not always the uuid: join them.
    const state = transition(was ? was.state : null, d.state);
    out.set(key, { ...(was || {}), ...d, ...(was && was.text && !d.text ? { text: was.text } : {}), ...(was && was.queued_at != null && d.queued_at == null ? { queued_at: was.queued_at } : {}), state, uuid: d.uuid || (was && was.uuid) || null });
  }
  return out;
}

/**
 * The stream frame data for one event: `user-message { message, text, state: sent|queued|picked-up, queued_at? }`
 * (core/stream's contract). "edited" is a queued message with new words, "cancelled" is not a frame
 * (the message is removed); null for both an unrelated event and a cancelled message.
 * @param {{ type: string, payload?: any }} ev
 * @returns {{ message: string, text: string, state: "sent"|"queued"|"picked-up", queued_at?: number, step?: number }|null}
 */
export function toUserMessage(ev) {
  const d = describe(ev);
  if (!d || d.state === "cancelled" || !d.uuid) return null;
  const state = d.state === "edited" ? "queued" : /** @type {"queued"|"picked-up"} */ (d.state);
  return { message: d.uuid, text: d.text || "", state, ...(d.queued_at != null ? { queued_at: d.queued_at } : {}), ...(d.step != null ? { step: d.step } : {}) };
}
