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
// A session from the paired Mac (on the box, a row with source "mac") is read, never acted on: it
// opens from recall.thread (the box asks the Mac for it), and in place of the composer, the
// keyboard and Take it says which machine to continue it on. A session the list did not know is
// found to be the Mac's from recall.thread's own answer. Nothing here uses innerHTML: text is untrusted (it is the model's own
// output, or another person's), so it goes through lib/markdown.js, which never parses it as
// markup, or through document.createTextNode directly.

import { h, put, add, empty } from "../js/dom.js";
import { attempt, on } from "../js/api.js";
import { icon } from "../js/icons.js";
import { clock } from "../js/fmt.js";
import { renderMarkdown } from "./lib/markdown.js";
import { gateCard } from "./gate-item.js";
import { askCard } from "./ask-item.js";
import { mountComposer } from "./composer.js";
import { isMac, machineChip, readOnlyNote } from "../js/machine.js";

/**
 * @param {HTMLElement} container
 * @param {{ thread: string, project: string|null, recorded?: boolean, source?: string|null, machine?: string|null, onBack: () => void }} opts
 * recorded: the list already knows the Switchboard has no record of it, so skip threads.get.
 * source, machine: the list's label for it; "mac" opens it read-only.
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
  const head = h("div", { class: "session-head" });
  const leaseBar = h("div", { class: "lease-bar" });
  const record = { current: /** @type {any} */ (null) };
  /** A recorded session: the transcript's next turn to read, while no thread.* event has come. */
  const recorded = { on: false, next: 0, session: /** @type {any} */ (null), busy: false, again: false };
  /** Where it lives when that is the Mac: then nothing here may send to it, lease it or take it. */
  const where = { source: opts.source || null, machine: opts.machine || null };

  const composer = mountComposer({ thread, agents: [], threads: [], holder: null, surface: "chat" });

  put(container, head, timeline, leaseBar, isMac(where) ? null : composer.el);
  timeline.replaceChildren(h("div", { class: "empty" }, "Loading…"));

  async function boot() {
    const skip = opts.recorded || isMac(where);
    const r = skip ? { error: null } : await attempt("threads.get", { thread, since: 0, limit: 500 });
    if (skip || r.error) {
      const t = await attempt("recall.thread", { session: thread, limit: 400, ...(isMac(where) ? { source: "mac" } : {}) });
      if (t.error) { timeline.replaceChildren(empty("Could not open this session.", t.error.missing ? t.error : r.error)); drawHead(); return; }
      recorded.on = true;
      recorded.session = t.data.session;
      if (isMac(t.data)) { where.source = "mac"; where.machine = t.data.machine || where.machine; readOnly(); }
      drawHead();
      timeline.replaceChildren();
      if (!t.data.turns.length) timeline.append(h("div", { class: "empty th-wait" }, "Nothing was said in this session yet."));
      appendTurns(t.data.turns);
      timeline.scrollTop = timeline.scrollHeight;
      return;
    }
    record.current = r.data.thread;
    drawHead();
    timeline.replaceChildren();
    for (const e of r.data.events) applyEvent(e, false);
    for (const a of r.data.asks) upsertRow("ask:" + a.id, () => askCard({ ...a, agent: record.current?.agent }));
    timeline.scrollTop = timeline.scrollHeight;
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
      machineChip(where),
      rec?.status === "running" ? h("span", { class: "dot signal", title: "running" }) : null,
    );
    if (isMac(where)) { put(leaseBar, icon("lock", 12), h("span", { class: "lease-note" }, readOnlyNote(where))); return; }
    put(leaseBar,
      icon("lock", 12),
      rec?.holder ? h("span", null, h("span", { class: "who" }, rec.holder), " has the keyboard")
        : ses ? h("span", { class: "lease-note" }, "Sending resumes this session here.")
        : h("span", null, "No one is typing"),
      rec?.holder && rec.holder !== "chat" ? h("button", { class: "btn btn-ghost btn-sm", onclick: take }, "Take") : null,
    );
  }

  /** A transcript's turns, in the same shapes the live events draw. */
  function appendTurns(turns) {
    for (const t of turns) {
      recorded.next = Math.max(recorded.next, (t.seq ?? 0) + 1);
      if (!t.text) continue;
      maybeDayRule(t.ts || Date.now());
      if (t.role === "user") { timeline.append(personMsg("you", t.text, t.ts)); continue; }
      const el = agentMsg("claude", t.ts);
      add(/** @type {any} */ (el).querySelector(".msg-text"), renderMarkdown(t.text));
      timeline.append(el);
    }
  }
  /** Recall indexed this session again: read what is new. One read at a time; a second ask during one reads again after. */
  async function readMore() {
    if (!recorded.on || isMac(where)) return;
    if (recorded.busy) { recorded.again = true; return; }
    recorded.busy = true;
    try {
      do {
        recorded.again = false;
        const r = await attempt("recall.thread", { session: thread, from: recorded.next, limit: 400 });
        if (!recorded.on || r.error) break;
        const stick = timeline.scrollTop + timeline.clientHeight >= timeline.scrollHeight - 40;
        if (r.data.turns.length) timeline.querySelector(".th-wait")?.remove();
        if (r.data.session) { recorded.session = r.data.session; drawHead(); }
        appendTurns(r.data.turns);
        if (stick) timeline.scrollTop = timeline.scrollHeight;
      } while (recorded.again);
    } finally { recorded.busy = false; }
  }
  async function take() { if (!isMac(where)) await attempt("threads.lease", { thread }); }
  /** A Mac session: no composer at all, so nothing typed here can reach threads.send or threads.lease. */
  function readOnly() { composer.el.remove(); }

  function dayLabel(at) {
    const d = new Date(at);
    const t = new Date(); t.setHours(0, 0, 0, 0);
    if (at >= t.getTime()) return "Today";
    const y = new Date(t); y.setDate(y.getDate() - 1);
    if (at >= y.getTime()) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  }
  let lastDay = null;
  function maybeDayRule(at) {
    const d = dayLabel(at);
    if (d === lastDay) return;
    lastDay = d;
    timeline.append(h("div", { class: "day-rule" }, h("span", { class: "line" }), h("span", { class: "lbl" }, d), h("span", { class: "line" })));
  }

  function upsertRow(key, build) {
    let el = rows.get(key);
    if (!el) { el = build(); rows.set(key, el); timeline.append(el); }
    return el;
  }

  function applyEvent(e, live) {
    const p = e.payload || {};
    // The first live event for a recorded session: a send adopted it, so the Switchboard has it now.
    if (live && recorded.on && /^(thread|lease)\./.test(e.type)) {
      recorded.on = false;
      attempt("threads.get", { thread, since: 0, limit: 1 }).then(r => { if (r.data) { record.current = r.data.thread; drawHead(); } });
    }
    if (e.type === "thread.started") return;
    if (e.type === "thread.sent") {
      maybeDayRule(e.at);
      timeline.append(personMsg(p.surface || "you", p.text, e.at));
      lastMessageEl = null; lastMessageId = null;
      return;
    }
    if (e.type === "thread.text") {
      maybeDayRule(e.at);
      if (p.notice) { timeline.append(noticeMsg(p.text, e.at)); return; }
      if (p.message !== lastMessageId) {
        lastMessageId = p.message;
        lastMessageEl = agentMsg(record.current?.agent || record.current?.name || "assistant", e.at);
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
    if (e.type === "ask.answered") { const el = rows.get("ask:" + p.ask); if (el) el.remove(); return; }
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
    for (const f of r.data.facts) {
      if (shownFacts.has(f.id)) continue;
      shownFacts.add(f.id);
      insertFact(f);
    }
  }

  boot();

  const offs = [
    on("thread.*", e => { if (e.thread === thread) { const stick = timeline.scrollTop + timeline.clientHeight >= timeline.scrollHeight - 40; applyEvent(e, true); if (stick) timeline.scrollTop = timeline.scrollHeight; } }),
    on("ask.raised", e => { if (e.thread === thread) applyEvent(e, true); }),
    on("ask.answered", e => { if (e.thread === thread) applyEvent(e, true); }),
    on("gate.held", e => { if (e.thread === thread) applyEvent(e, true); }),
    on("gate.revised", e => { if (e.thread === thread) applyEvent(e, true); }),
    on("gate.released", e => { if (e.thread === thread) applyEvent(e, true); }),
    on("gate.rejected", e => { if (e.thread === thread) applyEvent(e, true); }),
    on("lease.changed", e => { if (e.thread === thread) applyEvent(e, true); }),
    // memory.curated {nodes, edges, ms, updated} carries no thread (intelligence): it only says
    // the graph changed, so refetch this open thread and let fetchMemory's id-dedup filter it.
    on("memory.curated", () => fetchMemory()),
    on("session.indexed", e => { if ((e.thread || e.payload?.session) === thread) readMore(); }),
  ];
  return () => { for (const off of offs) off(); };
}

/** The last two folders of a path, which is what tells sessions apart: …/alex/Work. */
function shortDir(d) {
  if (!d) return "";
  const parts = String(d).split("/").filter(Boolean);
  return (parts.length > 2 ? "…/" : "/") + parts.slice(-2).join("/");
}
