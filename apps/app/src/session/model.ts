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

/** The record's status (apps/CONTRACT.md 3.2) in session-state's words. */
export function stateOf(status: unknown, stoppedReason?: unknown): Session["state"] {
  switch (status) {
    case "working": case "running": return "running";
    case "waiting": return "waiting";
    case "starting": return "starting";
    case "failed": return "failed";
    case "stopped": return stoppedReason === "idle" ? "idle" : "stopped";
    default: return "idle";
  }
}

/** A turn is on: the composer steers or queues, and Stop shows. */
export const busy = (state: string) => state === "running" || state === "waiting" || state === "starting";

/**
 * The words under the title. A session closed for idleness is idle, not ended: the next message
 * resumes it (ADR 0030 section 7).
 */
export function stateWords(s: Pick<Session, "state" | "stopped">): { word: string; note: string | null; ended: boolean } {
  if (s.state === "idle" || s.stopped === "idle") return { word: "idle", note: s.stopped === "idle" ? "Resumes on your next message" : null, ended: false };
  if (s.state === "stopped") return { word: "ended", note: s.stopped && s.stopped !== "stopped" ? s.stopped : "Stopped", ended: true };
  if (s.state === "failed") return { word: "failed", note: s.stopped, ended: true };
  return { word: s.state, note: null, ended: false };
}

/** threads.send's answer: taken, queued by the box, or refused with what to say. */
export function sendOutcome(r: { data?: unknown; error?: { code?: string; message?: string } }): { ok: true; queued: boolean } | { ok: false; reason: string } {
  if (r.error) return { ok: false, reason: r.error.message || r.error.code || "Not sent" };
  const d = r.data && typeof r.data === "object" ? (r.data as Record<string, unknown>) : {};
  if (d.queued === true) return { ok: true, queued: true };
  if (d.sent === false) return { ok: false, reason: typeof d.note === "string" && d.note ? d.note : "The session did not take the message." };
  return { ok: true, queued: false };
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
