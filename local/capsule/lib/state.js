// @ts-check
// state — what is waiting on the user, and what a thread is saying, folded from vyred's events.
//
// Two kinds of thing wait: a Gate hold (a draft or a send that needs a yes, spec 7.7) and a
// permission question from a running session (ask.raised, spec 7.8). The Capsule shows both in
// one Beacon list, oldest first, because whoever has waited longest should be answered first.
// Only an explicit question asks for attention (floor rule 6).
//
// A third kind waits quietly: a lesson Vyre proposes (lesson.proposed, core/learn). It sits in
// the same list for the user to accept or decline, marked quiet, and never raises attention on
// its own: it does not count toward the Beacon dot or the tray badge (loud() counts what does).
//
// Pure: events in, plain objects out. The main process owns the one copy and sends it to the
// window, so a hidden window that wakes up is shown the truth rather than what it last saw.

/**
 * @typedef {{ source: "gate"|"ask"|"lesson", id: string, title: string, sub: string, at: number, thread?: string|null,
 *   project?: string|null, to?: string, via?: string|null, kind?: string, why?: string|null, rule?: string|null,
 *   tool?: string|null, scope?: any, quiet?: boolean }} Waiting
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

/** How a lesson's scope reads: "all", {project} or {agent}. */
function scopeWords(scope, name) {
  if (scope == null || scope === "") return null;
  if (scope === "all") return "everywhere";
  if (typeof scope === "string") return scope;
  if (scope.project) return `in ${name(s(scope.project))}`;
  if (scope.agent) return `for ${s(scope.agent)}`;
  return null;
}

/** Where a lesson came from, in words: its source's kind ({kind, session, ...}) or a string. */
function sourceWords(source) {
  if (source == null || source === "") return null;
  const kind = typeof source === "string" ? source : source.kind;
  if (kind === "prompt") return "from what you said";
  if (kind === "edited") return "from a draft you edited";
  if (kind === "remember" || kind === "user") return "you wrote it";
  return kind ? s(kind) : null;
}

/**
 * A proposed lesson as a row, from learn.lessons ({id, rule, scope, source, created}) or from a
 * lesson.proposed payload ({lesson, rule, checked, scope, source}, with the event's `at`). Quiet:
 * it waits in the list and never asks for attention.
 */
export function fromLesson(l, name = slug => slug) {
  const id = s(l.lesson ?? l.id);
  const rule = s(l.rule);
  return /** @type {Waiting} */ ({
    source: "lesson", id, at: Number(l.at || l.created || Date.now()),
    title: `Vyre proposes: "${rule}"`,
    sub: [scopeWords(l.scope, name), sourceWords(l.source)].filter(Boolean).join(" · "),
    thread: (l.source && typeof l.source === "object" && l.source.session) || null, project: (l.scope && l.scope.project) || null,
    rule, scope: l.scope ?? null, where: scopeWords(l.scope, name) || null, from: sourceWords(l.source) || null, quiet: true, why: null, tool: null,
  });
}

/** How many waiting items ask for attention: the quiet ones (proposed lessons) do not. */
export const loud = list => list.filter(w => !w.quiet).length;

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
  if (e.type === "lesson.proposed") return waiting([...list, fromLesson({ ...p, at: e.at }, name)]);
  if (e.type === "lesson.learned" || e.type === "lesson.retired") return drop(list, "lesson", p.lesson ?? p.id);
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
 * A notice from vyred itself (the switch to the API key, a usage limit) is `{message: "vyre", text,
 * done, notice}`. It is Vyre talking, not the model: it is kept as `notice`, the newest one, for a
 * faint status line, and never joins the answer's text.
 *
 * `cost` is what thread.finished reported (Claude Code's total_cost_usd, summed over the turns of
 * this reply), `ms` how long the last turn took. The switchboard reports no token counts.
 * `cancelled` is the user's Stop: nothing that arrives after it changes the reply.
 * @typedef {{ thread: string, order: string[], text: Record<string, string>, tools: { id: string, summary: string, done: boolean, error: boolean }[],
 *   finished: boolean, ok: boolean|null, error: string|null, lease: string|null, cost: number|null, ms: number|null,
 *   cancelled?: boolean, notice?: string|null, queued?: { name: string, delivered: boolean }|null, model?: string|null, memory?: { answer: string|null, sources: any[], confidence?: number|null, answerAge?: string|null }|null }} Reply
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
  if (e.type === "thread.text" && p.notice) return { ...r, notice: s(p.text) };
  // Words queued for a session busy in a terminal reached it (the Harness handed them over).
  if (e.type === "thread.sent" && p.queued != null && r.queued) return { ...r, queued: { ...r.queued, delivered: true } };
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

