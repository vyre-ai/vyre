// @ts-check
// An idle-closed session (its process already stopped) says "waking" once when the next message starts it again. The word is a notice, not a turn. A crash, or a stop the person asked for, does not say it.

/**
 * Before a status write: if this start is the resume of an idle close, emit the one notice.
 * Called before the UPDATE, so the row still says stopped with reason idle.
 * @param {{ db: { prepare: (sql: string) => { get: (...a: any[]) => any } }, emit: (type: string, payload: any, thread: string, project: string | null) => any }} sb
 * @param {string} id @param {Record<string, any>} fields
 */
export function noteIdleWake(sb, id, fields) {
  if (!fields || fields.status !== "starting") return;
  const prev = sb.db.prepare("SELECT project, status, stopped_reason FROM threads_runs WHERE id = ?").get(id);
  if (!prev || prev.status !== "stopped" || prev.stopped_reason !== "idle") return;
  sb.emit("thread.text", { message: "vyre", text: "waking", done: true, notice: true }, id, prev.project || null);
}
