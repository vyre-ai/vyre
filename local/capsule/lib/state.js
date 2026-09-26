// @ts-check
// state — what is waiting on the user, and what a thread is saying, folded from vyred's events.
//
// Two kinds of thing wait: a Gate hold (a draft or a send that needs a yes, spec 7.7) and a
// permission question from a running session (ask.raised, spec 7.8). The Capsule shows both in
// one Beacon list, oldest first, because whoever has waited longest should be answered first.
// Only an explicit question asks for attention (floor rule 6), so nothing else lands here.
//
// Pure: events in, plain objects out. The main process owns the one copy and sends it to the
// window, so a hidden window that wakes up is shown the truth rather than what it last saw.

/**
 * @typedef {{ source: "gate"|"ask", id: string, title: string, sub: string, at: number, thread?: string|null,
 *   project?: string|null, draft?: { to?: string, subject?: string, body?: string }|null, rule?: string|null,
 *   tool?: string|null }} Waiting
 */

const s = v => (v == null ? "" : String(v));

/** A Gate hold as a row. Its fields are read defensively: the Gate is still being built. */
export function fromHeld(h) {
  const who = s(h.agent || h.by || "an agent");
  const draft = h.draft || (h.body || h.subject || h.to ? { to: h.to, subject: h.subject, body: h.body || h.text } : null);
  return /** @type {Waiting} */ ({
    source: "gate", id: s(h.id), at: Number(h.at || h.held_at || Date.now()),
    title: s(h.title || h.summary || (draft ? `${who} drafted a message to ${s(draft.to).replace(/\s*<.*>$/, "") || "someone"}` : `${who} is waiting for you`)),
    sub: [h.projectName || h.project, h.rule ? `held by rule: ${h.rule}` : h.reason].filter(Boolean).join(" · "),
    thread: h.thread || null, project: h.project || null, draft, rule: h.rule || h.reason || null, tool: h.tool || null,
  });
}

/** An ask.raised event as a row. `name` turns a project slug into the name people know it by. */
export function fromAsk(e, name = slug => slug) {
  const p = e.payload || {};
  const who = s(p.agent || p.thread_name || "a session");
  return /** @type {Waiting} */ ({
    source: "ask", id: s(p.ask || p.id), at: Number(e.at || Date.now()), thread: e.thread || p.thread || null, project: e.project || null,
    title: `${who} asks to ${s(p.summary || p.tool || "use a tool")}`,
    sub: [e.project ? name(e.project) : null, p.destination ? `to ${p.destination}` : null, p.reason].filter(Boolean).join(" · "),
    draft: null, rule: p.reason || null, tool: p.tool || null,
  });
}

/** Oldest first, one row per id. */
export function waiting(list) {
  const byId = new Map();
  for (const w of list) if (w.id) byId.set(`${w.source}:${w.id}`, w);
  return [...byId.values()].sort((a, b) => a.at - b.at);
}

/**
 * Fold one event into the waiting list. Returns the new list, or the same list when the event
 * changes nothing (so the caller knows not to repaint).
 * @param {Waiting[]} list @param {any} e @param {(slug: string) => string} [name]
 */
export function applyWaiting(list, e, name = slug => slug) {
  const p = e.payload || {};
  if (e.type === "ask.raised") return waiting([...list, fromAsk(e, name)]);
  if (e.type === "ask.answered" || e.type === "ask.cancelled") return drop(list, "ask", p.ask || p.id);
  if (e.type === "gate.held") return waiting([...list, fromHeld({ ...p, at: e.at, thread: e.thread, project: e.project })]);
  if (["gate.approved", "gate.rejected", "gate.released", "gate.sent"].includes(e.type)) return drop(list, "gate", p.id || p.held);
  return list;
}

const drop = (list, source, id) => {
  const next = list.filter(w => !(w.source === source && w.id === s(id)));
  return next.length === list.length ? list : next;
};

/**
 * A thread's reply as it streams. thread.text with done:false carries a piece to append; with
 * done:true it carries the whole message, which replaces what was pieced together (the pieces
 * are throttled upstream and may have skipped nothing or something; the whole message is true).
 * @typedef {{ thread: string, order: string[], text: Record<string, string>, tools: { id: string, summary: string, done: boolean, error: boolean }[],
 *   finished: boolean, ok: boolean|null, error: string|null, lease: string|null }} Reply
 */
export function reply(thread) {
  return /** @type {Reply} */ ({ thread, order: [], text: {}, tools: [], finished: false, ok: null, error: null, lease: null });
}

/** @param {Reply} r @param {any} e @returns {Reply} */
export function applyReply(r, e) {
  if (!r || e.thread !== r.thread) {
    if (r && e.type === "lease.changed" && (e.payload || {}).thread === r.thread) return { ...r, lease: s(e.payload.holder || e.payload.surface) || null };
    return r;
  }
  const p = e.payload || {};
  if (e.type === "thread.text") {
    const id = s(p.message || "m");
    const order = r.order.includes(id) ? r.order : [...r.order, id];
    const text = { ...r.text, [id]: p.done ? s(p.text) : (r.text[id] || "") + s(p.text) };
    return { ...r, order, text, finished: false };
  }
  if (e.type === "thread.tool") {
    if (p.phase === "done") return { ...r, tools: r.tools.map(t => (t.id === p.id ? { ...t, done: true, error: Boolean(p.error) } : t)) };
    return { ...r, tools: [...r.tools, { id: s(p.id), summary: s(p.summary || p.tool), done: false, error: false }].slice(-6) };
  }
  if (e.type === "thread.finished") return { ...r, finished: true, ok: p.ok !== false, error: p.ok === false ? s(p.error || "the turn failed") : null };
  if (e.type === "lease.changed") return { ...r, lease: s(p.holder || p.surface) || null };
  return r;
}

/** The reply as one string, messages in the order they began. */
export const replyText = r => r.order.map(id => r.text[id]).filter(Boolean).join("\n\n");
