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
 *   project?: string|null, to?: string, via?: string|null, kind?: string, why?: string|null, rule?: string|null,
 *   tool?: string|null }} Waiting
 */

const s = v => (v == null ? "" : String(v));

/**
 * A Gate hold as a row, from gate.held or a gate.held event: `{id, kind, via, to: string[],
 * summary, why, agent, thread, project, at, error?}`. The words are not in it; the card asks
 * gate.get for them when it opens.
 */
export function fromHeld(h) {
  const who = s(h.agent || "an agent");
  const to = (Array.isArray(h.to) ? h.to : [h.to]).filter(Boolean).map(s);
  const first = (to[0] || "someone").replace(/\s*<.*>$/, "") + (to.length > 1 ? ` and ${to.length - 1} more` : "");
  const what = h.kind === "spend" ? "a payment to" : h.kind === "delete" ? "a deletion at" : "a message to";
  return /** @type {Waiting} */ ({
    source: "gate", id: s(h.id), at: Number(h.at || Date.now()),
    title: `${who} drafted ${what} ${first}`,
    sub: [h.summary, h.projectName || h.project, h.error ? "last send failed" : null].filter(Boolean).join(" · "),
    thread: h.thread || null, project: h.project || null, to: to.join(", "), via: h.via || null, kind: h.kind || "send",
    why: h.why || null, rule: null, tool: null,
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
    rule: p.reason || null, tool: p.tool || null,
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
  // ask.answered {ask, decision, by}: decision "cancelled" when Claude Code withdrew the question
  // or its thread stopped. There is no separate event for that.
  if (e.type === "ask.answered") return drop(list, "ask", p.ask || p.id);
  if (e.type === "gate.held") return waiting([...list, fromHeld({ ...p, at: e.at, thread: e.thread, project: e.project })]);
  if (e.type === "gate.released" || e.type === "gate.rejected") return drop(list, "gate", p.id);
  // A send that failed is held again, with its error, for the user to send again or discard.
  if (e.type === "gate.failed") return list.map(w => (w.source === "gate" && w.id === s(p.id) ? { ...w, sub: [w.sub.replace(/ · last send failed$/, ""), "last send failed"].filter(Boolean).join(" · ") } : w));
  return list;
}

const drop = (list, source, id) => {
  const next = list.filter(w => !(w.source === source && w.id === s(id)));
  return next.length === list.length ? list : next;
};

/**
 * A thread's reply as it streams. thread.text is `{message, delta}`, a piece to append (throttled
 * to 20 a second by the switchboard), or `{message, text, done: true}`, the whole block, which
 * replaces the pieces: the whole block is what Claude Code said, the pieces are only how it
 * arrived. `message` is Claude Code's message id, shared by a block's pieces and its whole text.
 * A notice from vyred itself (the switch to the API key) is `{message: "vyre", text, done, notice}`.
 *
 * `cost` is what thread.finished reported (Claude Code's total_cost_usd, summed over the turns of
 * this reply), `ms` how long the last turn took. The switchboard reports no token counts.
 * `cancelled` is the user's Stop: nothing that arrives after it changes the reply.
 * @typedef {{ thread: string, order: string[], text: Record<string, string>, tools: { id: string, summary: string, done: boolean, error: boolean }[],
 *   finished: boolean, ok: boolean|null, error: string|null, lease: string|null, cost: number|null, ms: number|null,
 *   cancelled?: boolean, model?: string|null, memory?: { answer: string|null, sources: any[] }|null }} Reply
 */
export function reply(thread) {
  return /** @type {Reply} */ ({ thread, order: [], text: {}, tools: [], finished: false, ok: null, error: null, lease: null, cost: null, ms: null });
}

/** The user stopped it: finished, with the error "stopped", and deaf to what comes after. @param {Reply} r @returns {Reply} */
export function cancel(r) {
  return { ...r, finished: true, ok: false, error: "stopped", cancelled: true };
}

/** @param {Reply} r @param {any} e @returns {Reply} */
export function applyReply(r, e) {
  if (!r || r.cancelled || e.thread !== r.thread) return r;
  const p = e.payload || {};
  if (e.type === "thread.text") {
    const id = s(p.message || "m");
    const order = r.order.includes(id) ? r.order : [...r.order, id];
    const text = { ...r.text, [id]: p.done ? s(p.text) : (r.text[id] || "") + s(p.delta) };
    return { ...r, order, text, finished: false };
  }
  if (e.type === "thread.tool") {
    if (p.phase === "done") return { ...r, tools: r.tools.map(t => (t.id === p.id ? { ...t, done: true, error: Boolean(p.error) } : t)) };
    return { ...r, tools: [...r.tools, { id: s(p.id), summary: s(p.summary || p.tool), done: false, error: false }].slice(-6) };
  }
  if (e.type === "thread.stopped") return { ...r, finished: true, ok: false, error: `the thread stopped${p.reason ? ": " + s(p.reason) : ""}` };
  if (e.type === "thread.finished") {
    const cost = typeof p.cost_usd === "number" ? (r.cost || 0) + p.cost_usd : r.cost;
    const ms = typeof p.duration_ms === "number" ? p.duration_ms : r.ms;
    return { ...r, finished: true, ok: p.ok !== false, error: p.ok === false ? s(p.error || "the turn failed") : null, cost, ms };
  }
  // lease.changed {holder, previous, took?}: holder null when the keyboard was given back.
  if (e.type === "lease.changed") return { ...r, lease: p.holder == null ? null : s(p.holder) };
  return r;
}

/** The reply as one string, messages in the order they began. */
export const replyText = r => r.order.map(id => r.text[id]).filter(Boolean).join("\n\n");