// ------------------------------------------------------------ direct messages
// `@juno` (the assistant) and `@<agent>` read as a conversation: the agent's current thread, its
// history and the reply streaming in, in one list. It is folded from the same thread events as a
// reply, so a DM opened mid-answer and one that watched the answer start end up identical.
//
// A message is a turn, not a Claude Code message: what the user sent (thread.sent, from any
// surface), then everything the agent said and did until thread.finished, text blocks joined the
// way replyText joins them, and its tool calls as one line each.

/**
 * @typedef {{ id: string, summary: string, done: boolean, error: boolean }} DmTool
 * @typedef {{ id: string, role: "user"|"agent", text: string, at: number, surface?: string, pending?: boolean,
 *   tools?: DmTool[], done?: boolean, error?: string|null, parts?: { order: string[], text: Record<string, string> } }} DmMessage
 * @typedef {{ agent: string, thread: string|null, messages: DmMessage[], asks: Waiting[], busy: boolean, holder: string|null,
 *   last: number, limit: number, loading?: boolean, notice?: string|null }} Dm
 */

/** Tool lines kept per turn: the newest, since a long turn can run hundreds. */
export const DM_TOOLS = 10;

/** An empty DM with an agent. `last` is the newest event folded in, so nothing is folded twice. @returns {Dm} */
export function dm(agent, thread = null, limit = 30) {
  return { agent: s(agent), thread: thread ? s(thread) : null, messages: [], asks: [], busy: false, holder: null, last: 0, limit: Math.max(1, Number(limit) || 30) };
}

/** What thread.sent carries of the user's words: the switchboard's cut(text, 2000). */
export const sentText = t => {
  const x = s(t).replace(/\s+/g, " ").trim();
  return x.length > 2000 ? x.slice(0, 1999) + "…" : x;
};

/** The words the user just sent from this Capsule, shown at once and marked pending. @param {Dm} d @returns {Dm} */
export function dmPending(d, key, text, at) {
  return { ...d, busy: true, messages: [...d.messages, { id: s(key), role: "user", text: s(text), at: Number(at) || Date.now(), pending: true }] };
}

/** A send that failed: its pending message goes. @param {Dm} d @returns {Dm} */
export function dmDrop(d, key) {
  const messages = d.messages.filter(m => !(m.pending && m.id === s(key)));
  if (messages.length === d.messages.length) return d;
  const open = messages.some(m => m.pending) || messages.some(m => m.role === "agent" && !m.done);
  return { ...d, messages, busy: open && d.busy };
}

/** The agent's turn still being written, found from the end past the user's pending words. */
function openTurn(msgs, message) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === "user" && m.pending) continue;
    if (m.role === "agent" && (!m.done || (message && m.parts && m.parts.order.includes(message)))) return i;
    return -1;
  }
  return -1;
}

/** Put a new agent turn before any pending words (those are answered after it). */
function insertTurn(msgs, m) {
  let at = msgs.length;
  while (at > 0 && msgs[at - 1].role === "user" && msgs[at - 1].pending) at--;
  return [...msgs.slice(0, at), m, ...msgs.slice(at)];
}

const newTurn = (e, id) => /** @type {DmMessage} */ ({ id: s(id), role: "agent", text: "", at: Number(e.at) || Date.now(), tools: [], done: false, error: null, parts: { order: [], text: {} } });
const joined = parts => parts.order.map(id => parts.text[id]).filter(Boolean).join("\n\n");
const put = (msgs, i, m) => msgs.map((x, j) => (j === i ? m : x));

