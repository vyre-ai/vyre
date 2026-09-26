// @ts-check
// asks — the permission questions waiting on the user, as current state.
//
// Every ask is also an event (ask.raised, ask.answered), but events alone are not enough, which
// is the prototype's lesson: a surface that reconnects replays or skips the backlog, and either
// way it cannot tell what is open NOW. So open asks are rows, and a surface that comes back asks
// for them (threads.asks) instead of reconstructing them from history.
//
// Two more lessons from the prototype:
//   - The id is a capability. A button in a chat message or on a phone carries it, and whoever
//     presents it answers the question. Nine random bytes, not a counter.
//   - An ask closes when its answer reaches Claude Code, or when the session it belongs to ends,
//     never because a surface decided it had been dealt with.

import crypto from "node:crypto";

export class Asks {
  /** @param {import("node:sqlite").DatabaseSync} db */
  constructor(db) { this.db = db; }

  /** @param {{ thread: string, request_id: string, tool: string, summary: string, destination: string|null, reason: string|null }} a */
  raise(a) {
    const id = crypto.randomBytes(9).toString("hex");
    this.db.prepare(`INSERT INTO threads_asks (id, thread, request_id, tool, summary, destination, reason, at, state)
      VALUES (?,?,?,?,?,?,?,?, 'open')`).run(id, a.thread, a.request_id, a.tool, a.summary, a.destination, a.reason, Date.now());
    return /** @type {any} */ (this.get(id));
  }

  get(id) {
    const r = this.db.prepare("SELECT * FROM threads_asks WHERE id = ?").get(id);
    return r ? shape(r) : null;
  }

  byRequest(thread, requestId) {
    const r = this.db.prepare("SELECT * FROM threads_asks WHERE thread = ? AND request_id = ? AND state = 'open'").get(thread, requestId);
    return r ? shape(r) : null;
  }

  /** Open asks, oldest first: what has waited longest should be answered first. */
  open(thread) {
    const rows = thread
      ? this.db.prepare("SELECT * FROM threads_asks WHERE state = 'open' AND thread = ? ORDER BY at").all(thread)
      : this.db.prepare("SELECT * FROM threads_asks WHERE state = 'open' ORDER BY at").all();
    return rows.map(shape);
  }

  /** @param {"allow"|"deny"|"cancelled"} decision */
  close(id, decision, by) {
    const r = this.db.prepare("UPDATE threads_asks SET state = ?, decision = ?, answered_by = ?, answered_at = ? WHERE id = ? AND state = 'open'")
      .run(decision === "cancelled" ? "cancelled" : "answered", decision, by || null, Date.now(), id);
    return Number(r.changes) > 0;
  }
}

const shape = r => ({ id: String(r.id), thread: String(r.thread), tool: String(r.tool), summary: String(r.summary || ""),
  destination: r.destination == null ? null : String(r.destination), reason: r.reason == null ? null : String(r.reason),
  at: Number(r.at), state: String(r.state), decision: r.decision == null ? null : String(r.decision),
  request_id: String(r.request_id) });
