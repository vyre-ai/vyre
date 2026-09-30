// @ts-check
// The session view: a native chat over Vyre's event stream (ADR 0030 section 1, ADR 0024).
//
// One state, two inputs. core/session-state.js holds the session as keyed items (what you said,
// the replies, thinking, each tool call, turn markers, notices, asks), the queue and the header
// fields. On open the view reads the transcript as blocks (recall.transcript, contract 2) into it;
// live thread.* and ask.* events go into it as they come; on thread.finished or session.indexed
// the transcript is read again from `next`, and each live item takes the transcript's fields in
// place under the same key, so nothing shows twice. Both inputs return the keys they changed, and
// the view patches only those rows; the order is laid out again (by reference, no rebuild) only
// when a row came or went.
//
// Rows: core/grouping.js folds each run of tool calls into one quiet row ("Edited 3 files, ran 2
// commands · 12 s") that opens to the calls (built on first open); a run still working says what
// it runs and counts up ("Running npm run build · 0:42"). Thinking folds to its length ("Thinking
// · 8 s"), each turn ends with its time and tokens, and a stopped turn says "Stopped by you". A
// reply streams through live-text.js: paced to the display, only the growing text re-parses. Rows
// off screen skip layout (content-visibility in chat.css).
//
// The header chip reads the session's provider, model and auth ("Claude · opus · subscription",
// unknown parts left out), how full the context is ("62% of context", from thread.usage, only
// when the box says the share) and its state word (starting, idle, running, waiting, stopped);
// a session closed for idleness says "Resumes on your next message". While a turn runs the
// composer has Stop (Esc): threads.interrupt, or on a Switchboard without it threads.stop.
//
// The composer works like Claude Code in the terminal (composer.js, core/composer-state.js):
// typing while a turn runs steers it, and a quiet "Steered at step N" row marks where the words
// joined (live, and again on a re-read: core/transcripts marks such a line). Messages queued for
// after the turn sit above the composer: "Queued for after <text>" with Edit, Take back and Steer
// now (threads.edit, threads.unqueue, threads.send-now, each naming the row's `queued` id). Esc
// Esc opens the rewind sheet: your messages from the session state; choosing one rewinds this
// same thread to just before it (threads.rewind): that message and everything after it leave the
// view, and its words come back to the composer to edit and send again. It offers what Claude
// Code does: code and conversation (the default), conversation, or code (the files put back, the
// conversation kept; a notice "Restored N files"). The
// pinned todo list and the background tasks tray sit above the composer, and Ctrl+O hides or
// shows the thinking. A box without the sessions update is learnt from its first "no such tool"
// (core/caps.js): that control turns off and says "Needs the sessions update".
//
// Asks and questions are inline at the tail and in Needs at once; answering either resolves the
// other, and one answered on another screen says where ("Answered from the Capsule · 14:31"). Keys
// go to the card that has focus, or the newest open one, whenever focus is not in a text field:
// A allows once, D denies, Enter, Esc, arrows, space and 1-9 as the cards define. Keys are heard
// only while this page is on screen.
//
// Kept from before: Mac sessions (source "mac": sends and answers carry the machine, an offline
// chip, cards say "on <machine>", or "Answer it on <machine>" on a box that cannot forward), gate items, memory facts after their turn, notices, day rules,
// the Raw toggle (the same items printed the way the terminal prints them), "Load earlier", the
// Jump to latest pill, deep links from Needs (?at, ?ask, ?tool). An older box without
// recall.transcript gets the earlier view (recall.thread turns and thread.* events), unchanged.
//
// Labels come from lib/names.js and never say "claude": replies read the assistant's name (an
// agent's thread: the agent's), your own messages "you", another surface its own name. The chip
// names the provider, which is what it is for.
//
// Nothing here uses innerHTML: text is untrusted, so it goes through lib/markdown.js or text nodes.

import { h, put, empty, go } from "../js/dom.js";
import { openHref } from "./newsession.js";
import { attempt, on, onResume } from "../js/api.js";
import { icon } from "../js/icons.js";
import { clock } from "../js/fmt.js";
import { healthDot } from "../js/health.js";
import { gateCard } from "./gate-item.js";
import { mountTip } from "./tip-line.js";
import { planCard } from "./plan-card.js";
import { isPlanAsk } from "./core/plan.js";
import { askCard } from "./ask-item.js";
import { questionCard } from "./question.js";
import { askCardFor } from "./cards/index.js";
import { macAnswersHeld } from "./presence.js";
import { mountComposer } from "./composer.js";
import { duration, elapsed, toolTitle, toolVerb } from "./lib/blocks.js";
import { OURS, labelFor, isAssistant, readNames } from "./lib/names.js";
import { threadAvatar, readTeammates, readProjects } from "../js/avatars.js";
import { threadHref } from "./lib/routes.js";
import { isMac, machineChip } from "../js/machine.js";
import { blockRow, headRow, userRow, liveTextRow, thinkingRow, toolCard, handoffCard, turnRow, rawView, outputEl, pictureThumb } from "./blocks.js";
import { frameToPicture } from "./core/images.js";
import { textItemRow } from "./live-text.js";
import { createSession, applyEvent as applyStateEvent, applyBlocks, checkpoints, noteRewind, contextLabel, filesNote, seedTasks, pendingEvents } from "./core/session-state.js";
import { CAPS, NEEDS_UPDATE, REWIND_CODE } from "./core/caps.js";
import { rewindSheet } from "./pickers.js";
import { todoPin, tasksTray } from "./tray.js";
import { createGrouper } from "./core/grouping.js";
import { createWindowView, createStick } from "./window-view.js";

const PAGE = 400;
const MAC_PAGE = 80;
const RAW_KEY = "vyre.chat.raw";
const readRaw = () => { try { return localStorage.getItem(RAW_KEY) === "1"; } catch { return false; } };
const saveRaw = on => { try { localStorage.setItem(RAW_KEY, on ? "1" : "0"); } catch {} };
/** A long transcript read the older way (recall.thread) opens at its last WINDOW turns; "Show earlier" reads the rest. */
const WINDOW = 60;
/** How long a deep-linked row flashes. */
const FLASH_MS = 1600;
/** A turn cancelled this soon after this screen pressed Stop was stopped by you. */
const STOP_MS = 120_000;
const THINK_KEY = "vyre.chat.hide-thinking";
const readHideThinking = () => { try { return localStorage.getItem(THINK_KEY) === "1"; } catch { return false; } };
/**
 * Event names the view reads beyond the ones api.js always listens for: naming them makes the
 * shared stream listen (thread.* only hears the names it knows).
 */
const MORE_EVENTS = ["thread.state", "thread.status", "thread.turn", "thread.queued", "thread.unqueued", "thread.steered", "thread.rewound",
  "thread.model", "thread.thinking", "thread.task", "thread.shell", "thread.remembered", "thread.usage", "thread.limit", "thread.picked"];
const editable = t => !!t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT" || t.isContentEditable);
const PROVIDERS = /** @type {Record<string, string>} */ ({ claude: "Claude", codex: "Codex", acp: "ACP" });
// Sessions' canonical, person-facing vocabulary (lib/thread-status.js, thread.status /
// canonical_status): starting, working, asking (an ask is open), waiting (idle, ready for you),
// paused (an idle close/restart/rewind - resumable, not an error), stopped (you pressed Stop),
// finished, failed. Read directly, never relabeled here - a local map that did that (STATUS,
// "working"->"running" etc.) reimplemented the server's own old-vocabulary relabeling and shared
// its bug (asking/waiting swapped for a person); dropped per sessions' 6e2f8a71/28a8b4f8.
const BUSY = new Set(["starting", "working", "asking"]);
/** Where an answer came from, as the card says it. */
const SURFACES = /** @type {Record<string, string>} */ ({ capsule: "the Capsule", cli: "the terminal", local: "the terminal", phone: "your phone",
  mobile: "your phone", pwa: "your phone", needs: "Needs", deck: "the Deck", chat: "the Deck", glass: "Glass" });

/**
 * @param {HTMLElement} container
 * @param {{ thread: string, project: string|null, projects?: any[], recorded?: boolean, known?: boolean, turns?: number, source?: string|null, machine?: string|null,
 *   at?: number|null, ask?: string|null, tool?: string|null, shown?: () => boolean, onBack: () => void }} opts
 * recorded: the list already knows the Switchboard has no record of it, so skip threads.get.
 * known: the list had a row for it. turns: its turn count, so an older box's read opens at its end.
 * source, machine: the list's label for it; "mac" is a paired Mac's session.
 * projects: projects.list's rows (name lookup only), so the header can show which project this
 * thread is in - the one visible sign for an agent's own thread, whose project the composer never
 * chose (cohesion's one-product-audit finding 6).
 * at, ask, tool: a deep link (?at=<ms>&ask=<id>&tool=<tool_use_id>; read from the address when not
 * given): the row to scroll to and flash. An ask's anchor (its tool call) wins over `at`.
 * shown: whether this page is the one on screen (index.js's ctx.shown); keys and frames only then.
 * @returns {() => void} cleanup
 */
