// @ts-check
// The session view: loads a thread's recent events, then follows thread.* over SSE (api.js's
// shared EventSource), and renders them the way the terminal would have shown them — a turn's
// text growing as deltas arrive, a tool call as a chip that expands to its input/output, a file
// edit as a diff, an ask or a held Gate item inline and editable, a memory fact in gold next to
// the turn it came from.
//
// A Claude Code session the Switchboard never ran (the user's own, in a terminal) has no record
// for threads.get, only its transcript: it is read from recall.thread and followed through
// session.indexed, which Recall emits when that session's turn completes. Once a send adopts it
// (threads.send resumes it headless), thread.* events arrive for it and the view follows those
// instead, so no turn shows twice.
//
// The timeline is its own scroll container. It follows the bottom while a reply streams as long as
// the reader was at the bottom (a scroll listener keeps that one flag); scrolled up to read, new
// content leaves the reading place alone and shows a "Jump to latest" pill instead.
//
// Nothing here uses innerHTML: text is untrusted (it is the model's own output, or another
// person's), so it goes through lib/markdown.js, which never parses it as markup, or through
// document.createTextNode directly.

import { h, put, add, empty } from "../js/dom.js";
import { attempt, on } from "../js/api.js";
import { icon } from "../js/icons.js";
import { clock } from "../js/fmt.js";
import { healthDot } from "../js/health.js";
import { renderMarkdown } from "./lib/markdown.js";
import { gateCard } from "./gate-item.js";
import { askCard } from "./ask-item.js";
import { mountComposer } from "./composer.js";

/** The Deck's own surface names: a lease or a message from these is this screen's, so it reads "you". */
const OURS = new Set(["deck", "chat"]);
/** A long session opens at its last WINDOW turns; "Show earlier" reads the rest. */
const WINDOW = 60;

/**
 * @param {HTMLElement} container
 * @param {{ thread: string, project: string|null, recorded?: boolean, known?: boolean, turns?: number, onBack: () => void }} opts
 * recorded: the list already knows the Switchboard has no record of it, so skip threads.get.
 * turns: how many turns the list says it has, so a long session opens at its last WINDOW turns.
 * known: the list had a row for it; when it had none, the transcript is read at the same time.
 * @returns {() => void} cleanup
 */
