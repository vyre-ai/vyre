// @ts-check
// asks: the permission questions waiting on the user, as current state.
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
  /**
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {(r: { id: string, thread: string, project: string|null }) => { always: boolean, always_project: string|null }} [offers]
   *   what "always allow" is on offer for an open permission ask (the switchboard knows: the suggestions are in its memory)
   */
  constructor(db, offers = () => ({ always: false, always_project: null })) { this.db = db; this.offers = offers; this.shape = r => shape(r, this.offers); }

  /**
   * A question (kind "question", its questions) or a permission (kind "permission", its detail).
   * Both are already redacted and capped; the row keeps them so a surface that comes back can
   * show the whole card.
   * @param {{ thread: string, request_id: string, tool: string, summary: string, destination: string|null, reason: string|null,
   *           kind?: "question"|"permission", questions?: any[], detail?: any, tool_use_id?: string|null }} a
   */
  raise(a) {
    const id = crypto.randomBytes(9).toString("hex");
    const kind = a.kind === "question" ? "question" : "permission";
    const detail = kind === "question" ? JSON.stringify(a.questions || []) : a.detail ? JSON.stringify(a.detail) : null;
    this.db.prepare(`INSERT INTO threads_asks (id, thread, request_id, tool, summary, destination, reason, at, state, kind, detail, tool_use_id)
      VALUES (?,?,?,?,?,?,?,?, 'open', ?, ?, ?)`).run(id, a.thread, a.request_id, a.tool, a.summary, a.destination, a.reason, Date.now(), kind, detail,
      a.tool_use_id ? String(a.tool_use_id) : null);
    return /** @type {any} */ (this.get(id));
  }

  /** The ask.raised event's id, once it is in the log: where the transcript view scrolls to. */
  anchored(id, event) {
    if (typeof event === "number") this.db.prepare("UPDATE threads_asks SET event = ? WHERE id = ?").run(event, id);
  }

  get(id) {
    const r = this.db.prepare(`${SELECT} WHERE a.id = ?`).get(id);
    return r ? this.shape(r) : null;
  }

  byRequest(thread, requestId) {
    const r = this.db.prepare(`${SELECT} WHERE a.thread = ? AND a.request_id = ? AND a.state = 'open'`).get(thread, requestId);
    return r ? this.shape(r) : null;
  }

  /**
   * Open asks, oldest first: what has waited longest should be answered first.
   * @param {string} [thread] @param {"question"|"permission"} [kind]
   */
  open(thread, kind) {
    let sql = `${SELECT} WHERE a.state = 'open'`;
    const args = [];
    if (thread) { sql += " AND a.thread = ?"; args.push(thread); }
    if (kind) { sql += " AND a.kind = ?"; args.push(kind); }
    return this.db.prepare(sql + " ORDER BY a.at").all(...args).map(this.shape);
  }

  /** @param {"allow"|"deny"|"always"|"cancelled"} decision */
  close(id, decision, by) {
    const r = this.db.prepare("UPDATE threads_asks SET state = ?, decision = ?, answered_by = ?, answered_at = ? WHERE id = ? AND state = 'open'")
      .run(decision === "cancelled" ? "cancelled" : "answered", decision, by || null, Date.now(), id);
    return Number(r.changes) > 0;
  }
}

/** An ask with its thread's agent, name and project, so a Needs row can say who is asking. */
const SELECT = `SELECT a.*, r.agent AS agent, r.name AS thread_name, r.project AS project
  FROM threads_asks a LEFT JOIN threads_runs r ON r.id = a.thread`;

const parse = v => { try { return v == null ? null : JSON.parse(String(v)); } catch { return null; } };

/**
 * A row as surfaces see it. `always` (an "always allow" is on offer) and `always_project` (the
 * project an "always in <project>" rule would be written for) depend on Claude Code's
 * suggestions, which live in the switchboard's memory only, so the switchboard says.
 * `anchor` is where it sits in the session: the tool call it is about and its ask.raised event.
 */
const shape = (r, offers) => {
  const kind = r.kind === "question" ? "question" : "permission";
  const detail = parse(r.detail);
  return { id: String(r.id), thread: String(r.thread), tool: String(r.tool), summary: String(r.summary || ""),
    destination: r.destination == null ? null : String(r.destination), reason: r.reason == null ? null : String(r.reason),
    at: Number(r.at), state: String(r.state), decision: r.decision == null ? null : String(r.decision),
    request_id: String(r.request_id), kind,
    ...(kind === "question" ? { questions: Array.isArray(detail) ? detail : [] } : detail ? { detail } : {}),
    agent: r.agent == null ? null : String(r.agent), project: r.project == null ? null : String(r.project), thread_name: r.thread_name == null ? null : String(r.thread_name),
    anchor: { tool_use_id: r.tool_use_id == null ? null : String(r.tool_use_id), event: r.event == null ? null : Number(r.event) },
    ...(kind === "permission" && r.state === "open"
      ? offers({ id: String(r.id), thread: String(r.thread), project: r.project == null ? null : String(r.project) })
      : { always: false, always_project: null }) };
};
