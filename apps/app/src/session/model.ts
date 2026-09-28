// A session as the app reads it: the parts around chat's session core (deck/chat/core) that are
// the app's own. What the box returns becomes session-state events, the state becomes the words
// the header shows, and the items become the transcript's rows (runs of tools folded by the
// core's grouping). Pure: no React and no imports but types, so the Node tests load it as it is.

import type { Item, Session, SessionEvent } from "@vyre/chat-core/session-state.js";
import type { Row as GroupRow } from "@vyre/chat-core/grouping.js";

/** threads.get's events carry {id, at, type, payload}; the stream's also thread. Both as session-state reads them. */
export function toSessionEvent(e: unknown, thread: string): SessionEvent | null {
  if (!e || typeof e !== "object") return null;
  const o = e as Record<string, unknown>;
  if (typeof o.type !== "string") return null;
  const payload = o.payload && typeof o.payload === "object" ? { ...(o.payload as Record<string, unknown>) } : {};
  // The record's thread (the stream's) goes on the payload, where session-state checks it.
  const t = typeof o.thread === "string" ? o.thread : typeof payload.thread === "string" ? payload.thread : thread;
  payload.thread = t;
  const out: SessionEvent = { type: o.type, payload };
  if (typeof o.at === "number") out.at = o.at;
  if (typeof o.id === "number" || typeof o.id === "string") out.id = o.id;
  return out;
}

/**
 * The record's raw status (apps/CONTRACT.md 3.2: starting|working|waiting|idle|stopped, the
 * switchboard's own internal vocabulary, not a person's) in session-state's canonical words.
 * Mirrors lib/thread-status.js's threadStatus() (sessions owns that mapping) by hand, since this
 * file imports no runtime code but types: raw "waiting" (an ask is open) is "asking" to a person;
 * raw "idle" (ready, nothing open) is "waiting"; a "stopped" record reads its stopped_reason -
 * idle/restart/rewind is "paused" (resumable, nothing wrong), done/exited is "finished", an
 * "exited <code>" is "failed", anything else is plain "stopped".
 */
export function stateOf(status: unknown, stoppedReason?: unknown): Session["state"] {
  if (status === "waiting") return "asking";
  if (status === "idle") return "waiting";
  if (status === "stopped") {
    const r = typeof stoppedReason === "string" ? stoppedReason : "";
    if (r === "idle" || r === "restart" || r === "rewind") return "paused";
    if (r === "done" || r === "exited") return "finished";
    if (r.startsWith("exited ")) return "failed";
    return "stopped";
  }
  const known: Session["state"][] = ["starting", "working", "asking", "waiting", "paused", "stopped", "finished", "failed"];
  return typeof status === "string" && (known as string[]).includes(status) ? (status as Session["state"]) : "stopped";
}

/** Why the record stopped, as session-state keeps it (s.stopped): its reason, or "failed" for a failed one. */
export function stoppedOf(status: unknown, stoppedReason?: unknown): string | null {
  if (typeof stoppedReason === "string" && stoppedReason) return stoppedReason;
  return status === "failed" ? "failed" : null;
}

/** A turn is on: the composer steers or queues, and Stop shows. Matches deck/chat/session.js's own BUSY set. */
export const busy = (state: string) => state === "working" || state === "asking" || state === "starting";

/**
 * The words under the title. A session closed for idleness is "paused", not ended: the next
 * message resumes it (ADR 0030 section 7; lib/thread-status.js, deck/chat/session.js's own
 * idleClosed). `stopping`: Stop was pressed and the box has not said the turn ended yet; the chip
 * says so at once (native bar 10).
 */
export function stateWords(s: Pick<Session, "state" | "stopped">, stopping = false): { word: string; note: string | null; ended: boolean } {
  if (stopping && busy(s.state)) return { word: "stopping", note: null, ended: false };
  if (s.state === "paused") return { word: "paused", note: "Resumes on your next message", ended: false };
  if (s.state === "stopped" && s.stopped === "failed") return { word: "failed", note: null, ended: true };
  if (s.state === "stopped") return { word: "ended", note: s.stopped && s.stopped !== "stopped" ? s.stopped : "Stopped", ended: true };
  return { word: s.state, note: null, ended: false };
}

/**
 * threads.send's answer: taken (a steer names the box's uuid for the words), queued (the row's
 * id, queued_id, and the box's uuid), or refused with what to say.
 */
