// @ts-check
// The planner's item vocabulary: its kinds and states, the one name for a ring (`planner-<item>-<due>`), short ids for rings, and how a row is shown by the tools.
// The data itself lives in the Space's records (records.js).

import crypto from "node:crypto";

export const KINDS = ["alarm", "timer", "reminder", "todo", "note", "event", "task"];
export const STATES = ["open", "done", "cancelled"];

/**
 * The one name for a ring of an item at a moment: `planner-<item>-<due>`, due in epoch seconds. The
 * box's push uses it as its tag and each device as its local notification's id, so a ring heard
 * twice shows once (ADR 0029, R6).
 */
export const ringKey = (item, due) => `planner-${item}-${Math.floor(Number(due) / 1000)}`;
/** A ring key read back into { item, due (ms) }, or null. */
export const readKey = key => {
  const m = /^planner-(.+)-(\d{1,12})$/.exec(String(key ?? ""));
  return m ? { item: m[1], due: Number(m[2]) * 1000 } : null;
};

/** Short random ids: i_ for items, f_ for firings. */
export const newId = prefix => `${prefix}_${crypto.randomBytes(6).toString("base64url")}`;

/** A row as the tools show it: JSON parsed, flags as booleans. */
export function shape(r) {
  if (!r) return null;
  return {
    id: r.id, kind: r.kind, title: r.title, body: r.body ?? null, list: r.list ?? null, priority: r.priority, parent: r.parent ?? null,
    project: r.project ?? null, thread: r.thread ?? null, tags: safeJSON(r.tags, []), pinned: Boolean(r.pinned), state: r.state,
    at: r.at ?? null, tz: r.tz ?? null, floating: Boolean(r.floating), wall: r.wall ?? null, date: r.date ?? null,
    repeat: safeJSON(r.repeat, null), due: r.due ?? null, duration_ms: r.duration_ms ?? null, snooze_until: r.snooze_until ?? null,
    next_fire: r.next_fire ?? null, created: r.created, updated: r.updated, done_at: r.done_at ?? null, deleted_at: r.deleted_at ?? null,
    source: r.source ?? null, added_by: r.source_name ?? null, where: r.where_ ?? null,
    waits_on: r.waits_on ?? null, run_count: r.run_count ?? 0, last_result: r.last_result ?? null, paused: Boolean(r.paused),
    waits_on_fired: r.waits_on_fired ?? null, assignee: r.assignee ?? null,
  };
}
export const shapeFiring = f => f && ({ id: f.id, item: f.item, kind: f.kind, key: ringKey(f.item, f.due), due: f.due, ring: f.ring, missed: Boolean(f.missed), state: f.state,
  fired_at: f.fired_at, next_ring: f.next_ring ?? null, acked_at: f.acked_at ?? null, action: f.action ?? null, by: f.by ?? null, until: f.until ?? null });

function safeJSON(s, fallback) { try { return s == null ? fallback : JSON.parse(String(s)); } catch { return fallback; } }