/**
 * Fold one event into a DM. Returns the same object when nothing changed. `name` turns a project
 * slug into its name, for the ask rows. Events of other threads change nothing, except the start
 * of this agent's new thread, which the DM follows from then on.
 * @param {Dm|null} d @param {any} e @param {(slug: string) => string} [name] @returns {Dm|null}
 */
export function applyDm(d, e, name = slug => slug) {
  if (!d || !e) return d;
  const p = e.payload || {};
  const thread = e.thread ? s(e.thread) : null;
  if (typeof e.id === "number" && e.id <= d.last) return d;
  // The agent's thread is started by the first words sent to it (agents.ask), or replaced.
  if (e.type === "thread.started" && thread && p.agent === d.agent && thread !== d.thread && !p.resumed) d = { ...d, thread, holder: null };
  // The words this Capsule sent, before agents.ask has said which thread took them.
  if (!d.thread && e.type === "thread.sent" && thread && p.surface === "capsule" && d.messages.some(m => m.pending && sentText(m.text) === s(p.text))) d = { ...d, thread };
  if (!thread || thread !== d.thread) return d;
  const last = typeof e.id === "number" ? e.id : d.last;
  const msgs = d.messages;

  if (e.type === "thread.sent") {
    const surface = p.surface ? s(p.surface) : null;
    let i = -1;
    if (surface === "capsule") {
      i = msgs.findIndex(m => m.pending && sentText(m.text) === s(p.text));
      if (i < 0) i = msgs.findIndex(m => m.pending);
    }
    const m = /** @type {DmMessage} */ ({ id: `e${e.id ?? last}`, role: "user", text: i >= 0 ? msgs[i].text : s(p.text), at: Number(e.at) || (i >= 0 ? msgs[i].at : Date.now()),
      ...(surface && surface !== "capsule" ? { surface } : {}) });
    // A turn left open by a thread that never said finished (vyred restarted) is over now.
    const closed = msgs.map(x => (x.role === "agent" && !x.done ? { ...x, done: true } : x));
    return trim({ ...d, last, busy: true, messages: i >= 0 ? put(closed, i, m) : insertTurn(closed, m) });
  }
  // Vyre's own words (a usage limit): a status line under the conversation, never a message in it.
  if (e.type === "thread.text" && p.notice) return { ...d, last, notice: s(p.text) };
  if (e.type === "thread.text") {
    const id = s(p.message || "m");
    let i = openTurn(msgs, id);
    let list = msgs;
    if (i < 0) { list = insertTurn(msgs, newTurn(e, id)); i = openTurn(list, id); }
    const t = /** @type {DmMessage} */ (list[i]);
    const parts = /** @type {{ order: string[], text: Record<string,string> }} */ (t.parts);
    const order = parts.order.includes(id) ? parts.order : [...parts.order, id];
    const text = { ...parts.text, [id]: p.done ? s(p.text) : (parts.text[id] || "") + s(p.delta) };
    const next = { ...t, parts: { order, text }, text: joined({ order, text }), done: false };
    return trim({ ...d, last, busy: true, messages: put(list, i, next) });
  }
  if (e.type === "thread.tool") {
    let i = openTurn(msgs, null);
    let list = msgs;
    if (p.phase === "done") {
      if (i < 0) return { ...d, last };
      const t = list[i];
      return { ...d, last, messages: put(list, i, { ...t, tools: (t.tools || []).map(x => (x.id === s(p.id) ? { ...x, done: true, error: Boolean(p.error) } : x)) }) };
    }
    if (i < 0) { list = insertTurn(msgs, newTurn(e, `t${e.id ?? last}`)); i = openTurn(list, null); }
    const t = list[i];
    const tools = [...(t.tools || []), { id: s(p.id), summary: s(p.summary || p.tool || "a tool"), done: false, error: false }].slice(-DM_TOOLS);
    return trim({ ...d, last, busy: true, messages: put(list, i, { ...t, tools }) });
  }
  if (e.type === "thread.finished" || e.type === "thread.stopped") {
    const error = e.type === "thread.stopped" ? (d.busy ? `the thread stopped${p.reason ? ": " + s(p.reason) : ""}` : null)
      : p.ok === false ? s(p.error || "the turn failed") : null;
    const i = openTurn(msgs, null);
    let list = msgs;
    if (i >= 0) list = put(msgs, i, { ...msgs[i], done: true, error });
    else if (error) list = insertTurn(msgs, { ...newTurn(e, `f${e.id ?? last}`), done: true, error });
    return trim({ ...d, last, busy: list.some(m => m.pending), messages: list });
  }
  if (e.type === "ask.raised" || e.type === "ask.answered") {
    // Whoever else asks in this thread, it is this agent's question.
    const asks = applyWaiting(d.asks, e.type === "ask.raised" && !p.agent ? { ...e, payload: { ...p, agent: d.agent } } : e, name);
    return { ...d, last, asks };
  }
  if (e.type === "lease.changed") return { ...d, last, holder: p.holder == null ? null : s(p.holder) };
  return last === d.last ? d : { ...d, last };
}