export function sendOutcome(r: { data?: unknown; error?: { code?: string; message?: string } }):
  | { ok: true; queued: false; uuid: string | null }
  | { ok: true; queued: true; id: number | string | null; uuid: string | null }
  | { ok: false; reason: string } {
  if (r.error) return { ok: false, reason: r.error.message || r.error.code || "Not sent" };
  const d = r.data && typeof r.data === "object" ? (r.data as Record<string, unknown>) : {};
  const uuid = typeof d.uuid === "string" && d.uuid ? d.uuid : null;
  if (d.queued != null && d.queued !== false) {
    const raw = d.queued_id ?? (d.queued === true ? null : d.queued);
    const id = typeof raw === "number" || typeof raw === "string" ? raw : null;
    return { ok: true, queued: true, id, uuid };
  }
  if (d.sent === false) return { ok: false, reason: typeof d.note === "string" && d.note ? d.note : "The session did not take the message." };
  return { ok: true, queued: false, uuid };
}

/**
 * The events a session was built from, kept for the view cache (open from it next time). Runs of
 * streamed text for the same block fold into one event carrying their joined delta, so a long
 * reply is one entry, not hundreds; the newest `cap` entries stay. Mutates and returns `log`.
 */
export function appendLog(log: SessionEvent[], e: SessionEvent, cap: number): SessionEvent[] {
  const last = log[log.length - 1];
  const p = e.payload as Record<string, unknown> | undefined;
  const lp = last?.payload as Record<string, unknown> | undefined;
  if (
    last && p && lp && e.type === "thread.text" && last.type === "thread.text" && !lp.done && !p.notice && !lp.notice &&
    typeof p.delta === "string" && typeof lp.delta === "string" && typeof p.text !== "string" &&
    p.message === lp.message && p.block === lp.block && (p.kind ?? "text") === (lp.kind ?? "text")
  ) {
    log[log.length - 1] = { ...last, ...(e.id !== undefined ? { id: e.id } : {}), payload: { ...lp, delta: lp.delta + p.delta, ...(p.done ? { done: true } : {}) } };
    return log;
  }
  log.push(e);
  if (log.length > cap) log.splice(0, log.length - cap);
  return log;
}

/**
 * Box to screen (native bar 3): from the box's stamp `t` on thread.text (epoch ms) to the paint,
 * with the clock offset between them (the box's clock minus this one, from one round trip). Null
 * when the event has no stamp or the difference cannot be right (negative after the offset, or
 * over a minute: the clocks are not synced).
 */
export function boxToScreen(t: unknown, paintEpoch: number, offset = 0): number | null {
  if (typeof t !== "number" || !isFinite(t) || t <= 0) return null;
  const ms = paintEpoch + offset - t;
  return ms < 0 || ms > 60_000 ? null : ms;
}

export type TranscriptRow =
  | { type: "item"; key: string; kind: Item["kind"] }
  | { type: "run"; key: string; keys: string[]; summary: string; running: boolean; failed: number; open: boolean };

/**
 * The rows a transcript draws: items in order, runs of tools as one row (the core's grouping),
 * a run's own tools after it only while it is open.
 */
export function transcriptRows(items: readonly Item[], groups: readonly GroupRow[], open: ReadonlySet<string>): TranscriptRow[] {
  const kind = new Map<string, Item["kind"]>();
  for (const it of items) kind.set(it.key, it.kind);
  const out: TranscriptRow[] = [];
  for (const g of groups) {
    if (g.type === "item") {
      out.push({ type: "item", key: g.key, kind: kind.get(g.key) ?? "notice" });
      continue;
    }
    const isOpen = open.has(g.key);
    out.push({ type: "run", key: g.key, keys: g.keys, summary: g.summary, running: g.running, failed: g.failed, open: isOpen });
    if (isOpen) for (const k of g.keys) out.push({ type: "item", key: k, kind: "tool" });
  }
  return out;
}

/** Two rows draw the same: a row re-renders only when this says they differ (its own item repaints through its key). */
export function sameRow(a: TranscriptRow, b: TranscriptRow): boolean {
  if (a === b) return true;
  if (a.type !== b.type || a.key !== b.key) return false;
  if (a.type === "item" && b.type === "item") return a.kind === b.kind;
  if (a.type === "run" && b.type === "run")
    return a.summary === b.summary && a.running === b.running && a.failed === b.failed && a.open === b.open && a.keys.length === b.keys.length;
  return false;
}

/** First guesses at row heights by kind (px), replaced by measurements (chat core window.js). */
export const ESTIMATES: Record<string, number> = { user: 64, text: 96, reasoning: 36, tool: 36, run: 36, turn: 28, notice: 28, ask: 132, steer: 24 };

/**
 * Did applying an event only change rows already drawn? Then only those rows repaint (a reply
 * streaming is the common case); anything new or gone, or a tool (its run's summary may change),
 * re-lays the list. Keys starting with "@" are not rows.
 */
export function onlyPatches(touched: readonly string[], drawn: ReadonlySet<string>, byKey: ReadonlyMap<string, { kind: string }>): boolean {
  for (const k of touched) {
    if (k.startsWith("@")) continue;
    const it = byKey.get(k);
    if (!it || !drawn.has(k) || it.kind === "tool") return false;
  }
  return true;
}
