// @ts-check
// The session view. On open it reads the session as blocks (recall.transcript, contract 2):
// what you said, the assistant's replies as markdown, thinking folded, every tool call as a card that
// knows its tool, and a quiet footer per turn. Then it follows thread.* over SSE (api.js's shared
// EventSource): text streams into a live reply with a cursor, thread.tool starts and finishes a
// live card from its summary, and on thread.finished or session.indexed the view reads the
// transcript from `next` and swaps each live row for its rich block in place (keyed by message
// id and tool id, so nothing shows twice). An older box without recall.transcript gets the
// earlier view (recall.thread turns and thread.* events), so nothing regresses.
//
// A "Raw" toggle in the header prints the same blocks the way Claude Code's terminal does
// ("⏺ Bash(npm test)" then "  ⎿  output"); the choice is remembered on this device.
//
// Labels come from lib/names.js and never say "claude": replies read the assistant's name from
// onboarding (an agent's thread: the agent's name; "Vyre" when none is set), your own
// messages read "you", another surface's read that surface's name.
//
// Question and permission asks are cards (question.js, ask-item.js) filled from threads.asks,
// since ask.raised drops the detail. Keys go to the card that has focus, or the newest open one,
// whenever focus is not in a text field (the composer included).
//
// The timeline is its own scroll container. It follows the bottom while a reply streams as long as
// the reader was at the bottom; scrolled up to read, new content leaves the reading place alone
// and shows a "Jump to latest" pill instead.
//
// Nothing here uses innerHTML: text is untrusted (it is the model's own output, or another
// person's), so it goes through lib/markdown.js, which never parses it as markup, or through
// text nodes directly.

import { h, put, empty } from "../js/dom.js";
import { attempt, on } from "../js/api.js";
import { icon } from "../js/icons.js";
import { clock } from "../js/fmt.js";
import { healthDot } from "../js/health.js";
import { gateCard } from "./gate-item.js";
import { askCard } from "./ask-item.js";
import { questionCard } from "./question.js";
import { mountComposer } from "./composer.js";
import { plan, sideOf, mergeBlocks, blockKey } from "./lib/blocks.js";
import { OURS, labelFor, isAssistant, readNames } from "./lib/names.js";
import { isMac, machineChip, readOnlyNote } from "../js/machine.js";
import { blockRow, headRow, userRow, liveTextRow, toolCard, turnRow, rawView } from "./blocks.js";

const PAGE = 400;
const KEEP = 1200; // blocks kept when a long session has to be paged forward to its end
const RAW_KEY = "vyre.chat.raw";
const readRaw = () => { try { return localStorage.getItem(RAW_KEY) === "1"; } catch { return false; } };
const saveRaw = on => { try { localStorage.setItem(RAW_KEY, on ? "1" : "0"); } catch {} };
/** A long transcript read the older way (recall.thread) opens at its last WINDOW turns; "Show earlier" reads the rest. */
const WINDOW = 60;
/** How long a deep-linked row flashes. */
const FLASH_MS = 1600;
const editable = t => !!t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT" || t.isContentEditable);

/**
 * @param {HTMLElement} container
 * @param {{ thread: string, project: string|null, recorded?: boolean, known?: boolean, turns?: number, source?: string|null, machine?: string|null,
 *   at?: number|null, ask?: string|null, tool?: string|null, onBack: () => void }} opts
 * recorded: the list already knows the Switchboard has no record of it, so skip threads.get.
 * known: the list had a row for it. turns: its turn count, so an older box's read opens at its end.
 * source, machine: the list's label for it; "mac" opens it read-only (a paired Mac's session).
 * at, ask, tool: a deep link (?at=<ms>&ask=<id>&tool=<tool_use_id>; read from the address when not
 * given): the row to scroll to and flash. An ask's anchor (its tool call) wins over `at`.
 * @returns {() => void} cleanup
 */
