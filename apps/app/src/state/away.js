// @ts-check
// "While you were away" (Now, rc.2): one card, shown once, when the person comes back after a stretch away AND something major changed: new things that need them, Flow runs that finished or did not, documents
// signed, new members. Nothing minor ever raises it. Once seen (dismissed, or Now left with the card on screen) the same changes never show again: the next visit starts from where this one ended. Pure; AwayCard.tsx
// reads the box and keeps the state on this device.

/** How long away counts as away: six hours. */
export const ABSENCE_MS = 6 * 3_600_000;

/** @typedef {{ at: number, seq: number, needs: string[] }} AwayState what the last visit ended on: when, how far the log had come, and which needs were open */
/** @typedef {{ needs: number, finished: number, failed: number, signed: number, members: number }} Changes */

/**
 * What happened since the cursor, from the space's events (records.events) and the needs that are open now.
 * @param {readonly { type?: string, seq?: number, data?: any }[]} events @param {readonly string[]} before the need ids open at the last visit @param {readonly string[]} now the need ids open now
 * @param {number} [since] the log position of the last visit; events at or before it are not new
 * @returns {Changes}
 */
export function changesSince(events, before, now, since = 0) {
  const c = { needs: 0, finished: 0, failed: 0, signed: 0, members: 0 };
  const seen = new Set(before);
  c.needs = now.filter((id) => !seen.has(id)).length;
  for (const e of events || []) {
    if (!e || (typeof e.seq === "number" && e.seq <= since)) continue;
    // events from the modules' bus keep what they said under data.payload (the log's legacy form); the log's own events say it in data
    const d = e.data && typeof e.data === "object" && e.data.payload && typeof e.data.payload === "object" ? e.data.payload : e.data;
    if (e.type === "flow.finished") { const s = d && d.state; if (s === "done") c.finished += 1; else if (s !== "cancelled") c.failed += 1; }
    else if (e.type === "flow.stuck") c.failed += 1;
    else if (e.type === "documents.signed") c.signed += 1;
    else if (e.type === "member.added") c.members += 1;
  }
  return c;
}

/** Major means one of the four things the person would want to hear about; nothing else raises the card. @param {Changes} c */
export const isMajor = (c) => c.needs + c.finished + c.failed + c.signed + c.members > 0;

const n = (/** @type {number} */ k, /** @type {string} */ one, /** @type {string} */ many) => (k === 1 ? one : many.replace("#", String(k)));

/** The lines on the card, in plain words, most pressing first. @param {Changes} c @returns {string[]} */
export function awayLines(c) {
  /** @type {string[]} */ const out = [];
  if (c.needs) out.push(n(c.needs, "1 new thing needs you", "# new things need you"));
  if (c.failed) out.push(n(c.failed, "1 Flow run did not finish", "# Flow runs did not finish"));
  if (c.finished) out.push(n(c.finished, "1 Flow run finished", "# Flow runs finished"));
  if (c.signed) out.push(n(c.signed, "1 document was signed", "# documents were signed"));
  if (c.members) out.push(n(c.members, "1 new member joined", "# new members joined"));
  return out;
}

/** Whether the person has been away long enough that a return is worth a card. @param {AwayState | null} state @param {number} now */
export const wasAway = (state, now) => Boolean(state && now - state.at >= ABSENCE_MS);

/** The state a visit ends on. @param {{ now: number, seq: number, needs: readonly string[] }} v @returns {AwayState} */
export const visited = (v) => ({ at: v.now, seq: v.seq, needs: [...v.needs] });

/** What the stored text is, or nothing. @param {string | null} raw @returns {AwayState | null} */
export function readState(raw) {
  try {
    const s = raw ? JSON.parse(raw) : null;
    return s && typeof s.at === "number" && typeof s.seq === "number" && Array.isArray(s.needs) ? { at: s.at, seq: s.seq, needs: s.needs.map(String) } : null;
  } catch { return null; }
}

/** The highest log position in a list of events. @param {readonly { seq?: number }[]} events */
export const topSeq = (events) => (events || []).reduce((m, e) => (e && typeof e.seq === "number" && e.seq > m ? e.seq : m), 0);