export function mountSession(container, opts) {
  const { thread } = opts;
  /** @type {Map<string, HTMLElement>} keyed by message id, tool id, gate id or ask id */
  const rows = new Map();
  /** @type {string[]} tool row keys, oldest first — only the last 6 stay in the timeline (Capsule shape) */
  const toolKeys = [];
  /** @type {Map<number, HTMLElement>} turn number (1-indexed, counted on thread.finished) -> the
   * timeline element to insert that turn's memory facts after (intelligence's `refs[].seq`) */
  const turnMarkers = new Map();
  /** @type {Set<string>} memory fact ids already rendered, so a memory.curated refetch only adds new ones */
  const shownFacts = new Set();
  let turnSeq = 0;
  let lastMessageEl = null, lastMessageId = null;
  const timeline = h("div", { class: "thread-view" });
  /** Whether the reader is at the bottom, so new content should keep it in view. */
  let following = true;
  const jump = h("button", { class: "jump-latest", type: "button", hidden: true, onclick: () => toBottom() }, icon("chevron", 12), "Jump to latest");
  timeline.addEventListener("scroll", () => {
    following = timeline.scrollTop + timeline.clientHeight >= timeline.scrollHeight - 40;
    if (following) jump.hidden = true;
  }, { passive: true });
  const head = h("div", { class: "session-head" });
  const leaseBar = h("div", { class: "lease-bar" });
  const record = { current: /** @type {any} */ (null) };
  /** A recorded session: the transcript's next turn to read, while no thread.* event has come. */
  const recorded = { on: false, next: 0, session: /** @type {any} */ (null), busy: false, again: false };
  // How the box reaches this device, as a dot in the header (asked on open, then once a minute while shown).
  const health = healthDot();

  const composer = mountComposer({ thread, agents: [], threads: [], holder: null, surface: "chat" });

  put(container, head, h("div", { class: "thread-wrap" }, timeline, jump), leaseBar, composer.el);
  timeline.replaceChildren(h("div", { class: "empty" }, "Loading…"));

  async function boot() {
    // Not known to be the Switchboard's or not: ask both at once, and use the transcript only when
    // the Switchboard has no record. One round trip instead of two from a phone.
    let from = opts.recorded && (opts.turns || 0) > WINDOW ? opts.turns - WINDOW : 0;
    const readT = () => attempt("recall.thread", { session: thread, from, limit: 400 });
    const pre = opts.recorded || !opts.known ? readT() : null;
    const r = opts.recorded ? { error: null } : await attempt("threads.get", { thread, since: 0, limit: 500 });
    if (opts.recorded || r.error) {
      let t = await (pre || readT());
      // The list's count and the transcript's numbering disagree: read it from the start.
      if (!t.error && from > 0 && !t.data.turns.length) { t = await attempt("recall.thread", { session: thread, limit: 400 }); from = 0; }
      if (t.error) { timeline.replaceChildren(empty("Could not open this session.", t.error.missing ? t.error : r.error)); drawHead(); return; }
      recorded.on = true;
      recorded.session = t.data.session;
      drawHead();
      timeline.replaceChildren();
      if (from > 0) timeline.append(earlier(from));
      if (!t.data.turns.length) timeline.append(h("div", { class: "empty th-wait" }, "Nothing was said in this session yet."));
      appendTurns(t.data.turns);
      toBottom();
      return;
    }
    record.current = r.data.thread;
    drawHead();
    timeline.replaceChildren();
    for (const e of r.data.events) applyEvent(e, false);
    for (const a of r.data.asks) upsertRow("ask:" + a.id, () => askCard({ ...a, agent: record.current?.agent }));
    toBottom();
    fetchMemory();
  }

  function drawHead() {
    const rec = record.current;
    const ses = recorded.on ? recorded.session : null;
    put(head,
      h("button", { class: "ibtn session-back", "aria-label": "Back", onclick: opts.onBack }, icon("left", 16)),
      h("div", { style: { display: "flex", flexDirection: "column", gap: "2px", flexGrow: "1", minWidth: "0" } },
        h("div", { class: "title ellipsis" }, rec?.name || ses?.name || ses?.title || thread.slice(0, 12)),
        h("div", { class: "sub ellipsis", title: rec?.cwd || ses?.cwd || null }, [rec?.agent, shortDir(rec?.cwd || ses?.cwd)].filter(Boolean).join(" · ") || "Claude Code session"),
      ),
      rec?.status === "running" ? h("span", { class: "dot signal", title: "running" }) : null,
      health.el,
    );
    put(leaseBar,
      icon("lock", 12),
      rec?.holder && OURS.has(rec.holder) ? h("span", null, "You have the keyboard here")
        : rec?.holder ? h("span", null, h("span", { class: "who" }, rec.holder), " has the keyboard")
        : ses ? h("span", { class: "lease-note" }, "Sending resumes this session here.")
        : h("span", null, "No one is typing"),
      rec?.holder && !OURS.has(rec.holder) ? h("button", { class: "btn btn-ghost btn-sm", onclick: take }, "Take") : null,
    );
  }

  /** "Show earlier": the turns before `upto`, read and put above what is on screen. */
  function earlier(/** @type {number} */ upto) {
    const btn = h("button", { type: "button", class: "btn btn-ghost btn-sm th-earlier" }, "Show earlier");
    btn.addEventListener("click", async () => {
      btn.setAttribute("disabled", "");
      const start = Math.max(0, upto - WINDOW * 2);
      const t = await attempt("recall.thread", { session: thread, from: start, limit: upto - start });
      if (t.error) { btn.removeAttribute("disabled"); return; }
      const holder = document.createDocumentFragment();
      const keep = timeline.scrollHeight - timeline.scrollTop;
      const saveNext = recorded.next, saveDay = lastDay;
      const sink = { append: (/** @type {Node} */ n) => holder.append(n) };
      lastDay = null;
      appendTurns(t.data.turns, sink);
      recorded.next = saveNext; lastDay = saveDay;
      btn.replaceWith(...(start > 0 ? [earlier(start)] : []), holder);
      timeline.scrollTop = timeline.scrollHeight - keep;
    });
    return btn;
  }

  /** A transcript's turns, in the same shapes the live events draw. */
  function appendTurns(turns, /** @type {{ append: (n: Node) => void }} */ into = timeline) {
    for (const t of turns) {
      recorded.next = Math.max(recorded.next, (t.seq ?? 0) + 1);
      if (!t.text) continue;
      maybeDayRule(t.ts || Date.now(), into);
      if (t.role === "user") { into.append(personMsg("you", t.text, t.ts)); continue; }
      const el = agentMsg("claude", t.ts);
      add(/** @type {any} */ (el).querySelector(".msg-text"), renderMarkdown(t.text));
      into.append(el);
    }
  }
  /** Recall indexed this session again: read what is new. One read at a time; a second ask during one reads again after. */
  async function readMore() {
    if (!recorded.on) return;
    if (recorded.busy) { recorded.again = true; return; }
    recorded.busy = true;
    try {
      do {
        recorded.again = false;
        const r = await attempt("recall.thread", { session: thread, from: recorded.next, limit: 400 });
        if (!recorded.on || r.error) break;
        if (r.data.turns.length) timeline.querySelector(".th-wait")?.remove();
        if (r.data.session) { recorded.session = r.data.session; drawHead(); }
        appendTurns(r.data.turns);
        if (r.data.turns.length) grew();
      } while (recorded.again);
    } finally { recorded.busy = false; }
  }
  async function take() { await attempt("threads.lease", { thread }); }

  function toBottom() { timeline.scrollTop = timeline.scrollHeight; following = true; jump.hidden = true; }
  /** New content landed: keep following it, or say it is there without moving the reader. */
  function grew() { if (following) toBottom(); else jump.hidden = false; }

  function dayLabel(at) {
    const d = new Date(at);
    const t = new Date(); t.setHours(0, 0, 0, 0);
    if (at >= t.getTime()) return "Today";
    const y = new Date(t); y.setDate(y.getDate() - 1);
    if (at >= y.getTime()) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  }
  let lastDay = null;
  function maybeDayRule(at, /** @type {{ append: (n: Node) => void }} */ into = timeline) {
    const d = dayLabel(at);
    if (d === lastDay) return;
    lastDay = d;
    into.append(h("div", { class: "day-rule" }, h("span", { class: "line" }), h("span", { class: "lbl" }, d), h("span", { class: "line" })));
  }

  function upsertRow(key, build) {
    let el = rows.get(key);
    if (!el) { el = build(); rows.set(key, el); timeline.append(el); }
    return el;
  }

  function applyEvent(e, live) {
    const p = e.payload || {};
    // A message queued for a session busy in the terminal (capsule-now): the terminal session stays
    // the user's own, and its transcript (read on session.indexed) already shows the message and
    // the reply. So while it is read from the transcript, the queue's events are not drawn twice.
    const queueFlow = e.type === "thread.queued" || p.queued != null || p.via === "stop" || p.via === "prompt" || p.via === "terminal"
      || (typeof p.message === "string" && p.message.startsWith("inbox-"));
    if (recorded.on && queueFlow) return;
    // The first live event for a recorded session: a send adopted it, so the Switchboard has it now.
    if (live && recorded.on && /^(thread|lease)\./.test(e.type)) {
      recorded.on = false;
      attempt("threads.get", { thread, since: 0, limit: 1 }).then(r => { if (r.data) { record.current = r.data.thread; drawHead(); } });
    }
    if (e.type === "thread.started") return;
    if (e.type === "thread.sent") {
      maybeDayRule(e.at);
      timeline.append(personMsg(!p.surface || OURS.has(p.surface) ? "you" : p.surface, p.text, e.at));
      lastMessageEl = null; lastMessageId = null;
      return;
    }
    if (e.type === "thread.text") {
      maybeDayRule(e.at);
      if (p.notice) { timeline.append(noticeMsg(p.text, e.at)); return; }
      if (p.message !== lastMessageId) {
        lastMessageId = p.message;
        lastMessageEl = agentMsg(record.current?.agent || "claude", e.at);
        timeline.append(lastMessageEl);
      }
      const body = /** @type {any} */ (lastMessageEl).querySelector(".msg-text");
      const cursor = body.querySelector(".msg-cursor");
      if (cursor) cursor.remove();
      if (p.delta) body.append(document.createTextNode(p.delta), h("span", { class: "msg-cursor" }));
      if (p.done && p.text) { body.replaceChildren(); add(body, renderMarkdown(p.text)); }
      return;
    }
    if (e.type === "thread.tool") {
      if (p.phase === "started") {
        const key = "tool:" + p.id;
        upsertRow(key, () => toolChip(p));
        toolKeys.push(key);
        while (toolKeys.length > 6) { const old = toolKeys.shift(); rows.get(old)?.remove(); rows.delete(old); }
      } else {
        const el = rows.get("tool:" + p.id); if (el && el.setDone) el.setDone(p.error);
      }
      return;
    }
    if (e.type === "thread.finished") {
      const cur = lastMessageEl && lastMessageEl.querySelector(".msg-cursor");
      if (cur) cur.remove();
      if (!p.ok || p.error) timeline.append(h("div", { class: "turn-foot" }, h("span", { class: "err" }, "turn failed: " + (p.error || p.stop_reason || "error"))));
      // intelligence's memory.facts refs a turn by its 1-indexed number (record.current.turns
      // counts the same way); mark where this turn ended so a fact for it lands right after.
      turnSeq++;
      turnMarkers.set(turnSeq, timeline.lastElementChild);
      return;
    }
    if (e.type === "thread.stopped") { timeline.append(h("div", { class: "turn-foot" }, icon("terminal", 12), "session stopped" + (p.reason ? ": " + p.reason : ""))); return; }
    if (e.type === "ask.raised") { upsertRow("ask:" + p.ask, () => askCard({ id: p.ask, tool: p.tool, summary: p.summary, destination: p.destination, reason: p.reason, agent: record.current?.agent })); return; }
    // Answered here or on another screen: the card says what was decided rather than vanishing.
    if (e.type === "ask.answered") { const el = /** @type {any} */ (rows.get("ask:" + p.ask)); if (el?.answered) el.answered(p.decision); else if (el) el.remove(); return; }
    if (e.type === "gate.held" || e.type === "gate.revised") { upsertRow("gate:" + p.id, () => gateCard({ id: p.id })); const el = rows.get("gate:" + p.id); if (el && el.refresh && live) el.refresh(); return; }
    if (e.type === "gate.released" || e.type === "gate.rejected") { const el = rows.get("gate:" + p.id); if (el && el.refresh) el.refresh(); return; }
    if (e.type === "lease.changed") { drawHead(); return; }
  }

  function personMsg(who, text, at) {
    return h("div", { class: "msg" },
      h("span", { class: "av-person msg-av" }, String(who).slice(0, 2).toUpperCase()),
      h("div", { class: "msg-body" }, h("div", { class: "msg-head" }, h("span", { class: "msg-who" }, who), h("span", { class: "msg-when" }, clock(at))),
        h("div", { class: "msg-text" }, text)),
    );
  }
  function agentMsg(who, at) {
    return h("div", { class: "msg" },
      h("span", { class: "av-agent msg-av" }, String(who).slice(0, 2).toLowerCase()),
      h("div", { class: "msg-body" }, h("div", { class: "msg-head" }, h("span", { class: "msg-who" }, who), h("span", { class: "msg-when" }, clock(at))),
        h("div", { class: "msg-text" })),
    );
  }
  function noticeMsg(text, at) {
    return h("div", { class: "gate-note", style: { padding: "6px 0" } }, icon("clock", 12), " ", text, " ", h("span", { class: "msg-when" }, clock(at)));
  }
  // One line per call, mono 11: "running · <summary>" / "done · <summary>" / "failed · <summary>"
  // (failed in Beacon), indented 44px to line up under the reply text (Capsule shape).
  function toolChip(p) {
    let expanded = false;
    const word = h("span", { class: "tool-status" }, "running");
    const line = h("button", { class: "tool-line", type: "button", "aria-expanded": "false", onclick: () => { expanded = !expanded; toggle(); } },
      word, h("span", null, " · "), h("span", { class: "sum ellipsis" }, p.summary || p.tool),
    );
    const detail = h("div", { class: "tool-detail", hidden: true }, h("div", { class: "lbl" }, p.tool), h("div", { class: "code" }, p.summary || ""), p.destination ? h("div", { class: "code" }, "→ " + p.destination) : null);
    const wrap = h("div", { class: "tool-row" }, line);
    function toggle() { line.setAttribute("aria-expanded", String(expanded)); if (expanded && !wrap.contains(detail)) wrap.append(detail); detail.hidden = !expanded; }
    /** @type {any} */ (wrap).setDone = err => { put(word, err ? "failed" : "done"); word.classList.toggle("err", !!err); };
    return wrap;
  }

  // A gold fact, intelligence's real shape (memory.facts): {id, text, subject, rel, object,
  // confidence, age, stale, source, refs: [{seq}], taught?: [{module, kind}]}. Source meta
  // matches the Capsule's: "<age> · <confidence>%" in mono 11 Ash after the name (confidence is
  // 0 to 1, capsule confirmed, same as memory.relevant). Lessons are a different system and are
  // never rendered gold; only what memory.facts returns is.
  function factCard(f) {
    const bits = [];
    if (f.age) bits.push(String(f.age));
    if (f.confidence != null) bits.push(Math.round(f.confidence > 1 ? f.confidence : f.confidence * 100) + "%");
    return h("div", { class: "memory-fact" + (f.stale ? " stale" : "") },
      h("h3", { class: "lbl" }, "From memory"),
      h("div", { class: "fact" }, f.text || [f.subject, f.rel, f.object].filter(Boolean).join(" ")),
      f.source ? h("div", { class: "sources" },
        h("span", { class: "source" }, icon("file", 12), h("span", null, typeof f.source === "string" ? f.source : (f.source.name || f.source.title || "")),
          bits.length ? h("span", { class: "source-meta" }, bits.join(" · ")) : null)) : null,
    );
  }

  /** Where in the timeline a fact belongs: right after the latest turn its refs mention. Accepts
   * either shape seen so far: `refs: [{seq}]` (intelligence's message) or a single `ref: {seq}`
   * (deck/fixtures/memory.json, the tool's existing about-scoped shape). */
  function insertFact(f) {
    const refs = f.refs || (f.ref ? [f.ref] : []);
    const maxSeq = refs.reduce((m, r) => Math.max(m, r.seq || 0), 0);
    const marker = maxSeq ? turnMarkers.get(maxSeq) : null;
    const el = factCard(f);
    if (marker && marker.parentNode === timeline) marker.after(el); else timeline.append(el);
  }

  async function fetchMemory() {
    const r = await attempt("memory.facts", { thread, ...(record.current?.project ? { room: record.current.project } : {}), limit: 50 });
    if (r.error || !r.data || !r.data.facts) return;
    const n = timeline.scrollHeight;
    for (const f of r.data.facts) {
      if (shownFacts.has(f.id)) continue;
      shownFacts.add(f.id);
      insertFact(f);
    }
    if (timeline.scrollHeight !== n) grew();
  }

  boot();

  /** A live event for this thread. What it adds follows the bottom or shows the pill; a message
   * typed into the session (here or elsewhere) brings the reader down to it. */
  const onLive = e => { if (e.thread !== thread) return; const n = timeline.scrollHeight; applyEvent(e, true);
    if (e.type === "thread.sent") toBottom(); else if (timeline.scrollHeight !== n) grew(); };
  const offs = [
    on("thread.*", onLive),
    on("ask.raised", onLive),
    on("ask.answered", onLive),
    on("gate.held", onLive),
    on("gate.revised", onLive),
    on("gate.released", onLive),
    on("gate.rejected", onLive),
    on("lease.changed", e => { if (e.thread === thread) applyEvent(e, true); }),
    // memory.curated {nodes, edges, ms, updated} carries no thread (intelligence): it only says
    // the graph changed, so refetch this open thread and let fetchMemory's id-dedup filter it.
    on("memory.curated", () => fetchMemory()),
    on("session.indexed", e => { if ((e.thread || e.payload?.session) === thread) readMore(); }),
  ];
  return () => { health.stop(); for (const off of offs) off(); composer.stop(); };
}

/** The last two folders of a path, which is what tells sessions apart: …/alex/Work. */
function shortDir(d) {
  if (!d) return "";
  const parts = String(d).split("/").filter(Boolean);
  return (parts.length > 2 ? "…/" : "/") + parts.slice(-2).join("/");
}