export function mountSession(container, opts) {
  const { thread } = opts;
  /** @type {Map<string, any>} keyed by "s:<seq>", "tool:<id>", "live:*", "ask:<id>", "gate:<id>", message id (legacy) */
  const rows = new Map();
  /** @type {Map<number, HTMLElement>} turn number (1-indexed, Switchboard turns) -> the element a fact for it goes after */
  const turnMarkers = new Map();
  const shownFacts = new Set();
  let turnSeq = 0;
  const timeline = h("div", { class: "thread-view cv-timeline" });
  let following = true;
  const jump = h("button", { class: "jump-latest", type: "button", hidden: true, onclick: () => toBottom() }, icon("chevron", 12), "Jump to latest");
  timeline.addEventListener("scroll", () => {
    following = timeline.scrollTop + timeline.clientHeight >= timeline.scrollHeight - 40;
    if (following) jump.hidden = true;
  }, { passive: true });
  const head = h("div", { class: "session-head" });
  const leaseBar = h("div", { class: "lease-bar" });
  const record = { current: /** @type {any} */ (null) };
  /** A session the Switchboard never ran (the user's own, in a terminal): followed through session.indexed. */
  const recorded = { on: false, next: 0, session: /** @type {any} */ (null), busy: false, again: false };
  /** "blocks": recall.transcript; "legacy": recall.thread turns and thread.* events (an older box). */
  let mode = "blocks";
  /** The transcript's blocks, seq order; the read position; the first seq held, when the box says. */
  let blocks = /** @type {any[]} */ ([]);
  let next = 0, first = /** @type {number|null} */ (null);
  const seen = new Set();
  /** Live rows not yet swapped for their blocks, in arrival order: key -> pseudo block (for the raw view). */
  const pending = new Map();
  /** thread.finished costs, oldest first, to put on the turn footers they belong to. */
  const finished = /** @type {{ at: number, cost_usd?: number }[]} */ ([]);
  /** The last rich row placed: new blocks go right after it, ahead of any live rows. */
  let cursorEl = /** @type {any} */ (null);
  let liveN = 0;
  let raw = readRaw();
  const rawBox = h("div", { class: "cv-raw-box", hidden: !raw });
  const earlier = h("div", { class: "cv-earlier", hidden: true });
  const health = healthDot();
  /** Where it lives when that is the paired Mac: then nothing here may send to it, lease it or take it. */
  const where = { source: opts.source || null, machine: opts.machine || null };
  const composer = mountComposer({ thread, agents: [], threads: [], holder: null, surface: "chat" });

  put(container, head, h("div", { class: "thread-wrap" }, timeline, jump), leaseBar, isMac(where) ? null : composer.el);
  timeline.replaceChildren(h("div", { class: "empty" }, "Loading…"));

  /** The assistant's and the owner's names (system.info, read once per page): replies are labelled with the first, "you" wears the second's initial. */
  let names = /** @type {{ assistant: string|null, owner: string|null }} */ ({ assistant: null, owner: null });
  let me = /** @type {string|null} */ (null);
  let replaying = false;
  const agentName = () => labelFor({ role: "assistant", agent: record.current?.agent }, names);
  const headFor = ts => headRow(agentName(), ts, isAssistant({ agent: record.current?.agent }, names));

  // ---- open -----------------------------------------------------------------------

  async function boot() {
    // A paired Mac's session is only ever a transcript the box asks the Mac for, read the older way.
    if (isMac(where)) { names = await readNames(attempt); me = names.owner; return legacyBoot({ error: { message: "on the Mac" } }); }
    // Everything at once: one round trip from a phone, not three.
    const [r, t, nm] = await Promise.all([
      opts.recorded ? { error: { message: "not a Switchboard session" } } : attempt("threads.get", { thread, since: 0, limit: 500 }),
      readTail(),
      readNames(attempt),
    ]);
    names = nm; me = nm.owner;
    if (!r.error) record.current = /** @type {any} */ (r).data.thread;
    // Only a box without the tool gets the earlier view: api.js calls any 404 "missing", and a
    // transcript not found yet (code not_found) is a live thread that still reads as blocks.
    if (t.error && t.error.missing && t.error.code !== "not_found") return legacyBoot(r);
    // Neither the Switchboard nor this box's transcripts have it: recall.thread asks the paired Mac.
    if (t.error && r.error) return legacyBoot(r);
    recorded.on = !!r.error;
    if (t.data?.session) recorded.session = t.data.session;
    drawHead();
    timeline.replaceChildren(earlier, rawBox);
    const got = t.data ? t.data.blocks : [];
    if (!got.length && recorded.on) timeline.append(h("div", { class: "empty th-wait" }, "Nothing was said in this session yet."));
    appendBlocks(got);
    drawEarlier();
    if (!r.error && !got.length) {
      // A live thread the transcript read has nothing for yet (not written, not found): draw what
      // the Switchboard's events say, as live rows. Once the transcript answers, refresh() swaps
      // each for its block, so nothing shows twice.
      const data = /** @type {any} */ (r).data;
      replaying = true;
      try { for (const e of data.events) applyEvent(e, false); } finally { replaying = false; }
      for (const a of data.asks) upsertAsk(a);
    } else if (!r.error) {
      const data = /** @type {any} */ (r).data;
      for (const e of data.events) {
        if (e.type === "thread.finished") { finished.push({ at: e.at, cost_usd: e.payload?.cost_usd }); turnSeq++; }
        if (e.type === "gate.held" || e.type === "gate.revised") placeByTime(upsertGate(e.payload.id, false), e.at);
      }
      applyCosts();
      for (const a of data.asks) upsertAsk(a);
    }
    if (raw) drawRaw();
    toBottom();
    seek();
    fetchMemory();
  }

  /** The latest page of the session. A box that reads from the start (no `first` in the answer) is paged forward to its end. */
  async function readTail() {
    const t = await attempt("recall.transcript", { session: thread, limit: PAGE });
    if (t.error) return t;
    let data = t.data;
    next = data.next ?? 0;
    first = typeof data.first === "number" ? data.first : typeof data.before === "number" ? data.before : null;
    if (first == null && data.blocks.length >= PAGE) {
      let all = data.blocks;
      for (let i = 0; i < 20; i++) {
        const more = await attempt("recall.transcript", { session: thread, from: next, limit: PAGE });
        if (more.error || !more.data.blocks.length) break;
        all = all.concat(more.data.blocks).slice(-KEEP);
        next = more.data.next ?? next;
        if (more.data.blocks.length < PAGE) break;
      }
      data = { ...data, blocks: all };
      first = all.length ? all[0].seq : null;
    }
    return { data };
  }

  function drawHead() {
    const rec = record.current;
    const ses = recorded.session;
    put(head,
      h("button", { class: "ibtn session-back", "aria-label": "Back", onclick: opts.onBack }, icon("left", 16)),
      h("div", { class: "cv-head-text" },
        h("div", { class: "title ellipsis" }, rec?.name || ses?.name || ses?.title || thread.slice(0, 12)),
        h("div", { class: "sub ellipsis", title: rec?.cwd || ses?.cwd || null }, [rec?.agent, shortDir(rec?.cwd || ses?.cwd)].filter(Boolean).join(" · ") || "Terminal session"),
      ),
      machineChip(where),
      rec?.status === "running" ? h("span", { class: "dot signal", title: "running" }) : null,
      mode === "blocks" ? h("button", { class: "btn btn-ghost btn-sm cv-raw-toggle", type: "button", "aria-pressed": String(raw), title: "Show it the way the terminal prints it",
        onclick: () => setRaw(!raw) }, raw ? "Rich" : "Raw") : null,
      health.el,
    );
    if (isMac(where)) { put(leaseBar, icon("lock", 12), h("span", { class: "lease-note" }, readOnlyNote(where))); return; }
    put(leaseBar,
      icon("lock", 12),
      rec?.holder && OURS.has(rec.holder) ? h("span", null, "You have the keyboard here")
        : rec?.holder ? h("span", null, h("span", { class: "who" }, rec.holder), " has the keyboard")
        : recorded.on ? h("span", { class: "lease-note" }, "Sending resumes this session here.")
        : h("span", null, "No one is typing"),
      rec?.holder && !OURS.has(rec.holder) ? h("button", { class: "btn btn-ghost btn-sm", onclick: take }, "Take") : null,
    );
  }
  async function take() { if (!isMac(where)) await attempt("threads.lease", { thread }); }
  /** A Mac session: no composer at all, so nothing typed here can reach threads.send or threads.lease. */
  function readOnly() { composer.el.remove(); }

  function setRaw(v) {
    raw = v; saveRaw(v);
    timeline.classList.toggle("cv-raw-on", v);
    rawBox.hidden = !v;
    if (v) drawRaw();
    drawHead();
  }
  let rawTimer = null;
  function drawRaw() {
    rawTimer = null;
    if (!raw) return;
    const live = [...pending.values()].map(p => (p.row && p.row.text ? { ...p.block, text: p.row.text() } : p.block));
    put(rawBox, rawView([...blocks, ...live]));
  }
  const rawSoon = () => { if (raw && !rawTimer) rawTimer = setTimeout(drawRaw, 200); };
  timeline.classList.toggle("cv-raw-on", raw);

  function drawEarlier() {
    earlier.hidden = !(first != null && first > 0 && mode === "blocks");
    if (!earlier.hidden) put(earlier, h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: loadEarlier }, "Load earlier"));
  }
  async function loadEarlier() {
    if (first == null) return;
    put(earlier, h("span", { class: "cv-note" }, "Loading…"));
    const r = await attempt("recall.transcript", { session: thread, before: first, limit: PAGE });
    if (r.error) { put(earlier, h("span", { class: "cv-note" }, "Could not load earlier.")); return; }
    const older = r.data.blocks.filter(b => !seen.has(blockKey(b)) && (first == null || b.seq < first));
    const h0 = timeline.scrollHeight;
    const at = rawBox.nextSibling; // the first row after the top controls
    for (const op of plan(older, null)) {
      const el = op.op === "head" ? headFor(op.ts) : rowFor(op.block);
      timeline.insertBefore(el, at);
    }
    blocks = mergeBlocks(older, blocks);
    first = typeof r.data.first === "number" ? r.data.first : older.length ? older[0].seq : 0;
    if (!older.length) first = 0;
    drawEarlier();
    if (raw) drawRaw();
    timeline.scrollTop += timeline.scrollHeight - h0;
  }

  // ---- rich rows ----------------------------------------------------------------------

  /** The row for a block, remembered by its key. */
  function rowFor(b, who) {
    const k = blockKey(b);
    seen.add(k);
    const el = blockRow(b, { who: who || "you", me });
    rows.set(k, el);
    return el;
  }

  /** Blocks on first read: appended in order, with an assistant header per run and day rules. */
  function appendBlocks(list) {
    for (const op of plan(list.filter(b => !seen.has(blockKey(b))), kindBefore(null))) {
      if (op.op === "head") { maybeDayRule(op.ts || Date.now()); timeline.append(headFor(op.ts)); continue; }
      if (op.block.kind === "user") maybeDayRule(op.block.ts || Date.now());
      const el = rowFor(op.block);
      timeline.append(el);
      cursorEl = el;
    }
    blocks = mergeBlocks(blocks, list);
  }

  /** The kind of the row before `ref` (or before the end), cards and rules skipped. */
  function kindBefore(ref) {
    let n = ref ? ref.previousElementSibling : timeline.lastElementChild;
    while (n) { const k = n._kind; if (k && k !== "card") return k; n = n.previousElementSibling; }
    return null;
  }

  /** Put a new rich row after the cursor (ahead of live rows), or at the end. */
  function placeRich(el, b) {
    const ref = cursorEl && cursorEl.parentNode === timeline ? cursorEl.nextSibling : firstLive();
    if (sideOf(b) === "assistant" && kindBefore(ref) !== "assistant") {
      if (ref && ref._liveHead) { cursorEl = ref; return placeRich(el, b); } // adopt the live header already there
      const hd = headFor(b.ts);
      timeline.insertBefore(hd, ref);
    }
    timeline.insertBefore(el, ref);
    cursorEl = el;
  }
  function firstLive() {
    for (const p of pending.values()) if (p.row && p.row.parentNode === timeline) return p.row;
    return null;
  }
  const isPending = el => [...pending.values()].some(p => p.row === el);

  /** Swap a row for a block's row in place; the cursor moves to it. */
  function swap(cur, b, who, move = true) {
    const el = rowFor(b, who);
    cur.replaceWith(el);
    if (move || cursorEl === cur) cursorEl = el;
    return el;
  }

  /**
   * Newer blocks from the transcript: each swaps for its live row, or goes in after the last rich
   * one. A re-read of an open turn sends blocks already shown: a tool's card takes its output,
   * the rest are skipped. The open turn's footer gives way to its closed version.
   */
  function addRich(list) {
    for (const b of list) {
      const key = blockKey(b);
      if (b.kind === "turn") {
        const open = rows.get("turn:open");
        const live = open ? null : [...pending].find(([k]) => k.startsWith("live:t:"));
        const cur = open || (live ? live[1].row : null);
        if (cur) {
          const cost = typeof b.cost_usd === "number" ? b.cost_usd : cur._cost;
          if (open) { rows.delete("turn:open"); seen.delete("turn:open"); }
          if (live) { pending.delete(live[0]); rows.delete(live[0]); }
          const el = swap(cur, { ...b, cost_usd: cost });
          for (const [n, m] of turnMarkers) if (m === cur) turnMarkers.set(n, el);
          continue;
        }
        if (seen.has(key)) continue;
        placeRich(rowFor(b), b);
        continue;
      }
      if (seen.has(key)) {
        if (b.kind === "tool") { const cur = rows.get(key); if (cur && cur.update) cur.update(b); }
        continue;
      }
      if (b.kind === "tool") {
        const cur = rows.get(key);
        if (cur) { pending.delete(key); swap(cur, b); continue; }
      }
      if (b.kind === "text" && b.message && rows.has("live:m:" + b.message)) {
        const cur = rows.get("live:m:" + b.message);
        rows.delete("live:m:" + b.message); pending.delete("live:m:" + b.message);
        swap(cur, b); continue;
      }
      if (b.kind === "user") {
        // The same words, or else the oldest live message: sends and transcript lines come in the same order.
        const users = [...pending].filter(([k]) => k.startsWith("live:u:"));
        const same = s => String(s || "").replace(/\s+/g, " ").trim();
        const hit = users.find(([, p]) => same(p.block.text) === same(b.text)) || users[0];
        if (hit) { const [k, p] = hit; pending.delete(k); rows.delete(k); swap(p.row, b, p.row._who); continue; }
      }
      placeRich(rowFor(b), b);
    }
    // A live header now right after an assistant row is a spare; one whose rows all turned rich
    // is an ordinary header and stops being live.
    for (const [k, p] of [...pending]) if (k.startsWith("live:h:")) {
      if (p.row.parentNode === timeline && kindBefore(p.row) === "assistant") p.row.remove();
      if (p.row.parentNode !== timeline || !isPending(p.row.nextElementSibling)) { pending.delete(k); p.row._liveHead = false; }
    }
    blocks = mergeBlocks(blocks, list);
    rawSoon();
  }

  /** Costs from thread.finished go on the turn footers they belong to: the latest turn that began before the event. */
  function applyCosts() {
    const turns = blocks.filter(b => b.kind === "turn");
    let n = 0;
    for (const f of finished) {
      n++;
      const t = turns.filter(x => x.ts && x.ts <= f.at + 5_000 && f.at - x.ts < (x.duration_ms || 0) + 120_000).pop();
      if (!t) continue;
      const cur = rows.get(blockKey(t));
      if (!cur) continue;
      if (typeof f.cost_usd === "number" && f.cost_usd > 0) turnMarkers.set(n, swap(cur, { ...t, cost_usd: f.cost_usd }, undefined, false));
      else turnMarkers.set(n, cur);
    }
  }

  /** Read what is new since `next`. One read at a time; a second ask during one reads again after. */
  const reading = { busy: false, again: false };
  async function refresh() {
    if (mode !== "blocks") return;
    if (reading.busy) { reading.again = true; return; }
    reading.busy = true;
    try {
      do {
        reading.again = false;
        const r = await attempt("recall.transcript", { session: thread, from: next, limit: PAGE });
        if (r.error) break;
        if (r.data.session && recorded.on) { recorded.session = r.data.session; drawHead(); }
        if (r.data.blocks.length) timeline.querySelector(".th-wait")?.remove();
        const n = timeline.scrollHeight;
        addRich(r.data.blocks);
        next = r.data.next ?? next;
        if (timeline.scrollHeight !== n) grew();
        if (r.data.blocks.length >= PAGE) reading.again = true;
      } while (reading.again);
    } finally { reading.busy = false; }
  }

  // ---- live rows -----------------------------------------------------------------------

  /** An assistant header at the end, unless the last row is already the assistant's. */
  function ensureHead(ts) {
    if (kindBefore(null) === "assistant") return;
    const el = /** @type {any} */ (headFor(ts));
    el._liveHead = true;
    const key = "live:h:" + (++liveN);
    pending.set(key, { row: el, block: { kind: "head" } });
    timeline.append(el);
  }
  // The raw view skips "head" pseudo blocks (rawLines ignores unknown kinds).

  function applyBlocksEvent(e) {
    const p = e.payload || {};
    if (e.type === "thread.sent") {
      maybeDayRule(e.at);
      const who = labelFor({ role: "user", surface: p.surface }, names);
      const el = /** @type {any} */ (userRow(who, p.text, e.at, me));
      el._who = who;
      const key = "live:u:" + (++liveN);
      pending.set(key, { row: el, block: { kind: "user", text: p.text } });
      rows.set(key, el);
      timeline.append(el);
      rawSoon();
      return;
    }
    if (e.type === "thread.text") {
      maybeDayRule(e.at);
      if (p.notice) { timeline.append(noticeMsg(p.text, e.at)); return; }
      const key = "live:m:" + p.message;
      let el = rows.get(key);
      if (!el) {
        if (blocks.some(b => b.kind === "text" && b.message === p.message)) return; // already rich
        ensureHead(e.at);
        el = liveTextRow(e.at);
        rows.set(key, el);
        pending.set(key, { row: el, block: { kind: "text", text: "" } });
        timeline.append(el);
      }
      if (p.delta) el.push(p.delta);
      if (p.done && p.text) { el.set(p.text); el.done(); }
      rawSoon();
      return;
    }
    if (e.type === "thread.tool") {
      const key = "tool:" + p.id;
      const cur = rows.get(key);
      if (p.phase === "started") {
        if (cur) return;
        ensureHead(e.at);
        const b = { kind: "tool", id: p.id, tool: p.tool, summary: p.summary, destination: p.destination, ts: e.at, output: null };
        const el = /** @type {any} */ (toolCard(b));
        el._live = true; el._block = b;
        rows.set(key, el);
        pending.set(key, { row: el, block: b });
        timeline.append(el);
      } else if (cur && cur._live) {
        const b = { ...cur._block, done: true, error: !!p.error, duration_ms: e.at && cur._block.ts ? e.at - cur._block.ts : null };
        cur._block = b; cur.update(b);
        const pd = pending.get(key); if (pd) pd.block = b;
      }
      rawSoon();
      return;
    }
    if (e.type === "thread.finished") {
      for (const [k, pd] of pending) if (k.startsWith("live:m:")) pd.row.done();
      if (!p.ok || p.error) timeline.append(h("div", { class: "turn-foot" }, h("span", { class: "err" }, "turn failed: " + (p.error || p.stop_reason || "error"))));
      turnSeq++;
      finished.push({ at: e.at, cost_usd: p.cost_usd });
      const t = { kind: "turn", ts: e.at, duration_ms: p.duration_ms, tokens: p.tokens, cost_usd: p.cost_usd };
      const el = turnRow(t);
      const key = "live:t:" + (++liveN);
      rows.set(key, el);
      pending.set(key, { row: el, block: t, marker: turnSeq });
      timeline.append(el);
      turnMarkers.set(turnSeq, el);
      if (!replaying) refresh();
      return;
    }
  }

  // ---- the earlier view (a box without recall.transcript) -------------------------------

  let lastMessageEl = null, lastMessageId = null;
  const toolKeys = [];
  async function legacyBoot(r) {
    mode = "legacy";
    if (opts.recorded || r.error) {
      const mac = isMac(where);
      const src = mac ? { source: "mac" } : {};
      let from = (opts.recorded || mac) && (opts.turns || 0) > WINDOW ? /** @type {number} */ (opts.turns) - WINDOW : 0;
      let t = await attempt("recall.thread", { session: thread, from, limit: 400, ...src });
      // The list's count and the transcript's numbering disagree: read it from the start.
      if (!t.error && from > 0 && !t.data.turns.length) { t = await attempt("recall.thread", { session: thread, limit: 400, ...src }); from = 0; }
      if (t.error) { timeline.replaceChildren(empty("Could not open this session.", t.error)); drawHead(); return; }
      recorded.on = true;
      recorded.session = t.data.session;
      // A session the list did not know may turn out to be the Mac's from the answer itself.
      if (isMac(t.data)) { where.source = "mac"; where.machine = t.data.machine || where.machine; readOnly(); }
      drawHead();
      timeline.replaceChildren();
      if (from > 0) timeline.append(earlierTurns(from));
      if (!t.data.turns.length) timeline.append(h("div", { class: "empty th-wait" }, "Nothing was said in this session yet."));
      appendTurns(t.data.turns);
      toBottom();
      seek();
      return;
    }
    drawHead();
    timeline.replaceChildren();
    for (const e of r.data.events) applyEvent(e, false);
    for (const a of r.data.asks) upsertAsk(a);
    toBottom();
    seek();
    fetchMemory();
  }
  /** "Show earlier" (the older read): the turns before `upto`, read and put above what is on screen. */
  function earlierTurns(/** @type {number} */ upto) {
    const btn = h("button", { type: "button", class: "btn btn-ghost btn-sm th-earlier" }, "Show earlier");
    btn.addEventListener("click", async () => {
      btn.setAttribute("disabled", "");
      const start = Math.max(0, upto - WINDOW * 2);
      const t = await attempt("recall.thread", { session: thread, from: start, limit: upto - start, ...(isMac(where) ? { source: "mac" } : {}) });
      if (t.error) { btn.removeAttribute("disabled"); return; }
      const holder = h("div", { class: "cv-earlier-turns" });
      const keep = timeline.scrollHeight - timeline.scrollTop;
      const saveNext = recorded.next, saveDay = lastDay;
      lastDay = null;
      appendTurns(t.data.turns, holder);
      recorded.next = saveNext; lastDay = saveDay;
      if (start > 0) holder.insertBefore(earlierTurns(start), holder.firstChild);
      btn.replaceWith(holder);
      timeline.scrollTop = timeline.scrollHeight - keep;
    });
    return btn;
  }
  function appendTurns(turns, /** @type {any} */ into = timeline) {
    for (const t of turns) {
      recorded.next = Math.max(recorded.next, (t.seq ?? 0) + 1);
      if (!t.text) continue;
      maybeDayRule(t.ts || Date.now(), into);
      if (t.role === "user") { into.append(userRow("you", t.text, t.ts, me)); continue; }
      into.append(headFor(t.ts), blockRow({ kind: "text", text: t.text, ts: t.ts }));
    }
  }
  async function readMoreLegacy() {
    if (!recorded.on || isMac(where)) return;
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
  function applyLegacyEvent(e) {
    const p = e.payload || {};
    if (e.type === "thread.sent") {
      maybeDayRule(e.at);
      timeline.append(userRow(labelFor({ role: "user", surface: p.surface }, names), p.text, e.at, me));
      lastMessageEl = null; lastMessageId = null;
      return;
    }
    if (e.type === "thread.text") {
      maybeDayRule(e.at);
      if (p.notice) { timeline.append(noticeMsg(p.text, e.at)); return; }
      if (p.message !== lastMessageId) {
        lastMessageId = p.message;
        timeline.append(headFor(e.at));
        lastMessageEl = liveTextRow(e.at);
        timeline.append(lastMessageEl);
      }
      if (p.delta) lastMessageEl.push(p.delta);
      if (p.done && p.text) { lastMessageEl.set(p.text); lastMessageEl.done(); }
      return;
    }
    if (e.type === "thread.tool") {
      const key = "tool:" + p.id;
      if (p.phase === "started") {
        if (rows.has(key)) return;
        const b = { kind: "tool", id: p.id, tool: p.tool, summary: p.summary, destination: p.destination, ts: e.at, output: null };
        const el = /** @type {any} */ (toolCard(b)); el._block = b;
        rows.set(key, el); timeline.append(el);
        toolKeys.push(key);
        while (toolKeys.length > 6) { const old = toolKeys.shift(); rows.get(old)?.remove(); rows.delete(old); }
      } else {
        const el = rows.get(key);
        if (el) { el._block = { ...el._block, done: true, error: !!p.error, duration_ms: e.at - el._block.ts }; el.update(el._block); }
      }
      return;
    }
    if (e.type === "thread.finished") {
      if (lastMessageEl) lastMessageEl.done();
      if (!p.ok || p.error) timeline.append(h("div", { class: "turn-foot" }, h("span", { class: "err" }, "turn failed: " + (p.error || p.stop_reason || "error"))));
      timeline.append(turnRow({ ts: e.at, duration_ms: p.duration_ms, tokens: p.tokens, cost_usd: p.cost_usd }));
      turnSeq++;
      turnMarkers.set(turnSeq, timeline.lastElementChild);
      return;
    }
  }

  // ---- events, both modes ---------------------------------------------------------------

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
    if (/^thread\.(sent|text|tool|finished)$/.test(e.type)) { if (mode === "blocks") applyBlocksEvent(e); else applyLegacyEvent(e); return; }
    if (e.type === "thread.stopped") { timeline.append(h("div", { class: "turn-foot" }, icon("terminal", 12), "session stopped" + (p.reason ? ": " + p.reason : ""))); return; }
    if (e.type === "ask.raised") {
      upsertAsk({ id: p.ask, tool: p.tool, summary: p.summary, destination: p.destination, reason: p.reason, kind: p.kind, questions: p.questions });
      fetchAsks();
      return;
    }
    // Answered here or on another screen: the card says what was decided rather than vanishing.
    if (e.type === "ask.answered") { const el = rows.get("ask:" + p.ask); if (el?.answered) el.answered(p.decision, p.answers); else if (el) el.remove(); return; }
    if (e.type === "gate.held" || e.type === "gate.revised") { upsertGate(p.id, live); return; }
    if (e.type === "gate.released" || e.type === "gate.rejected") { const el = rows.get("gate:" + p.id); if (el && el.refresh) el.refresh(); return; }
    if (e.type === "lease.changed") { drawHead(); return; }
  }

  function upsertGate(id, live) {
    const key = "gate:" + id;
    let el = rows.get(key);
    if (!el) { el = gateCard({ id }); el._kind = "card"; rows.set(key, el); timeline.append(el); }
    else if (live && el.refresh) el.refresh();
    return el;
  }
  /** A card from the event log goes where its time says, among rows that carry one. */
  function placeByTime(el, at) {
    if (!at) return;
    for (const n of timeline.children) { if (n !== el && n._ts && n._ts > at) { timeline.insertBefore(el, n); return; } }
  }

  /** A question or a permission ask, drawn once and filled in as more of it is read. */
  function upsertAsk(a) {
    const key = "ask:" + a.id;
    const full = { ...a, agent: agentName() };
    let el = rows.get(key);
    if (el) { el.update(full); el._ask = { ...el._ask, ...full }; return el; }
    el = a.kind === "question" ? questionCard(full) : askCard(full);
    el._ask = full;
    rows.set(key, el);
    timeline.append(el);
    if (!editable(document.activeElement)) el.focus?.({ preventScroll: true });
    return el;
  }
  async function fetchAsks() {
    const r = await attempt("threads.asks", { thread });
    if (r.error || !Array.isArray(r.data)) return;
    for (const a of r.data) if (!a.thread || a.thread === thread) upsertAsk(a);
  }

  /** The card a key belongs to: the one with focus, or the newest open one. */
  function cardFor(target) {
    const own = target && target.closest ? target.closest(".cv-q, .cv-ask") : null;
    if (own && own.isOpen && own.isOpen()) return own;
    const keys = [...rows.keys()].filter(k => k.startsWith("ask:")).reverse();
    for (const k of keys) { const el = rows.get(k); if (el.isOpen && el.isOpen() && el.parentNode === timeline) return el; }
    return null;
  }
  const onKey = (/** @type {KeyboardEvent} */ e) => {
    // The shell keeps pages mounted while away (deck/js/app.js): keys belong to the page on screen.
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !container.isConnected || container.closest?.(".away")) return;
    const t = /** @type {any} */ (e.target);
    if (editable(t)) return; // the composer, the "Other" field, the deny reason: their own keys
    if (t && (t.tagName === "BUTTON" || t.tagName === "A") && (e.key === "Enter" || e.key === " ")) return; // the focused control's own press
    const card = cardFor(t);
    if (card && card.onKey(e)) e.preventDefault();
  };
  document.addEventListener("keydown", onKey);

  // ---- a deep link: /chat/thread/<id>?at=<ms>&ask=<id>&tool=<tool_use_id> ---------------------

  function linkTarget() {
    let q = null;
    try { q = new URLSearchParams(location.search); } catch {}
    const num = v => (v == null || v === "" || !isFinite(Number(v)) ? null : Number(v));
    return { at: opts.at ?? num(q?.get("at")), ask: opts.ask ?? (q?.get("ask") || null), tool: opts.tool ?? (q?.get("tool") || null) };
  }
  /** Scroll to the linked row and flash it: an ask's card (or its anchored tool call), a tool call, else the first row at or after `at`. */
  let sought = false;
  function seek() {
    if (sought) return;
    const want = linkTarget();
    if (want.at == null && !want.ask && !want.tool) return;
    sought = true;
    const card = want.ask ? rows.get("ask:" + want.ask) : null;
    const anchor = card?._ask?.anchor?.tool_use_id || want.tool;
    let el = card && card.isOpen?.() ? card : null;
    if (!el && anchor) el = rows.get("tool:" + anchor) || null;
    if (!el && card) el = card;
    if (!el && want.at != null) for (const n of timeline.children) { if (n._ts && n._ts >= want.at) { el = n; break; } }
    if (!el) return;
    following = false;
    el.scrollIntoView?.({ block: "center" });
    el.classList.add("cv-flash");
    setTimeout(() => el.classList.remove("cv-flash"), FLASH_MS);
  }

  // ---- shared pieces ------------------------------------------------------------------------

  function toBottom() { timeline.scrollTop = timeline.scrollHeight; following = true; jump.hidden = true; }
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
  function maybeDayRule(at, /** @type {any} */ into = timeline) {
    const d = dayLabel(at);
    if (d === lastDay) return;
    lastDay = d;
    into.append(h("div", { class: "day-rule" }, h("span", { class: "line" }), h("span", { class: "lbl" }, d), h("span", { class: "line" })));
  }
  function noticeMsg(text, at) {
    return h("div", { class: "gate-note cv-notice" }, icon("clock", 12), " ", text, " ", h("span", { class: "msg-when" }, clock(at)));
  }

  // A gold fact, intelligence's real shape (memory.facts): {id, text, subject, rel, object,
  // confidence, age, stale, source, refs: [{seq}]}. Lessons are a different system and are never
  // rendered gold; only what memory.facts returns is.
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
  /** Right after the latest turn its refs mention: `refs: [{seq}]`, or a single `ref: {seq}`. */
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
    // memory.curated carries no thread: refetch this open thread and let the id dedup filter it.
    on("memory.curated", () => fetchMemory()),
    on("session.indexed", e => { if ((e.thread || e.payload?.session) !== thread) return; if (mode === "blocks") refresh(); else readMoreLegacy(); }),
  ];
  return () => { health.stop(); for (const off of offs) off(); composer.stop(); document.removeEventListener("keydown", onKey); if (rawTimer) clearTimeout(rawTimer); };
}

/** The last two folders of a path, which is what tells sessions apart: …/alex/Work. */
function shortDir(d) {
  if (!d) return "";
  const parts = String(d).split("/").filter(Boolean);
  return (parts.length > 2 ? "…/" : "/") + parts.slice(-2).join("/");
}