/** The newest `limit` messages; pending words are never cut. @param {Dm} d @returns {Dm} */
function trim(d) {
  if (d.messages.length <= d.limit) return d;
  const keep = d.messages.slice(-d.limit);
  const lost = d.messages.slice(0, -d.limit).filter(m => m.pending);
  return { ...d, messages: [...lost, ...keep] };
}

/**
 * A DM from threads.get: `{thread: record, asks: open rows, events}`. Events come without their
 * thread (it is the one asked for), so it is put back. Open asks come from the table, which is
 * what is open now; ask events in the history would only replay what was already answered.
 * @param {Dm} d @param {any} got @param {(row: any) => Waiting} askRow @param {(slug: string) => string} [name] @returns {Dm}
 */
export function dmHistory(d, got, askRow, name = slug => slug) {
  const rec = (got && got.thread) || {};
  const id = s(rec.id || d.thread);
  let x = { ...d, thread: id, holder: rec.holder || null };
  for (const ev of (got && got.events) || []) {
    if (ev.type === "ask.raised" || ev.type === "ask.answered") { x = { ...x, last: Math.max(x.last, Number(ev.id) || 0) }; continue; }
    x = /** @type {Dm} */ (applyDm(x, { ...ev, thread: id, project: rec.project || null }, name));
  }
  const busy = ["working", "waiting"].includes(String(rec.status));
  // A turn with no end in the log, on a thread that is not working, ended without saying so.
  const messages = busy ? x.messages : x.messages.map(m => (m.role === "agent" && !m.done ? { ...m, done: true } : m));
  return { ...x, messages, busy, asks: waiting(((got && got.asks) || []).filter(a => !a.decision && (!a.state || a.state === "open")).map(askRow)) };
}

/**
 * Words sent from this Capsule while the history loaded. One the history already holds (its
 * thread.sent came after `after`, the event the stream had reached on open) is that message.
 * @param {Dm} d @param {DmMessage[]} pending @param {number} after @returns {Dm}
 */
export function dmCarry(d, pending, after) {
  let x = d;
  const taken = new Set();
  for (const m of pending) {
    const i = x.messages.findIndex(y => y.role === "user" && !y.pending && !y.surface && !taken.has(y.id) && Number(y.id.slice(1)) > after && sentText(m.text) === y.text);
    if (i >= 0) { taken.add(x.messages[i].id); x = { ...x, messages: put(x.messages, i, { ...x.messages[i], text: m.text }) }; }
    else x = dmPending(x, m.id, m.text, m.at);
  }
  return x;
}

/** What the page is handed: no bookkeeping. @param {Dm} d */
export function dmView(d) {
  return {
    agent: d.agent, thread: d.thread, busy: d.busy, holder: d.holder, asks: d.asks, ...(d.loading ? { loading: true } : {}), notice: d.notice || null,
    messages: d.messages.map(({ parts, ...m }) => m),
  };
}