export function mountSession(container, opts) {
  const { thread } = opts;
  const S = createSession(thread);
  /** Item key -> its row. */
  const els = new Map();
  /** Run key -> its fold row; which run each folded item is in; the runs a reader opened. */
  const runEls = new Map();
  const runOf = new Map();
  const openRuns = new Set();
  /** Assistant headers by the key of the row they head; day rules by label. */
  const headEls = new Map();
  const dayEls = new Map();
  /** Ask id -> what threads.asks and the events said (the card's detail), who answered it and when. */
  const askInfo = new Map();
  const askBy = new Map();
  /** Ask id -> its card, both modes (keys go to the newest open one). */
  const cards = new Map();
  /** Gate cards by id, placed by time; memory facts after the turn they name. */
  const gates = new Map();
  const facts = /** @type {{ el: HTMLElement, n: number, id: string }[]} */ ([]);
  const shownFacts = new Set();
  /** Turn keys this screen stopped. */
  const byMe = new Set();
  const stop = { at: 0, via: /** @type {"interrupt"|"stop"|null} */ (null), busy: false, error: /** @type {string|null} */ (null) };

  const timeline = h("div", { class: "thread-view cv-timeline" });
  const jump = h("button", { class: "jump-latest", type: "button", hidden: true, onclick: () => toBottom() }, icon("chevron", 12), "Jump to latest");
  /**
   * Stuck to the bottom (window-view.js createStick): a ResizeObserver on the rows keeps the tail
   * in view, one frame per burst, with no layout read per event; only the reader's own upward
   * scroll detaches, and coming back to the bottom sticks again.
   */
  const stick = createStick(timeline, {
    onStick: () => win.follow(),
    onChange: stuck => { if (stuck) jump.hidden = true; },
    onGrowDetached: () => { jump.hidden = false; },
  });
  timeline.addEventListener("scroll", () => win.schedule(true), { passive: true });
  /** Long sessions mount only the rows near the viewport (window-view.js); the bottom anchor is kept there. */
  const win = createWindowView(timeline, { following: () => stick.stuck, onUnmount: (k, el) => unmounted(k, el), resize: stick });
  const head = h("div", { class: "session-head" });
  /** A running step's screen (cohesion item 18/1: sight.frame, through sight.targets - never a
   * guessed target format, and only this thread's own agent, never another one's computer). */
  const sightEl = h("div", { class: "cv-sight", hidden: true });
  const sight = { checked: false, target: /** @type {string|null} */ (null), pic: /** @type {import("./core/images.js").Picture|null} */ (null) };
  /** The composer hint line's tip (tip-line.js), once the view has opened. @type {ReturnType<typeof mountTip>|null} */
  let tip = null;
  const leaseBar = h("div", { class: "lease-bar" });
  const queuedBox = h("div", { class: "cv-queued", role: "status", hidden: true });
  const record = { current: /** @type {any} */ (null) };
  /** A session the Switchboard never ran (the user's own, in a terminal): followed through session.indexed. */
  const recorded = { on: false, next: 0, session: /** @type {any} */ (null), busy: false, again: false };
  /** "blocks": recall.transcript into session-state; "legacy": recall.thread turns and thread.* events (an older box). */
  let mode = "blocks";
  /** The read position; the first seq held, when the box says. */
  let next = 0, first = /** @type {number|null} */ (null);
  let raw = readRaw();
  const rawBox = h("div", { class: "cv-raw-box", hidden: !raw });
  const earlier = h("div", { class: "cv-earlier", hidden: true });
  const waitNote = h("div", { class: "empty th-wait" }, "Nothing was said in this session yet.");
  const health = healthDot();
  /** Where it lives when that is the paired Mac. */
  const where = { source: opts.source || null, machine: opts.machine || null };
  const macName = () => where.machine || "your Mac";
  /** A Mac session: what waits in its queue (from the composer), and whether the last send found the Mac offline. */
  const mac = { queued: 0, name: "", offline: /** @type {string|null} */ (null) };
  const composer = mountComposer({ thread, agents: [], threads: [], holder: null, surface: "chat", machine: isMac(where) ? macName() : null,
    onQueue: (n, name) => { mac.queued = n; mac.name = name; if (isMac(where)) drawHead(); },
    onOffline: m => { mac.offline = m; drawHead(); },
    onStop: () => stopTurn(),
    // A message drawn on send (its row key u:<uuid>) brings the reader down to it, as thread.sent does.
    session: S, patch: keys => { const sent = !!booted && keys.some(k => k.startsWith("u:")); patch(keys); if (sent) toBottom(); },
    cwd: () => record.current?.cwd || recorded.session?.cwd || null,
    name: () => agentName(),
    project: () => record.current?.project || opts.project || null,
    onRewind: () => openRewind(),
    // "/find [words]" (native-core/commands.js): the existing Find page already queries
    // recall.search + memory.relevant and has its own scoping rules; the composer just gets there fast.
    onFind: q => go("/find" + (q ? "?q=" + encodeURIComponent(q) : "")),
    onTasks: () => tray.toggle(),
    onThinkingView: () => setHideThinking(!hideThinking),
    onOverlayEscape: () => { if (!rewind) return false; closeRewind(); return true; },
    onRecall,
  });
  /** The live todo list and the background tasks, above the composer. */
  const pin = todoPin();
  const tray = tasksTray({
    can: () => CAPS.has("threads.kill-task"),
    onView: t => { if (!t.call) return; const el = reveal("t:" + t.call); if (el) { el.scrollIntoView?.({ block: "center" }); el.classList.add("cv-flash"); setTimeout(() => el.classList.remove("cv-flash"), FLASH_MS); } },
    onKill: async t => {
      // {thread, task, killed: true}; thread.task {status: "killed"} follows. Not running: {killed: false, note}.
      const r = await CAPS.use("threads.kill-task", () => attempt("threads.kill-task", { thread, task: t.id }));
      if (r.error) return r.missing ? NEEDS_UPDATE : "Could not stop it: " + (r.error.message || r.error.code);
      const d = /** @type {any} */ (r.data) || {};
      return d.killed === false ? String(d.note || "Could not stop it") : null;
    },
  });

  /**
   * "From your past sessions" (native-core's composer.js, memory-iq's recall.related): a hint row
   * was tapped. Opens that session (its own thread, almost always a different one - a session
   * rarely surfaces its own past turns as "past") at the point it was said, the way any other
   * cross-session link does (threadHref + go), never a special reveal-in-place: this session's
   * own view has no reason to change. The moment is a real timestamp (hit.ts), so it rides the
   * existing ?at= deep link (line ~1351 below, want.at) rather than a new one keyed by seq.
   * @param {{ session: string, seq?: number, role?: string, ts?: number, name?: string|null, title?: string|null, cwd?: string|null, snippet?: string }} hit
   */
  function onRecall(hit) {
    if (!hit?.session) return;
    const href = threadHref({ id: hit.session }, record.current?.project || opts.project || null) + (hit.ts ? `?at=${hit.ts}` : "");
    go(href);
  }
  /** The rewind sheet (Esc Esc), while it is open: a real overlay (sheet.css's --scrim/--float
   * tokens), not drawn in the transcript's own flow above the composer - on a phone, that stack
   * (lease bar, todos, queued row, this) pushed the composer's mode row off the bottom of the
   * viewport (app-design's review). Keyboard routing is unchanged (rewind.key(e) in onKey below;
   * this only moves where it's drawn, not how Esc/Enter/arrows reach it). A tap on the scrim
   * closes it, matching the tap-on-backdrop convention elsewhere (lightbox.js). */
  const rewindScrim = h("div", { class: "cv-rewind-scrim", hidden: true, onclick: () => closeRewind() });
  const rewindBox = h("div", { class: "cv-rewind-box", hidden: true });
  let rewind = /** @type {ReturnType<typeof rewindSheet>|null} */ (null);
  let hideThinking = readHideThinking();
  const capsOff = CAPS.on(() => { drawQueued(); tray.draw(); rewind?.refresh(); });

  put(container, head, sightEl, h("div", { class: "thread-wrap" }, timeline, jump), leaseBar, pin.el, tray.el, queuedBox, rewindScrim, rewindBox, composer.el);
  timeline.replaceChildren(h("div", { class: "empty" }, "Loading…"));

  let names = /** @type {{ assistant: string|null, owner: string|null }} */ ({ assistant: null, owner: null });
  let me = /** @type {string|null} */ (null);
  let replaying = false, booted = false;
  const early = /** @type {any[]} */ ([]);
  const agentName = () => labelFor({ role: "assistant", agent: record.current?.agent }, names);
  /** Who the replies are from, as an avatar (js/avatars.js threadAvatar): the project's tile, a chat's draft tile, an agent, a teammate or the assistant. */
  const whoAv = (size = 24, cls = "av-agent msg-av cv-av") => threadAvatar({ agent: record.current?.agent, project: record.current?.project || opts.project || null, thread },
    { size, cls, title: agentName() });
  const headFor = ts => headRow(agentName(), ts, isAssistant({ agent: record.current?.agent }, names), whoAv());
  /** This page is the one on screen, and the tab is visible. */
  const visible = () => {
    try { if (typeof document !== "undefined" && document.visibilityState === "hidden") return false; } catch {}
    if (opts.shown && !opts.shown()) return false;
    return !container.closest?.(".away");
  };
  /** A Switchboard session (not a terminal's transcript, not the Mac's): it has a state, Stop and a queue. */
  const switchboard = () => !isMac(where) && !recorded.on && (!!record.current || S.meta.lastId > -Infinity);
  const busy = () => switchboard() && BUSY.has(S.state);

  // ---- open -----------------------------------------------------------------------

  async function boot() {
    // Everything at once: one round trip from a phone, not three. A paired Mac's session is only
    // ever a transcript the box asks the Mac for (recall.transcript, source "mac").
    const [r, t, nm] = await Promise.all([
      opts.recorded || isMac(where) ? { error: { message: "not a Switchboard session" } } : attempt("threads.get", { thread, since: 0, limit: 500 }),
      readTail(),
      readNames(attempt),
      readTeammates(attempt),
      readProjects(attempt),
    ]);
    names = nm; me = nm.owner;
    if (!r.error) {
      record.current = /** @type {any} */ (r).data.thread;
      const rec = record.current || {};
      const st = rec.canonical_status || rec.state;
      if (st) S.state = st;
      for (const k of /** @type {const} */ (["provider", "model", "auth", "purpose"])) if (rec[k]) S[k] = String(rec[k]);
      if (typeof rec.mode === "string") S.mode = rec.mode;
      if (Array.isArray(rec.modes)) S.modes = rec.modes.map(String);
      if (typeof rec.thinking === "boolean") S.thinking = rec.thinking;
    }
    // Only a box without the tool gets the earlier view: api.js calls any 404 "missing", and a
    // transcript not found yet (code not_found) is a live thread that still reads as blocks.
    if (t.error && t.error.missing && t.error.code !== "not_found") return legacyBoot(r);
    // Neither the Switchboard nor this box's transcripts have it: recall.thread asks the paired Mac.
    if (t.error && r.error) return legacyBoot(r);
    recorded.on = !!r.error;
    if (t.data?.session) recorded.session = t.data.session;
    // Rewinds first: the transcript still holds the branch each one left, which is never drawn.
    // A code-only restore left the conversation as it was: nothing to skip.
    if (!r.error) for (const e of /** @type {any} */ (r).data.events || []) if (e.type === "thread.rewound" && e.payload?.uuid && e.payload.restore !== "code") noteRewind(S, { uuid: String(e.payload.uuid), at: Number(e.at) || Date.now() });
    const got = t.data ? t.data.blocks : [];
    applyBlocks(S, got);
    if (!r.error && !got.length) {
      // A live thread the transcript has nothing for yet: its events, as live items. Once the
      // transcript answers, each takes its block's fields in place, so nothing shows twice.
      const data = /** @type {any} */ (r).data;
      replaying = true;
      try { for (const e of data.events) onEvent(e, false); } finally { replaying = false; }
      for (const a of data.asks) upsertAsk(a);
    } else if (!r.error) {
      const data = /** @type {any} */ (r).data;
      const done = [];
      for (const e of data.events) {
        if (e.type === "thread.finished") done.push({ at: e.at, cost_usd: e.payload?.cost_usd });
        if (e.type === "gate.held" || e.type === "gate.revised") upsertGate(e.payload.id, false, e.at);
        if (typeof e.id === "number") S.meta.lastId = Math.max(S.meta.lastId, e.id);
      }
      applyCosts(done);
      // The queue and steers not taken in yet: the transcript holds neither, only the events do.
      for (const e of pendingEvents(data.events)) applyStateEvent(S, e);
      for (const a of data.asks) upsertAsk(a);
    }
    booted = true;
    report();
    // The tip on the composer's hint line (tip-line.js): hidden while a turn runs or a card waits.
    if (!recorded.on && !tip) tip = mountTip(composer.tipSlot, { busy: () => busy() || [...cards.values()].some(c => c.isOpen?.() && c.parentNode),
      empty: () => !composer.value().trim(), input: composer.input, visible });
    layout();
    drawHead();
    drawQueued();
    pin.set(S.todos);
    tray.set(S.tasks);
    drawEarlier();
    for (const e of early.splice(0)) onLive(e);
    readTasks();
    if (raw) drawRaw();
    toBottom();
    seek();
    fetchMemory();
  }

  /** Pages from a paired Mac are smaller: each is one link reply, under its 5 MB body cap. */
  const page = () => isMac(where) ? MAC_PAGE : PAGE;
  /** One read of the session as blocks, from the Mac when it lives there. @param {Record<string, any>} q */
  const transcript = q => attempt("recall.transcript", { session: thread, ...q, limit: page(), ...(isMac(where) ? { source: "mac" } : {}) });

  /** The latest page of the session. A box that reads from the start (no `first` in the answer) is paged forward to its end. */
  async function readTail() {
    const t = await transcript({});
    if (t.error) return t;
    let data = t.data;
    next = data.next ?? 0;
    first = typeof data.first === "number" ? data.first : typeof data.before === "number" ? data.before : null;
    if (first == null && data.blocks.length >= page()) {
      let all = data.blocks;
      for (let i = 0; i < 20; i++) {
        const more = await transcript({ from: next });
        if (more.error || !more.data.blocks.length) break;
        all = all.concat(more.data.blocks).slice(-1200);
        next = more.data.next ?? next;
        if (more.data.blocks.length < page()) break;
      }
      data = { ...data, blocks: all };
      first = all.length ? all[0].seq : null;
    }
    return { data };
  }

  // ---- the header, the lease line, the queue ----------------------------------------------

  /** "Claude · opus · subscription": the parts that are known. */
  function chipText() {
    const prov = S.provider ? (PROVIDERS[S.provider.toLowerCase()] || S.provider) : null;
    const m = S.model ? (/(opus|sonnet|haiku|fable)/i.exec(S.model)?.[1]?.toLowerCase() || S.model) : null;
    const auth = S.auth && S.auth !== "ambient" ? S.auth : null;
    return [prov, m, auth].filter(Boolean).join(" · ");
  }

  /**
   * The project this thread is in, by name when known: threads.get's own read (most current, and
   * the only source for an agent's thread, whose own project the New session sheet never chose)
   * over the route/list's slug. Null with no project (a folder-only or project-less session).
   */
  function projectName() {
    const slug = record.current?.project || opts.project;
    if (!slug) return null;
    return (opts.projects || []).find(p => p.slug === slug)?.name || slug;
  }

  /**
   * A chat filed into a project (thread.picked), or made into one: its replies and header take
   * that project's tile (its history re-renders in place, the rows themselves stay).
   */
  async function refile(project) {
    if (!project || !record.current || record.current.project === project) return;
    record.current = { ...record.current, project };
    await readProjects(attempt, { again: true });
    const rows = new Set([...headEls.values(), ...timeline.querySelectorAll(".cv-head")]);
    for (const row of rows) row.querySelector(".msg-av")?.replaceWith(whoAv());
    drawHead();
  }

  function drawHead() {
    const rec = record.current;
    const ses = recorded.session;
    const sb = switchboard();
    const chip = chipText();
    const ctx = contextLabel(S.usage);
    const proj = projectName();
    checkSight();
    put(head,
      h("button", { class: "ibtn session-back", "aria-label": "Back", onclick: opts.onBack }, icon("left", 16)),
      whoAv(32, "cv-head-av"),
      h("div", { class: "cv-head-text" },
        // The title and a short id: sessions in one project share its tile, so these tell them apart.
        h("div", { class: "cv-head-line" }, h("div", { class: "title ellipsis" }, rec?.name || ses?.name || ses?.title || thread.slice(0, 12)),
          h("span", { class: "cv-num code faint", title: `Session ${thread}` }, "#" + thread.slice(0, 6))),
        h("div", { class: "sub ellipsis", title: rec?.cwd || ses?.cwd || null }, [rec?.agent, shortDir(rec?.cwd || ses?.cwd)].filter(Boolean).join(" · ") || "Terminal session"),
      ),
      proj ? h("span", { class: "tag cv-project", title: `In ${proj}` }, proj) : null,
      machineChip(where),
      mac.offline ? h("span", { class: "tag machine off cv-offline", title: `${mac.offline} is not reachable` }, `${mac.offline} offline`) : null,
      chip ? h("span", { class: "tag cv-chip" }, chip) : null,
      ctx ? h("span", { class: "tag cv-context" + (ctx.share >= 0.8 ? " high" : ""), title: ctx.title }, ctx.text) : null,
      sb ? h("span", { class: "cv-state cv-state-" + S.state, title: "This session is " + S.state }, S.state + (S.turn && BUSY.has(S.state) ? ` · turn ${S.turn}` : "")) : null,
      mode === "blocks" ? h("button", { class: "btn btn-ghost btn-sm cv-think-toggle", type: "button", "aria-pressed": String(!hideThinking),
        title: "Show or hide the thinking (Ctrl+O)", onclick: () => setHideThinking(!hideThinking) }, hideThinking ? "Show thinking" : "Hide thinking") : null,
      mode === "blocks" ? h("button", { class: "btn btn-ghost btn-sm cv-raw-toggle", type: "button", "aria-pressed": String(raw), title: "Show it the way the terminal prints it",
        onclick: () => setRaw(!raw) }, raw ? "Rich" : "Raw") : null,
      health.el,
    );
    composer.setBusy(busy());
    tip?.sync();
    // A Mac session: the keyboard is the Mac's own (the lease is not forwarded), so no Take.
    if (isMac(where)) { put(leaseBar, icon("laptop", 12), h("span", { class: "lease-note" }, `On ${macName()}` + (mac.queued ? ` · Queued for ${mac.name || "this session"}` : ""))); return; }
    // "paused" (lib/thread-status.js) already means exactly an idle timeout/restart/rewind - a
    // closed-but-resumable session, not an error; session-state.js's own guess (thread.stopped,
    // before any real thread.status arrives) already speaks this word too.
    const idleClosed = sb && S.state === "paused";
    // Nobody holds the keyboard, nothing to resume, no error: on a solo session (the common case)
    // this is every draw, forever - "No one is typing" then reads as a chat-presence indicator with
    // nothing to report, not a keyboard-lease one. Hide the row rather than say that (app-design).
    const nothing = !rec?.holder && !recorded.on && !idleClosed && !stop.error;
    leaseBar.hidden = nothing;
    if (nothing) return;
    put(leaseBar,
      icon("lock", 12),
      rec?.holder && OURS.has(rec.holder) ? h("span", null, "You have the keyboard here")
        : rec?.holder ? h("span", null, h("span", { class: "who" }, rec.holder), " has the keyboard")
        : recorded.on ? h("span", { class: "lease-note" }, "Sending resumes this session here.")
        : idleClosed ? h("span", { class: "lease-note cv-resumes" }, "Resumes on your next message")
        : null, // only stop.error is true here (the `nothing` check above returned otherwise)
      rec?.holder && !OURS.has(rec.holder) ? h("button", { class: "btn btn-ghost btn-sm", onclick: take }, "Take") : null,
      stop.error ? h("span", { class: "err cv-stop-err" }, stop.error) : null,
    );
  }
  async function take() { if (!isMac(where)) await attempt("threads.lease", { thread }); }

  /**
   * A running step's screen: this thread's own agent, only if sight.targets (the registry, never a
   * guessed "agent:<name>") lists it live - so a plain session, or an agent with no computer
   * running, draws nothing. Matched by `target` (the registry's own identifier, "agent:<name>"),
   * not `label` (a display name that could in principle collide or diverge from it).
   *
   * The lookup runs once at mount; if no live target is found yet, it tries again on
   * computer.checked-out (this thread's agent just got a running screen) or sight.stepped (a step
   * landed for this thread - it must be live), each scoped to this thread, so an agent whose
   * computer starts after the thread opens still gets the strip without a reopen. Never a timer,
   * per sight.frame's own contract.
   */
  async function checkSight() {
    if (sight.checked) return;
    sight.checked = true;
    if (!record.current?.agent) return;
    await trySight();
    if (!sight.target) {
      const retry = () => { if (!sight.target) trySight(); };
      offs.push(on("computer.checked-out", ev => { if (ev.thread === thread) retry(); }));
      offs.push(on("sight.stepped", ev => { if (ev.thread === thread) retry(); }));
    }
  }
  async function trySight() {
    const agent = record.current?.agent;
    if (!agent) return;
    const want = `agent:${agent}`;
    const r = await attempt("sight.targets", {});
    const t = (r.data?.targets || []).find(x => x.kind === "agent" && x.target === want && x.live);
    if (!t) return;
    sight.target = t.target;
    await refreshSight();
    offs.push(on("sight.stepped", ev => { if (ev.thread === thread && ev.payload?.target === sight.target) refreshSight(); }));
  }
  async function refreshSight() {
    if (!sight.target) return;
    const r = await attempt("sight.frame", { target: sight.target, maxWidth: 480 });
    const pic = frameToPicture(r.data);
    if (!pic) return; // a shield (someone signing in) or no step yet: keep the last still, draw nothing new
    sight.pic = pic;
    drawSight();
  }
  function drawSight() {
    sightEl.hidden = !sight.pic;
    if (sight.pic) put(sightEl, pictureThumb(sight.pic, `${record.current?.agent}'s screen`, { w: 160, h: 120 }));
  }
  /** Found to be the Mac's from recall.thread's answer: sends from now on carry the machine. */
  function onMac() { composer.setMachine(macName()); }

  /**
   * "Queued for after <text>" rows above the composer, from the session's queue: Edit takes the
   * words back into the box (Enter saves them, threads.edit), Take back withdraws the message
   * (threads.unqueue; the words come back to the box), Steer now hands it to the running turn at
   * its next step (threads.send-now). Each names the row by its `queued` id, so a row drawn on
   * send has its buttons off until the box has answered with one. A button whose tool the box
   * lacks is off and says so.
   */
  function drawQueued() {
    queuedBox.hidden = !S.queued.length;
    const btn = (label, cls, tool, q, fn) => {
      const off = CAPS.has(tool) === false, early = q.queued == null;
      return h("button", { class: "btn btn-ghost btn-sm " + cls, type: "button", disabled: off || early,
        title: off ? NEEDS_UPDATE : early ? "Queueing…" : label, onclick: fn }, label);
    };
    put(queuedBox, S.queued.map(q => h("div", { class: "cv-queued-row" + (q.local ? " cv-queued-local" : "") },
      h("span", { class: "lbl" }, "Queued for after"),
      h("span", { class: "cv-queued-text ellipsis" }, q.text),
      btn("Edit", "cv-q-edit", "threads.edit", q, () => composer.editQueued(q)),
      btn("Take back", "cv-q-take", "threads.unqueue", q, () => queueAct("threads.unqueue", q)),
      btn("Steer now", "cv-q-now", "threads.send-now", q, () => queueAct("threads.send-now", q)),
    )));
  }
  /** @param {"threads.unqueue"|"threads.send-now"} tool @param {any} q */
  async function queueAct(tool, q) {
    if (q.queued == null) return;
    const r = await CAPS.use(tool, () => attempt(tool, { thread, queued: q.queued }));
    if (r.error) { if (!r.missing) { stop.error = (tool === "threads.send-now" ? "Could not steer: " : "Could not take it back: ") + (r.error.message || r.error.code); drawHead(); } drawQueued(); return; }
    // Already handed over (or never queued here): the box says so and the row is not taken.
    const d = /** @type {any} */ (r.data) || {};
    if (d.sent === false || (tool === "threads.unqueue" && Array.isArray(d.unqueued) && !d.unqueued.length)) {
      if (d.note) { stop.error = String(d.note); drawHead(); }
      return;
    }
    // Done: the row goes now (thread.unqueued says the same a moment later); taken back, the words return to the box.
    S.queued = S.queued.filter(x => x !== q);
    drawQueued();
    if (tool === "threads.unqueue" && !composer.value().trim()) composer.setText(q.text);
  }

  // ---- rewind (Esc Esc) --------------------------------------------------------------------

  /** A rewind this screen asked for: its message, while the box works on it. */
  let rewinding = /** @type {{ uuid: string, text: string, at: number|null }|null} */ (null);

  function openRewind() {
    if (rewind || !switchboard()) return;
    rewind = rewindSheet({
      points: checkpoints(S),
      can: () => CAPS.has("threads.rewind"),
      codeOk: () => CAPS.has(REWIND_CODE),
      onClose: closeRewind,
      // native-core's contract (docs/work/native-core.md, "Fork from here"): threads.fork's answer
      // is a thread record (`.id`, not `.thread` - checked against core/switchboard/index.js's
      // record()), so this opens exactly the way a new session from openHref does; the original
      // thread's own view is left untouched (no rewinding/patch() here, unlike onChoose above).
      onFork: async p => {
        const res = await CAPS.use("threads.fork", () => attempt("threads.fork", { thread, at: p.uuid }));
        if (res.error) return res.missing ? NEEDS_UPDATE : "Could not fork: " + (res.error.message || res.error.code);
        const href = openHref(res.data, record.current?.project || opts.project || null);
        if (!href) return "The fork started, but the server did not say which thread it is.";
        if (rewind) closeRewind();
        go(href);
        return null;
      },
      // Off until threads.fork is known to be there (no cheap way to probe it without a real fork's
      // side effect); becomes true the first time onFork above actually succeeds. Flagged to
      // native-core/sessions: unlike REWIND_CODE (piggybacks on threads.commands via LINKED),
      // nothing yet marks this true before a first real use, so the item may stay off indefinitely
      // on a box that has never forked - worth a LINKED entry once threads.fork's release is known.
      canFork: () => CAPS.has("threads.fork"),
      onChoose: async (p, restore) => {
        rewinding = { uuid: p.uuid, text: p.text, at: p.at };
        // Conversation is the box's default and all an older box does: sent without restore.
        const res = await CAPS.use("threads.rewind", () => attempt("threads.rewind", { thread, uuid: p.uuid, ...(restore !== "conversation" ? { restore } : {}) }));
        const was = rewinding;
        rewinding = null;
        if (res.error) return res.missing ? NEEDS_UPDATE : (restore === "code" ? "Could not restore the files: " : "Could not rewind: ") + (res.error.message || res.error.code);
        const d = /** @type {any} */ (res.data) || {};
        const uuid = d.uuid || was?.uuid || p.uuid;
        // Code only: the files went back, the conversation and the composer stay.
        if (restore === "code") {
          patch(applyStateEvent(S, { type: "thread.rewound", at: Date.now(), payload: { uuid, restore: "code", files: d.files || null, local: true } }));
          if (rewind) closeRewind();
          return null;
        }
        // The first message has nothing before it: the box says so (start a new session with it).
        if (d.rewound === false) {
          const f = filesNote(d.files);
          return String(d.note || "This message cannot be rewound to.") + (f ? ` ${f}.` : "");
        }
        // Same thread, back to just before it: thread.rewound takes the rows away (here too, in
        // case the event is late), and the words come back to the box to edit and send again.
        patch(applyStateEvent(S, { type: "thread.rewound", at: Date.now(), payload: { uuid, text: typeof d.text === "string" ? d.text : p.text,
          ...(d.files ? { files: d.files } : {}), local: true } }));
        composer.setText(typeof d.text === "string" ? d.text : p.text, "Prefilled from " + (p.at ? clock(p.at) : "the rewind"));
        if (rewind) closeRewind();
        return null;
      },
    });
    // Whether this box can put files back: learnt with threads.commands (a read, the same ship).
    if (CAPS.has(REWIND_CODE) === null) CAPS.use("threads.commands", () => attempt("threads.commands", { thread })).catch(() => {});
    rewindScrim.hidden = false;
    rewindBox.hidden = false;
    put(rewindBox, rewind.el);
    rewind.el.setAttribute("tabindex", "-1");
    rewind.el.focus?.();
  }
  function closeRewind() {
    rewind = null;
    rewindScrim.hidden = true;
    rewindBox.hidden = true;
    rewindBox.replaceChildren();
    composer.focus();
  }

  function setHideThinking(v) {
    hideThinking = v;
    try { localStorage.setItem(THINK_KEY, v ? "1" : "0"); } catch {}
    timeline.classList.toggle("cv-hide-thinking", v);
    drawHead();
  }
  timeline.classList.toggle("cv-hide-thinking", hideThinking);

  // ---- Stop -------------------------------------------------------------------------------

  /** Stop the turn: threads.interrupt (ADR 0030), or threads.stop on a Switchboard without it. */
  async function stopTurn() {
    if (stop.busy || !busy()) return;
    stop.busy = true; stop.error = null; stop.at = Date.now(); stop.via = "interrupt";
    let r = await attempt("threads.interrupt", { thread });
    if (r.error && (r.error.missing || r.error.code === "http_404")) { stop.via = "stop"; r = await attempt("threads.stop", { thread }); }
    stop.busy = false;
    if (r.error) { stop.at = 0; stop.error = "Could not stop: " + (r.error.message || r.error.code); drawHead(); }
  }

  // ---- raw -------------------------------------------------------------------------------

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
    put(rawBox, rawView(S.items.map(asBlock).filter(Boolean)));
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
    const r = await transcript({ before: first });
    if (r.error) { put(earlier, h("span", { class: "cv-note" }, "Could not load earlier.")); return; }
    const older = r.data.blocks.filter(b => first == null || b.seq < first);
    // What loads above keeps the reading position: the row at the top of the viewport is put back
    // from the new offsets (window-view.js), windowed or not, after this line has gone too.
    const keep = win.anchor();
    for (const k of applyBlocks(S, older)) changedKeys.add(k);
    layout();
    pin.set(S.todos);
    tray.set(S.tasks);
    first = typeof r.data.first === "number" ? r.data.first : older.length ? older[0].seq : 0;
    if (!older.length) first = 0;
    drawEarlier();
    win.restore(keep);
    rawSoon();
  }

  /**
   * The box's background tasks (threads.tasks, sessions 034c71e5): the tray starts from its list,
   * and the answer tells CAPS whether this box has that release (images, "!", "#", thinking, Stop).
   */
  async function readTasks() {
    if (!switchboard() || CAPS.has("threads.tasks") === false) return;
    const r = await CAPS.use("threads.tasks", () => attempt("threads.tasks", { thread }));
    const list = /** @type {any} */ (r.data)?.tasks;
    if (!r.error && Array.isArray(list)) patch(seedTasks(S, list));
  }

  // ---- rows from items -----------------------------------------------------------------------

  /** The session's folder, so paths inside it read relative ("menu.md", not the whole path). */
  const sessionCwd = () => record.current?.cwd || recorded.session?.cwd || null;
  /** A running call while the session waits on the person: its ask is open, so it is not working. */
  const waitingOn = it => it.status === "running" && S.state === "asking";

  /** Is there a message of the person's after this item (from the tail, so a last turn costs little)? */
  const saidAfter = it => { for (let i = S.items.length - 1; i >= 0; i--) { const x = S.items[i]; if (x === it) return false; if (x.kind === "user") return true; } return false; };

  /** An item as the block the renderers and the raw view know. */
  function asBlock(it) {
    const at = it.at;
    switch (it.kind) {
      case "user": return { kind: "user", text: it.text, command: it.command, ts: at, ...(it.images ? { images: it.images } : {}) };
      case "text": return { kind: "text", text: it.text, ts: at };
      case "reasoning": return { kind: "thinking", text: it.text, ts: at };
      case "tool": return { kind: "tool", id: it.call, tool: it.name, input: it.input, output: it.output ?? null, summary: it.summary,
        error: it.status === "failed" || (!!it.error && it.status !== "running"), duration_ms: it.duration_ms ?? null, ts: at, patch: it.patch,
        done: it.status !== "running", canceled: it.status === "canceled", cwd: sessionCwd(), waiting: waitingOn(it),
        ...(it.reply !== undefined ? { reply: it.reply } : {}), ...(it.images ? { images: it.images } : {}), ...(it.render ? { render: it.render } : {}) };
      // A turn the transcript has not closed is still going only while the session is busy and
      // nothing was said after it (a message sent now closes the one before, even unread yet).
      // auth: only an api-key turn is really billed by the number; a subscription runs on the
      // person's plan, and a $ figure there reads as a charge that never happens (the user's rule).
      case "turn": return { kind: "turn", ts: at, duration_ms: it.duration_ms, tokens: it.tokens, cost_usd: it.cost_usd, auth: S.auth || null, open: !!it.open && busy() && !saidAfter(it),
        canceled: it.canceled, byMe: byMe.has(it.key), error: it.error || (it.ok === false && !it.canceled ? (it.reason || "error") : null) };
      default: return null;
    }
  }
  /** What a row shows, so a patch that changed nothing visible does nothing. */
  const sig = it => JSON.stringify(it.kind === "tool" ? [it.status, it.summary, it.output, it.input, it.duration_ms, it.error, it.patch, it.reply, it.render]
    : it.kind === "ask" ? [it.state, it.decision, it.answers] : asBlock(it) || it);

  /** "Thinking · 8 s": until the next row began, when that is known. `i`: where it is in the items, when the caller knows. */
  function thinkLabel(it, i = S.items.indexOf(it)) {
    if (it.streaming) return "Thinking…";
    let nx = null;
    for (let j = i + 1; j < S.items.length; j++) if (S.items[j].at !== undefined) { nx = S.items[j]; break; }
    const ms = it.at !== undefined && nx ? nx.at - it.at : null;
    if (ms == null || ms < 1000 || ms >= 3_600_000) return "Thinking";
    return `Thinking · ${ms < 60_000 ? Math.round(ms / 1000) + " s" : duration(ms)}`;
  }

  /** The row for an item: made once, then patched. */
  function itemEl(it) {
    let el = els.get(it.key);
    if (el) return el;
    el = makeEl(it);
    el._sig = sig(it);
    els.set(it.key, el);
    return el;
  }
  function makeEl(it) {
    switch (it.kind) {
      case "user": {
        const who = labelFor({ role: "user", surface: it.surface }, names);
        const el = blockRow(asBlock(it), { who, me });
        /** @type {any} */ (el)._who = who;
        return el;
      }
      // A growing reply is heard by the resize observer; without one, a frame is asked for (coalesced).
      case "text": { const el = textItemRow(it.at, { visible, onGrow: stick.observing ? undefined : () => stick.poke() }); el.sync(it); return el; }
      case "reasoning": return thinkingRow(it.text, it.at, thinkLabel(it));
      // A teammate handoff (team_ask): its own card (teammates.md section 3), not the generic tool one.
      case "tool": return (it.name === "team_ask" || it.name === "team.ask") ? handoffCard({ ...asBlock(it), project: record.current?.project || opts.project || null }) : toolCard(asBlock(it));
      case "turn": return turnRow(asBlock(it));
      case "notice": return noticeMsg(it.text, it.at);
      case "ask": return askEl(it);
      case "steer": return steerEl(it);
      case "shell": return shellEl(it);
      default: return h("div", { class: "cv-row" });
    }
  }
  /** Bring a row up to its item. Returns the row (a new one when it had to be rebuilt). */
  function syncEl(el, it) {
    if (it.kind === "text") { el.sync(it); return el; }
    if (it.kind === "reasoning") { el.set(it.text, thinkLabel(it)); return el; }
    const s = sig(it) + (it.kind === "tool" && waitingOn(it) ? "w" : "");
    if (s === el._sig) return el;
    el._sig = s;
    if (it.kind === "tool") { el.update(asBlock(it)); return el; }
    if (it.kind === "ask") { settleAsk(el, it); return el; }
    const nel = makeEl(it);
    nel._sig = s;
    return nel;
  }

  /** Where typed words joined a running turn: "Steered at step 2 · 14:32", or "Steering" until it reads them. */
  function steerEl(it) {
    const words = it.pending ? `steering · ${agentName() || "Vyre"} reads it at its next step`
      : ["you steered here", it.step != null ? `after ${it.step} ${it.step === 1 ? "step" : "steps"}` : null, it.at ? clock(it.at) : null].filter(Boolean).join(" · ");
    return h("div", { class: "cv-row cv-steer" + (it.pending ? " cv-steer-pending" : ""), role: "separator", "aria-label": words },
      h("span", { class: "line" }),
      h("span", { class: "cv-steer-lbl" }, words),
      h("span", { class: "line" }));
  }
  /** A "!" command run in the session's folder, and what it printed. */
  function shellEl(it) {
    // Running: drawn here and neither answered nor echoed yet. A row from the transcript has no exit code.
    const state = it.error ? "failed" : it.local && !it.answered && !it.echoed ? "running" : it.exit ? "failed" : "done";
    return h("div", { class: "cv-row cv-shell", "data-state": state },
      h("div", { class: "cv-shell-head" },
        h("span", { class: "lbl" }, "Shell"), h("code", { class: "cv-shell-cmd ellipsis" }, it.command),
        h("span", { class: "cv-shell-meta" }, ["you", state === "running" ? "running" : null, it.duration_ms != null ? duration(it.duration_ms) : null,
          it.exit ? `exit ${it.exit}` : null].filter(Boolean).join(" · "))),
      it.error ? h("div", { class: "err cv-shell-err" }, it.error) : it.output ? outputEl(it.output, { err: !!it.exit }) : null);
  }

  // ---- asks ---------------------------------------------------------------------------------

  function askData(id, it) {
    const info = askInfo.get(id) || {};
    return { id, tool: it?.tool ?? info.tool ?? null, summary: it?.summary ?? info.summary ?? null, kind: info.kind || it?.askKind || "permission",
      ...info, agent: agentName(), cwd: sessionCwd(), ...macOf(info) };
  }
  /** A Mac session's ask: answered from here with its machine (the relayed event's, else the row's),
   * unless this box has shown it cannot forward answers (presence.js macAnswersHeld). */
  function macOf(info) {
    if (info.source !== "mac" && !isMac(where)) return {};
    const machine = info.machine || macName();
    return { machine, ...(macAnswersHeld() ? { elsewhere: machine } : {}) };
  }
  function askEl(it) {
    const full = askData(it.ask, it);
    const el = /** @type {any} */ (askCardFor(full, { thread }) || (isPlanAsk(full) ? planCard(full, { thread }) : full.kind === "question" ? questionCard(full) : askCard(full)));
    el._ask = full;
    cards.set(it.ask, el);
    settleAsk(el, it);
    if (it.state === "open" && typeof document !== "undefined" && !editable(document.activeElement)) el.focus?.({ preventScroll: true });
    return el;
  }
  function settleAsk(el, it) {
    if (it.state === "open") return;
    const by = askBy.get(it.ask);
    const from = by && by.by ? { where: SURFACES[by.by] || String(by.by), at: by.at } : null;
    el.answered?.(it.state === "cancelled" ? "cancelled" : it.decision, it.answers, from && !OURS.has(by.by) ? from : null);
  }

  /** A question or a permission ask from threads.asks or threads.get: its item, then its detail on the card. */
  function upsertAsk(a) {
    if (!a || !a.id) return;
    askInfo.set(a.id, { ...(askInfo.get(a.id) || {}), ...a });
    if (mode === "legacy") { legacyAsk(a); return; }
    if (!S.asks.has(a.id)) {
      patch(applyStateEvent(S, { type: "ask.raised", at: a.at ?? a.created_at ?? Date.now(), payload: { ask: a.id, kind: a.kind, tool: a.tool, summary: a.summary } }));
      return;
    }
    const el = cards.get(a.id);
    if (el) { const full = askData(a.id, S.byKey.get("a:" + a.id)); el.update(full); el._ask = { ...el._ask, ...full }; }
  }
  async function fetchAsks() {
    const r = await attempt("threads.asks", { thread });
    if (r.error || !Array.isArray(r.data)) return;
    for (const a of r.data) if (!a.thread || a.thread === thread) upsertAsk(a);
  }

  // ---- gates and facts ------------------------------------------------------------------------

  function upsertGate(id, live, at) {
    let g = gates.get(id);
    if (!g) { const el = gateCard({ id }); /** @type {any} */ (el)._kind = "card"; g = { id, el, at: at ?? null }; gates.set(id, g); }
    else if (live && /** @type {any} */ (g.el).refresh) /** @type {any} */ (g.el).refresh();
    return g;
  }

  // ---- layout: the order of rows, by reference -------------------------------------------------

  function dayLabel(at) {
    const d = new Date(at);
    const t = new Date(); t.setHours(0, 0, 0, 0);
    if (at >= t.getTime()) return "Today";
    const y = new Date(t); y.setDate(y.getDate() - 1);
    if (at >= y.getTime()) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  }
  const dayRule = d => h("div", { class: "day-rule" }, h("span", { class: "line" }), h("span", { class: "lbl" }, d), h("span", { class: "line" }));
  const sideOfItem = it => it.kind === "user" ? "user" : it.kind === "turn" ? "turn"
    : it.kind === "ask" || it.kind === "notice" || it.kind === "steer" || it.kind === "shell" ? null : "assistant";

  /** A fold row for a run of tool calls. */
  function runEl(r) {
    let el = runEls.get(r.key);
    if (!el) {
      const sum = h("span", { class: "cv-run-sum" });
      const meta = h("span", { class: "cv-run-meta" });
      const body = h("div", { class: "cv-run-body", hidden: true });
      const btn = h("button", { class: "cv-run-head", type: "button", "aria-expanded": "false", onclick: () => {
        if (openRuns.has(el._row.key)) openRuns.delete(el._row.key); else openRuns.add(el._row.key);
        el.draw();
      } }, h("span", { class: "cv-chev", "aria-hidden": "true" }, icon("right", 12)), sum, meta);
      el = /** @type {any} */ (h("div", { class: "cv-row cv-run" }, btn, body));
      el._kind = "assistant";
      el.draw = (now = Date.now()) => {
        const row = el._row;
        const items = row.keys.map(k => S.byKey.get(k)).filter(Boolean);
        el._ts = items[0]?.at ?? null;
        const running = items.find(t => t.status === "running");
        const isOpen = openRuns.has(row.key);
        const waiting = running && waitingOn(running);
        if (running) {
          const what = running.input && Object.keys(running.input).length ? toolTitle(running.name, running.input, sessionCwd()) : running.summary || "";
          sum.replaceChildren([toolVerb(running.name, "running"), what].filter(Boolean).join(" "));
          meta.replaceChildren(waiting ? "waiting on you" : running.at !== undefined ? elapsed(now - running.at) : "");
        } else {
          sum.replaceChildren(row.summary);
          const ms = items.reduce((n, t) => n + (typeof t.duration_ms === "number" ? t.duration_ms : 0), 0);
          meta.replaceChildren([ms ? duration(ms) : null, row.failed ? `${row.failed} failed` : null].filter(Boolean).join(" · "));
        }
        el.setAttribute("data-state", waiting ? "waiting" : running ? "running" : row.failed ? "failed" : "done");
        if (isOpen) el.setAttribute("data-open", ""); else el.removeAttribute("data-open");
        btn.setAttribute("aria-expanded", String(isOpen));
        body.hidden = !isOpen;
        if (isOpen) reconcile(body, items.map(itemEl));
      };
      runEls.set(r.key, el);
    }
    el._row = r;
    el.draw();
    return el;
  }

  /** Put `want` in `box` in that order, moving only what is out of place; anything else goes. */
  function reconcile(box, want) {
    let cur = box.firstChild;
    for (const el of want) {
      if (cur === el) { cur = cur.nextSibling; continue; }
      box.insertBefore(el, cur);
    }
    while (cur) { const n = cur.nextSibling; cur.remove(); cur = n; }
  }

  /**
   * The timeline's rows in order: day rules, a header per reply, items and fold rows, gates by
   * time, facts after their turn. Each row is a key and a way to make it; window-view.js mounts
   * only the rows near the viewport once there are more than 100, so a row's element is made (or
   * brought up to date) only when it is mounted.
   */
  function layout() {
    if (mode !== "blocks") return;
    // Only the runs the changed keys touch are grouped again (core/grouping.js createGrouper).
    const rows = grouper.rows(S.items, changedKeys);
    changedKeys.clear();
    runOf.clear();
    /** @type {import("./window-view.js").Row[]} */
    const want = [];
    const days = new Set();
    let lastDay = null, prevSide = null, turns = 0, running = false;
    const byTime = [...gates.values()].filter(g => g.at != null).sort((a, b) => a.at - b.at);
    let gi = 0;
    const usedHeads = new Set();
    /** Where each item is, for a thought's length (the next row's time), without a search per thought. */
    const where = new Map(S.items.map((it, i) => [it.key, i]));
    const gateRow = g => ({ key: "g:" + g.id, kind: "gate", make: () => g.el });
    const factRow = f => ({ key: "f:" + f.id, kind: "fact", make: () => f.el });
    const day = at => {
      if (!at) return;
      const d = dayLabel(at);
      if (d === lastDay || days.has(d)) { lastDay = d; return; }
      lastDay = d; days.add(d);
      want.push({ key: "d:" + d, kind: "day", make: () => { let el = dayEls.get(d); if (!el) { el = dayRule(d); dayEls.set(d, el); } return el; } });
    };
    for (const r of rows) {
      const firstItem = S.byKey.get(r.type === "run" ? r.keys[0] : r.key);
      if (!firstItem) continue;
      const at = firstItem.at;
      while (gi < byTime.length && at !== undefined && byTime[gi].at < at) want.push(gateRow(byTime[gi++]));
      const side = r.type === "run" ? "assistant" : sideOfItem(firstItem);
      if (side === "user") day(at);
      if (side === "assistant" && prevSide !== "assistant") {
        day(at);
        const rk = r.key;
        usedHeads.add(rk);
        want.push({ key: "h:" + rk, kind: "head", make: () => { let hd = headEls.get(rk); if (!hd) { hd = headFor(at); headEls.set(rk, hd); } return hd; } });
      }
      if (side) prevSide = side;
      if (r.type === "run") {
        for (const k of r.keys) runOf.set(k, r.key);
        want.push({ key: r.key, kind: "run", make: () => runEl(r) });
        if (r.running) running = true;
        continue;
      }
      const it = firstItem;
      want.push({ key: it.key, kind: it.kind, make: () => {
        const el = itemEl(it);
        if (it.kind === "reasoning") el.set(it.text, thinkLabel(it, where.get(it.key)));
        return el;
      } });
      if (it.kind === "tool" && it.status === "running") running = true;
      if (it.kind === "turn") { turns++; for (const f of facts) if (f.n === turns) want.push(factRow(f)); }
    }
    while (gi < byTime.length) want.push(gateRow(byTime[gi++]));
    for (const g of gates.values()) if (g.at == null) want.push(gateRow(g));
    for (const f of facts) if (f.n > turns || !f.n) want.push(factRow(f));
    for (const k of [...headEls.keys()]) if (!usedHeads.has(k)) headEls.delete(k);
    win.set(recorded.on && !S.items.length ? [earlier, rawBox, waitNote] : [earlier, rawBox], want);
    if (running) ticker();
  }

  /**
   * A row that left the window: let it go, unless it holds something a rebuild would lose (an
   * ask's card, a reply still streaming). It is made again from its item when it comes back.
   */
  function unmounted(key, el) {
    if (key.startsWith("h:")) { headEls.delete(key.slice(2)); return; }
    if (key.startsWith("d:") || key.startsWith("g:") || key.startsWith("f:")) return;
    if (runEls.get(key) === el) {
      runEls.delete(key);
      for (const k of /** @type {any} */ (el)._row?.keys || []) forget(k);
      return;
    }
    forget(key);
  }
  function forget(key) {
    const it = S.byKey.get(key);
    const el = els.get(key);
    if (!el || !it || it.kind === "ask" || (it.kind === "text" && it.streaming)) return;
    el.stop?.();
    els.delete(key);
  }

  /** Running rows count up once a second, while one runs and the page is on screen. */
  let tickTimer = null;
  function ticker() {
    if (tickTimer) return;
    tickTimer = setTimeout(() => {
      tickTimer = null;
      const live = S.items.filter(it => it.kind === "tool" && it.status === "running");
      if (!live.length) return;
      if (visible()) {
        const now = Date.now();
        for (const it of live) { const rk = runOf.get(it.key); if (rk) runEls.get(rk)?.draw(now); else els.get(it.key)?.tick?.(now); }
      }
      ticker();
    }, 1000);
  }

  /** Items changed since the last layout, for the incremental grouping. */
  const grouper = createGrouper();
  const changedKeys = new Set();
  let lastState = /** @type {string|null} */ (null);
  /** Changed keys from session-state: rows patched in place; the order laid out again only when a row came, went or moved. */
  function patch(keys) {
    if (!keys.length) return;
    for (const k of keys) changedKeys.add(k);
    let order = false;
    for (const k of keys) {
      if (k === "@session") {
        if (!booted) continue;
        drawHead();
        // Waiting on the person or working again: the running calls say which (no clock while waiting).
        if (S.state !== lastState) {
          lastState = S.state;
          for (const it of S.items) {
            if (!((it.kind === "tool" && it.status === "running") || (it.kind === "turn" && it.open))) continue;
            const el = els.get(it.key);
            if (!el) continue;
            const nel = syncEl(el, it);
            if (nel !== el) { els.set(it.key, nel); if (el.parentNode) el.replaceWith(nel); }
          }
          order = true;
        }
        continue;
      }
      if (k === "@queued") { drawQueued(); continue; }
      if (k === "@todos") { pin.set(S.todos); continue; }
      if (k === "@tasks") { tray.set(S.tasks); continue; }
      // A rewind: its rows are gone (the keys say so); the words go back to the box from the answer.
      if (k === "@rewound") continue;
      const it = S.byKey.get(k);
      if (!it) { const gone = els.get(k); if (gone) { gone.stop?.(); els.delete(k); } order = true; continue; }
      if (it.kind === "turn" && it.canceled && stop.at && Date.now() - stop.at < STOP_MS && !byMe.has(k)) { byMe.add(k); stop.at = 0; }
      const el = els.get(k);
      if (!el) { order = true; continue; }
      const nel = syncEl(el, it);
      if (nel !== el) { els.set(k, nel); if (el.parentNode) el.replaceWith(nel); }
      if (it.kind !== "text") order = true; // a tool's state changes its run's summary; a thought's length its label
    }
    if (order && booted) layout();
    rawSoon();
  }

  // ---- reading more of the transcript -----------------------------------------------------------

  /** Costs from thread.finished go on the turns they belong to: the latest turn that began before the event. */
  function applyCosts(done) {
    const turns = S.items.filter(it => it.kind === "turn");
    for (const f of done) {
      if (typeof f.cost_usd !== "number" || f.cost_usd <= 0) continue;
      const t = turns.filter(x => x.at && x.at <= f.at + 5_000 && f.at - x.at < (x.duration_ms || 0) + 120_000).pop();
      if (t) /** @type {any} */ (t).cost_usd = f.cost_usd;
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
        const r = await transcript({ from: next });
        if (r.error) break;
        if (r.data.session && recorded.on) { recorded.session = r.data.session; drawHead(); }
        // patch() already lays out again itself whenever a changed key needs it (any kind but a
        // streaming text update); calling layout() again here unconditionally was a second,
        // redundant anchor-capture-and-restore right after the first, on rows already correctly
        // measured. Cuts the reconnect catch-up time (native-bar budget 8): 1086 ms -> 900 ms,
        // under its 1 s budget. The scroll jump itself is a separate cause: still open.
        // grew() alone still covers the one case patch() skips (a batch of text-only deltas).
        patch(applyBlocks(S, r.data.blocks));
        if (r.data.blocks.length) grew();
        next = r.data.next ?? next;
        if (r.data.blocks.length >= page()) reading.again = true;
      } while (reading.again);
    } finally { reading.busy = false; }
  }

  // ---- events -----------------------------------------------------------------------------------

  const QUEUE_ONLY = new Set(["thread.queued", "thread.unqueued"]);
  function onEvent(e, live) {
    const p = e.payload || {};
    // A message queued for a session busy in the terminal (capsule-now): the terminal session stays
    // the user's own, and its transcript (read on session.indexed) already shows the message and
    // the reply. So while it is read from the transcript, the queue's events are not drawn twice;
    // only the queue above the composer follows them.
    const queueFlow = e.type === "thread.queued" || p.queued != null || p.via === "stop" || p.via === "prompt" || p.via === "terminal"
      || (typeof p.message === "string" && p.message.startsWith("inbox-"));
    if (recorded.on && queueFlow && !isMac(where) && mode === "blocks") {
      if (QUEUE_ONLY.has(e.type)) patch(applyStateEvent(S, e));
      else if (e.type === "thread.sent" && p.queued != null) { S.queued = S.queued.filter(q => q.queued !== p.queued); drawQueued(); }
      return;
    }
    if (recorded.on && queueFlow && !isMac(where)) return;
    // The first live event for a recorded session: a send adopted it, so the Switchboard has it now.
    if (live && recorded.on && !isMac(where) && /^(thread|lease)\./.test(e.type)) {
      recorded.on = false;
      attempt("threads.get", { thread, since: 0, limit: 1 }).then(r => { if (r.data) { record.current = r.data.thread; drawHead(); } });
    }
    if (mode === "legacy") { onLegacyEvent(e, live); return; }
    if (e.type === "ask.raised") {
      askInfo.set(p.ask, { ...(askInfo.get(p.ask) || {}), id: p.ask, tool: p.tool, summary: p.summary, destination: p.destination, reason: p.reason, kind: p.kind,
        ...(p.questions ? { questions: p.questions } : {}) });
      patch(applyStateEvent(S, e));
      fetchAsks();
      return;
    }
    if (e.type === "ask.answered" || e.type === "ask.cancelled") {
      askBy.set(p.ask, { by: p.by || null, at: e.at || Date.now() });
      patch(applyStateEvent(S, e));
      return;
    }
    if (e.type === "thread.stopped" && stop.at && stop.via === "stop") {
      // Stopped the older way (threads.stop ends the process): the open turn ends as stopped.
      const last = [...S.items].reverse().find(it => it.kind === "user" || it.kind === "turn");
      if (last && last.kind === "user") patch(applyStateEvent(S, { type: "thread.finished", at: e.at, payload: { ok: false, canceled: true, reason: "interrupt" } }));
    }
    if (/^thread\./.test(e.type) || e.type === "mode.changed" || e.type === "model.switched" || e.type === "model.changed" || e.type === "thinking.switched") {
      patch(applyStateEvent(S, e));
      if (e.type === "thread.finished" && !replaying) refresh();
      return;
    }
    if (e.type === "gate.held" || e.type === "gate.revised") { upsertGate(p.id, live, e.at); layout(); return; }
    if (e.type === "gate.released" || e.type === "gate.rejected") { const g = gates.get(p.id); if (g && /** @type {any} */ (g.el).refresh) /** @type {any} */ (g.el).refresh(); return; }
    if (e.type === "lease.changed") { drawHead(); return; }
  }

  // ---- the earlier view (a box without recall.transcript) -------------------------------------

  const legacyRows = new Map();
  /** @type {Map<number, HTMLElement>} Switchboard turn number -> the element a fact for it goes after (legacy) */
  const turnMarkers = new Map();
  let turnSeq = 0;
  let legacyDay = null;
  function legacyDayRule(at, /** @type {any} */ into = timeline) {
    const d = dayLabel(at);
    if (d === legacyDay) return;
    legacyDay = d;
    into.append(dayRule(d));
  }
  let lastMessageEl = null, lastMessageId = null;
  const toolKeys = [];
  async function legacyBoot(r) {
    mode = "legacy";
    if (opts.recorded || r.error) {
      const onMacNow = isMac(where);
      const src = onMacNow ? { source: "mac" } : {};
      let from = (opts.recorded || onMacNow) && (opts.turns || 0) > WINDOW ? /** @type {number} */ (opts.turns) - WINDOW : 0;
      let t = await attempt("recall.thread", { session: thread, from, limit: 400, ...src });
      // The list's count and the transcript's numbering disagree: read it from the start.
      if (!t.error && from > 0 && !t.data.turns.length) { t = await attempt("recall.thread", { session: thread, limit: 400, ...src }); from = 0; }
      if (t.error) { booted = true; timeline.replaceChildren(empty("Could not open this session.", t.error)); drawHead(); return; }
      recorded.on = true;
      recorded.session = t.data.session;
      // A session the list did not know may turn out to be the Mac's from the answer itself.
      if (isMac(t.data)) { where.source = "mac"; where.machine = t.data.machine || where.machine; onMac(); }
      drawHead();
      timeline.replaceChildren();
      if (from > 0) timeline.append(earlierTurns(from));
      if (!t.data.turns.length) timeline.append(h("div", { class: "empty th-wait" }, "Nothing was said in this session yet."));
      appendTurns(t.data.turns);
      booted = true;
      for (const e of early.splice(0)) onLive(e);
      toBottom();
      seek();
      return;
    }
    drawHead();
    timeline.replaceChildren();
    for (const e of r.data.events) onEvent(e, false);
    for (const a of r.data.asks) upsertAsk(a);
    booted = true;
    for (const e of early.splice(0)) onLive(e);
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
      const saveNext = recorded.next, saveDay = legacyDay;
      legacyDay = null;
      appendTurns(t.data.turns, holder);
      recorded.next = saveNext; legacyDay = saveDay;
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
      legacyDayRule(t.ts || Date.now(), into);
      if (t.role === "user") { into.append(userRow("you", t.text, t.ts, me)); continue; }
      into.append(headFor(t.ts), blockRow({ kind: "text", text: t.text, ts: t.ts }));
    }
  }
  /** Live rows drawn for a Mac session, replaced by the turns the next re-read brings. */
  const macLive = /** @type {Element[]} */ ([]);
  function liveAppend(/** @type {any[]} */ ...els) { timeline.append(...els); if (isMac(where)) macLive.push(...els); }
  async function readMoreLegacy() {
    if (!recorded.on && !isMac(where)) return;
    if (recorded.busy) { recorded.again = true; return; }
    recorded.busy = true;
    try {
      do {
        recorded.again = false;
        const r = await attempt("recall.thread", { session: thread, from: recorded.next, limit: 400, ...(isMac(where) ? { source: "mac" } : {}) });
        if ((!recorded.on && !isMac(where)) || r.error) break;
        if (r.data.turns.length) timeline.querySelector(".th-wait")?.remove();
        // The Mac's turns stand in for what was drawn live, so nothing shows twice.
        if (r.data.turns.length && macLive.length) { for (const el of macLive.splice(0)) { el.remove(); for (const [k, v] of legacyRows) if (v === el) legacyRows.delete(k); } lastMessageEl = null; lastMessageId = null; }
        if (r.data.session) { recorded.session = r.data.session; drawHead(); }
        appendTurns(r.data.turns);
        if (r.data.turns.length) grew();
      } while (recorded.again);
    } finally { recorded.busy = false; }
  }
  function onLegacyEvent(e, live) {
    const p = e.payload || {};
    if (e.type === "thread.sent") {
      legacyDayRule(e.at);
      liveAppend(userRow(labelFor({ role: "user", surface: p.surface }, names), p.text, e.at, me));
      lastMessageEl = null; lastMessageId = null;
      // A queued message handed over on the Mac: its turn is in the transcript now.
      if (isMac(where) && (p.queued != null || p.via)) readMoreLegacy();
      return;
    }
    if (e.type === "thread.text") {
      legacyDayRule(e.at);
      if (p.notice) { liveAppend(noticeMsg(p.text, e.at)); return; }
      if (p.message !== lastMessageId) {
        lastMessageId = p.message;
        liveAppend(headFor(e.at));
        lastMessageEl = liveTextRow(e.at);
        liveAppend(lastMessageEl);
      }
      if (p.delta) lastMessageEl.push(p.delta);
      if (p.done && p.text) { lastMessageEl.set(p.text); lastMessageEl.done(); }
      return;
    }
    if (e.type === "thread.tool") {
      const key = "tool:" + p.id;
      if (p.phase === "started") {
        if (legacyRows.has(key)) return;
        const b = { kind: "tool", id: p.id, tool: p.tool, summary: p.summary, destination: p.destination, ts: e.at, output: null };
        const el = /** @type {any} */ (toolCard(b)); el._block = b;
        legacyRows.set(key, el); liveAppend(el);
        toolKeys.push(key);
        while (toolKeys.length > 6) { const old = toolKeys.shift(); legacyRows.get(old)?.remove(); legacyRows.delete(old); }
      } else {
        const el = legacyRows.get(key);
        if (el) { el._block = { ...el._block, done: true, error: !!p.error, duration_ms: e.at - el._block.ts }; el.update(el._block); }
      }
      return;
    }
    if (e.type === "thread.finished") {
      if (lastMessageEl) lastMessageEl.done();
      if (!p.ok || p.error) liveAppend(h("div", { class: "turn-foot" }, h("span", { class: "err" }, "turn failed: " + (p.error || p.stop_reason || "error"))));
      liveAppend(turnRow({ ts: e.at, duration_ms: p.duration_ms, tokens: p.tokens, cost_usd: p.cost_usd }));
      turnSeq++;
      turnMarkers.set(turnSeq, timeline.lastElementChild);
      if (isMac(where)) readMoreLegacy();
      return;
    }
    if (e.type === "thread.stopped") { timeline.append(h("div", { class: "turn-foot" }, icon("terminal", 12), "session stopped" + (p.reason ? ": " + p.reason : ""))); return; }
    if (e.type === "ask.raised") {
      // A relayed Mac ask carries source "mac", machine and node (the Mac's stableId); threads.asks on the box does not list it.
      upsertAsk({ id: p.ask, tool: p.tool, summary: p.summary, destination: p.destination, reason: p.reason, kind: p.kind, questions: p.questions,
        ...(p.source === "mac" ? { source: "mac", machine: p.machine || macName(), node: p.node ?? null,
          ...Object.fromEntries(["detail", "always", "always_project"].filter(k => p[k] !== undefined).map(k => [k, p[k]])) } : {}) });
      fetchAsks();
      return;
    }
    if (e.type === "ask.answered") {
      const el = cards.get(p.ask);
      const from = p.by && !OURS.has(p.by) ? { where: SURFACES[p.by] || String(p.by), at: e.at } : null;
      if (el?.answered) el.answered(p.decision, p.answers, from); else if (el) el.remove();
      return;
    }
    if (e.type === "gate.held" || e.type === "gate.revised") { const g = upsertGate(p.id, live, e.at); if (!g.el.parentNode) timeline.append(g.el); return; }
    if (e.type === "gate.released" || e.type === "gate.rejected") { const g = gates.get(p.id); if (g && /** @type {any} */ (g.el).refresh) /** @type {any} */ (g.el).refresh(); return; }
    if (e.type === "lease.changed") { drawHead(); return; }
  }
  /** The earlier view's cards: appended, then filled in. */
  function legacyAsk(a) {
    const info = askInfo.get(a.id) || {};
    const full = { ...info, agent: agentName(), cwd: sessionCwd(), ...macOf(info) };
    let el = cards.get(a.id);
    if (el) { el.update(full); el._ask = { ...el._ask, ...full }; return; }
    el = /** @type {any} */ (askCardFor(full, { thread }) || (isPlanAsk(full) ? planCard(full, { thread }) : a.kind === "question" ? questionCard(full) : askCard(full)));
    el._ask = full;
    cards.set(a.id, el);
    timeline.append(el);
    if (!editable(document.activeElement)) el.focus?.({ preventScroll: true });
  }

  // ---- keys ---------------------------------------------------------------------------------------

  /** The card a key belongs to: the one with focus, or the newest open one on screen. */
  function cardFor(target) {
    const own = target && target.closest ? target.closest(".cv-q, .cv-ask") : null;
    if (own && own.isOpen && own.isOpen()) return own;
    for (const el of [...cards.values()].reverse()) if (el.isOpen && el.isOpen() && el.parentNode) return el;
    return null;
  }
  const onKey = (/** @type {KeyboardEvent} */ e) => {
    // The shell keeps pages mounted while away (deck/js/app.js): keys belong to the page on screen.
    if (e.defaultPrevented || !container.isConnected || container.closest?.(".away")) return;
    if (opts.shown && !opts.shown()) return;
    const t = /** @type {any} */ (e.target);
    if (editable(t)) return; // the composer (its own keys), the "Other" field, the deny reason: their own keys
    if (t && (t.tagName === "BUTTON" || t.tagName === "A") && (e.key === "Enter" || e.key === " ")) return; // the focused control's own press
    if (rewind && rewind.key(e)) { e.preventDefault(); return; }
    // Cmd/Ctrl+Enter is a plan card's Start building (plan-card.md); every other modified key is the composer's.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { const c = cardFor(t); if (c?.classList?.contains("cv-plan") && c.onKey(e)) { e.preventDefault(); return; } }
    // Ctrl+O, Ctrl+B, Alt+T and the like: the composer's page-wide keys, never a card's.
    if (e.metaKey || e.ctrlKey || e.altKey) { if (composer.key(e)) e.preventDefault(); return; }
    const card = cardFor(t);
    if (card && card.onKey(e)) { e.preventDefault(); return; }
    // Esc stops (Esc Esc rewinds), Shift+Tab the next mode: the same keys as in the box.
    if (composer.key(e)) e.preventDefault();
  };
  document.addEventListener("keydown", onKey);
  // Ctrl+M's release (native-core's voice.js): the textarea's own keyup handles the focused
  // case; this is the same key everywhere else in the session view, same guard as onKey above.
  const onKeyUp = (/** @type {KeyboardEvent} */ e) => {
    if (e.defaultPrevented || !container.isConnected || container.closest?.(".away")) return;
    if (opts.shown && !opts.shown()) return;
    if (editable(/** @type {any} */ (e.target))) return;
    if (composer.keyUp?.(e)) e.preventDefault();
  };
  document.addEventListener("keyup", onKeyUp);
  /** Back on screen: streaming replies catch up at the display rate. */
  const onVisible = () => { if (visible()) for (const el of els.values()) el.kick?.(); };
  document.addEventListener("visibilitychange", onVisible);

  // ---- a deep link: /chat/thread/<id>?at=<ms>&ask=<id>&tool=<tool_use_id> ---------------------

  function linkTarget() {
    let q = null;
    try { q = new URLSearchParams(location.search); } catch {}
    const num = v => (v == null || v === "" || !isFinite(Number(v)) ? null : Number(v));
    return { at: opts.at ?? num(q?.get("at")), ask: opts.ask ?? (q?.get("ask") || null), tool: opts.tool ?? (q?.get("tool") || null) };
  }
  /**
   * An item's row, its fold opened first when it is inside one. In a long session the row may not
   * be mounted: its stretch is mounted first (window-view.js), and the reader is no longer
   * following the tail, so the view stays on it.
   */
  function reveal(key) {
    if (mode !== "blocks") return legacyRows.get(key.replace(/^t:/, "tool:")) || null;
    const rk = runOf.get(key);
    if (rk && !openRuns.has(rk)) { openRuns.add(rk); runEls.get(rk)?.draw(); }
    const was = stick.stuck;
    stick.detach();
    const row = win.reveal(rk || key);
    if (!row) { if (was) stick.stick(); return els.get(key) || null; }
    return els.get(key) || row;
  }
  /** Scroll to the linked row and flash it: an ask's card (or its anchored tool call), a tool call, else the first row at or after `at`. */
  let sought = false;
  function seek() {
    if (sought) return;
    const want = linkTarget();
    if (want.at == null && !want.ask && !want.tool) return;
    sought = true;
    const card = want.ask ? cards.get(want.ask) : null;
    const anchor = card?._ask?.anchor?.tool_use_id || askInfo.get(want.ask)?.anchor?.tool_use_id || want.tool;
    let el = card && card.isOpen?.() ? card : null;
    if (el) reveal("a:" + want.ask);
    if (!el && anchor) el = reveal("t:" + anchor);
    if (!el && card) { reveal("a:" + want.ask); el = card; }
    if (!el && want.at != null) {
      if (mode === "blocks") { const it = S.items.find(i => i.at !== undefined && i.at >= /** @type {number} */ (want.at)); if (it) el = reveal(it.key) || els.get(runOf.get(it.key)); }
      else for (const n of timeline.children) { if (n._ts && n._ts >= want.at) { el = n; break; } }
    }
    if (!el) return;
    stick.detach();
    el.scrollIntoView?.({ block: "center" });
    el.classList.add("cv-flash");
    setTimeout(() => el.classList.remove("cv-flash"), FLASH_MS);
  }

  // ---- shared pieces ------------------------------------------------------------------------

  /**
   * Tell the box which thread is open here (cohesion's context.report), so "what am I working on"
   * follows the screen. Once per open; a box without the tool answers no_such_tool and nothing
   * changes. Only a person's surface calls it (the tool refuses a model).
   */
  let reported = false;
  function report() {
    if (reported || recorded.on) return;
    reported = true;
    const rec = record.current;
    attempt("context.report", { surface: "chat", view: "chat", thread, ...(rec?.project ? { project: rec.project } : {}), ...(rec?.cwd ? { cwd: rec.cwd } : {}) });
  }

  /** To the bottom now, and stuck there (Jump to latest, open, a sent message). */
  function toBottom() { stick.stick(); jump.hidden = true; }
  /**
   * Something was added. The resize observer hears the rows window-view mounts; the earlier view
   * appends its own rows, and without an observer nothing hears them: one frame is asked for,
   * which sticks or, detached, shows the pill when the content grew. No layout read here.
   */
  function grew() { if (mode === "legacy" || !stick.observing) stick.poke(); }

  function noticeMsg(text, at) {
    return h("div", { class: "gate-note cv-notice" }, icon("clock", 12), " ", text, " ", h("span", { class: "msg-when" }, clock(at)));
  }

  // A memory fact, intelligence's real shape (memory.facts): {id, text, subject, rel, object,
  // confidence, age, stale, source, refs: [{seq}]}. Lessons are a different system and are never
  // rendered as memory facts; only what memory.facts returns is.
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
    const n = refs.reduce((m, r) => Math.max(m, r.seq || 0), 0);
    const el = factCard(f);
    if (mode === "blocks") { facts.push({ el, n, id: String(f.id) }); return; }
    const marker = n ? turnMarkers.get(n) : null;
    if (marker && marker.parentNode === timeline) timeline.insertBefore(el, /** @type {any} */ (marker).nextSibling); else timeline.append(el);
  }
  async function fetchMemory() {
    const r = await attempt("memory.facts", { thread, ...(record.current?.project ? { room: record.current.project } : {}), limit: 50 });
    if (r.error || !r.data || !r.data.facts) return;
    let added = false;
    for (const f of r.data.facts) {
      if (shownFacts.has(f.id)) continue;
      shownFacts.add(f.id);
      insertFact(f);
      added = true;
    }
    if (!added) return;
    layout();
    grew();
  }

  boot();

  /** A live event for this thread. What it adds follows the bottom or shows the pill; a message
   * typed into the session (here or elsewhere) brings the reader down to it. */
  function onLive(e) {
    if (e.thread !== thread) return;
    if (!booted) { early.push(e); return; }
    onEvent(e, true);
    if (e.type === "thread.sent") toBottom(); else grew();
  }
  /**
   * The stream came back after a drop, or vyred reset it (its log is behind this tab's cursor,
   * ADR 0029 R1): read again what may have been missed. threads.get's events since the last one
   * applied (the queue, the state, live items), threads.asks, and the transcript from `next`,
   * each merged through session-state, which drops an event id it applied already and swaps a
   * live item for its block under the same key, so nothing is missing or shown twice. A reset's
   * ids start again below what this view saw, so its floor drops to vyred's.
   */
  const resuming = { busy: false, again: false, reset: /** @type {number|null} */ (null) };
  async function resume(/** @type {"reconnect"|"reset"} */ why, /** @type {number|undefined} */ from) {
    if (why === "reset" && typeof from === "number" && Number.isFinite(from)) {
      resuming.reset = resuming.reset == null ? from : Math.min(resuming.reset, from);
      if (S.meta.lastId > from) S.meta.lastId = from;
    }
    if (!booted) return;
    if (resuming.busy) { resuming.again = true; return; }
    resuming.busy = true;
    try {
      do {
        resuming.again = false;
        await reread();
      } while (resuming.again);
    } finally { resuming.busy = false; resuming.reset = null; }
  }
  async function reread() {
    if (mode !== "blocks") {
      fetchAsks();
      if (recorded.on || isMac(where)) await readMoreLegacy();
      return;
    }
    if (switchboard() && !recorded.on && !isMac(where)) {
      const since = resuming.reset != null ? resuming.reset : Number.isFinite(S.meta.lastId) ? S.meta.lastId : 0;
      const r = await attempt("threads.get", { thread, since, limit: 500 });
      if (!r.error && r.data) {
        const data = /** @type {any} */ (r.data);
        if (data.thread) {
          record.current = data.thread;
          const st = data.thread.canonical_status || data.thread.state;
          // A state word the events will not repeat: the record's, unless an event said it since.
          if (st && !(data.events || []).some(e => e.type === "thread.status" || e.type === "thread.state")) S.state = st;
        }
        replaying = true;
        try { for (const e of data.events || []) if (!e.thread || e.thread === thread) onEvent(e, false); } finally { replaying = false; }
        for (const a of data.asks || []) upsertAsk(a);
        drawHead();
        drawQueued();
        grew();
      }
    }
    await Promise.all([fetchAsks(), refresh()]);
  }

  const offs = [
    onResume((why, from) => { resume(why, from); }),
    on("thread.*", onLive),
    // Not a thread.* name: heard on its own.
    on("mode.changed", onLive),
    on("model.switched", onLive),
    on("thinking.switched", onLive),
    // Older boxes said model.changed for a thread's model.
    on("model.changed", onLive),
    on("ask.raised", onLive),
    on("ask.answered", onLive),
    on("ask.cancelled", onLive),
    on("gate.held", onLive),
    on("gate.revised", onLive),
    on("gate.released", onLive),
    on("gate.rejected", onLive),
    on("lease.changed", onLive),
    // memory.curated carries no thread: refetch this open thread and let the id dedup filter it.
    on("memory.curated", () => fetchMemory()),
    // Filed into a project (projects.add-threads, or made into one): the project's tile from now on.
    on("thread.picked", e => { if ((e.payload?.thread || e.thread) === thread) void refile(e.payload?.project); }),
    on("session.indexed", e => { if ((e.thread || e.payload?.session) !== thread) return; if (mode === "blocks") refresh(); else readMoreLegacy(); }),
    // Heard through "thread.*" above; named here so the stream listens for them at all.
    ...MORE_EVENTS.map(name => on(name, () => {})),
    capsOff,
  ];
  // The phone keyboard (js/keyboard.js) lifted or dropped the composer, and the transcript's
  // bottom padding (chat.css) moved with it: scroll by as much, in the same frame, so the lines
  // above the composer stay put. Following the bottom, stay at the bottom.
  let pad = -1;
  const padNow = () => parseFloat(getComputedStyle(timeline).paddingBottom) || 0;
  const onFocus = () => { if (pad < 0) pad = padNow(); };
  const onKb = () => {
    if (!timeline.isConnected) return;
    const p = padNow();
    if (stick.stuck) toBottom(); else if (pad >= 0) timeline.scrollTop += p - pad;
    pad = p;
  };
  container.addEventListener("focusin", onFocus);
  window.addEventListener("deck:kb", onKb);
  offs.push(() => { container.removeEventListener("focusin", onFocus); window.removeEventListener("deck:kb", onKb); });
  return () => {
    health.stop(); for (const off of offs) off(); composer.stop(); stick.stop(); win.stop(); tip?.stop();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("keyup", onKeyUp);
    document.removeEventListener("visibilitychange", onVisible);
    if (rawTimer) clearTimeout(rawTimer);
    if (tickTimer) clearTimeout(tickTimer);
    for (const el of els.values()) el.stop?.();
  };
}

/** The last two folders of a path, which is what tells sessions apart: …/alex/Work. */
function shortDir(d) {
  if (!d) return "";
  const parts = String(d).split("/").filter(Boolean);
  return (parts.length > 2 ? "…/" : "/") + parts.slice(-2).join("/");
}

