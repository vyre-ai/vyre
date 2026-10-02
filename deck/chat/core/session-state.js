// @ts-check
// Derived in part from Paseo (https://github.com/getpaseo/paseo), packages/app/src/timeline/session-stream-reducers.ts
// and packages/app/src/agent-stream/model.ts, Copyright (c) 2025-present Mohamed Boudra, Apache License 2.0.
// Modified for Vyre: plain JS, keyed items patched in place instead of a head/tail split, the Switchboard's
// thread.* events (old and ADR 0030 shapes) and recall.transcript blocks as the two inputs.
//
// One session as a view reads it: the ordered items (what the user said, the model's text and
// reasoning, each tool call, turn markers, notices, asks), the queue, the open asks and the
// session's header (provider, model, state, usage, limit). Two inputs feed it: live thread.*
// events (applyEvent) and a rich read of the transcript (applyBlocks). Both mutate the state and
// return the keys they touched, so a view patches only those rows. Shared core: no DOM and no
// Node APIs, so the Deck and an Expo app import this file as it is.
//
// Keys are stable. A live item that the transcript later describes keeps its key and its place;
// only its fields become the transcript's (richer: tool input and output, redacted text). A block
// read twice is applied once. Keys starting with "@" in a returned list are not items: "@session"
// (the header fields: provider, model, mode, thinking, state), "@queued" (the queue), "@todos"
// (the latest todo list), "@tasks" (background tasks) and "@rewound" (a rewind just happened:
// s.rewound says to which message, so a composer can take its words back).
//
// The sessions contract (core/switchboard, work/sessions b8b1a0a7 and 045d3472):
//
// Steering (the composer's default while a turn runs): the words join the running turn at its
// next step. A steer is a user item plus a marker item just before it ("Steered at step N", key
// steer:<uuid>), placed where the words joined: localSend() draws both at once ("steering"),
// thread.sent {via: "steer", uuid} (or "now", a queued row sent into the turn) echoes them, and
// thread.steered {uuid} says Claude took them in: the marker is confirmed and moves to the turn's
// tail, with the step counted here (the tool calls of that turn finished when it arrives). The
// box mints the uuid, not the Deck: the send's answer {steered, uuid} (confirmSend) or its echo
// (same words) ties the drawn item to it. Steered words the turn never reached run as the next
// turn: thread.turn {steered: true, uuid, text} (text: every such steer, joined). Their markers
// go, the first becomes a plain message at the tail with that text, and the others fold into it,
// so nothing shows twice. A transcript user block with steered: true (core/transcripts) gets the
// marker on a re-read, with the transcript's step.
//
// The queue: rows are keyed by the box's threads_inbox row id (`queued`; the send's answer calls
// it queued_id), uuid alongside. thread.queued adds a row, or (threads.edit, edited: true)
// re-emits it with new words under the same id; thread.unqueued takes it away; thread.sent
// {queued, via: "turn"} hands it over at a turn's end (a message of its own) and {queued, via:
// "now"} (threads.send-now) steers it into the running turn, or starts a turn when none runs.
//
// A rewind (threads.rewind, thread.rewound {uuid, at: <its parent's uuid>}) is not a fork: the
// same thread goes back to just before that message. The message and everything after it leave
// the view, and later reads of the transcript (which keeps the abandoned branch) skip them too:
// the blocks from that message on written before the rewind. s.rewound carries the words back.
// restore (work/sessions 7543952e): "conversation" (the default, and all an older box does),
// "code" (the files its tools changed since that message go back; the conversation and the view
// stay as they are, so nothing is dropped and no branch is abandoned) or "both". files
// {restored, files_changed, why} says how the files went: a notice "Restored 3 files".
//
// thread.state (legacy) is one of starting, running, waiting, idle, stopped, in the switchboard's
// own internal vocabulary - two of those words mean something different to a person ("waiting" is
// only ever set while an ask is open; "idle" is what a person calls "waiting"). thread.status
// (canonical, sessions' lib/thread-status.js) says the same word a person would use directly:
// starting, working, asking, waiting, paused, stopped, finished, failed - read as-is, never
// relabeled here. Both fire at the same point; once a box sends thread.status even once, the
// legacy word is ignored (see the thread.state case). thread.usage names the turn's
// own cost (cost_usd) and the session's (total_cost_usd), and context {used, max, share}: what the
// last request held of the model's window (contextLabel). The mode is mode.changed {mode}; the
// model is model.switched {model} (threads.model), model.changed {model} on older boxes (a
// model.changed with a scope is sessions.models.set's per-purpose default, not this thread's).
//
// Sessions 034c71e5 and db44749b: thinking is thread.thinking {message, block, delta | text +
// done} (db44749b; 034c71e5 said thread.text {kind: "reasoning"}, read the same), keyed
// r:<message>:<block>, never the text's m:<message>:<block> (the box flushes a step's thinking
// before its text); thinking.switched {on} is threads.thinking's on/off. thread.sent {images: n} counts a
// message's pasted images. thread.shell {command, code, output} is a "!" line run by the person
// (the answer to threads.shell carries the same, uncut), and its output goes to Claude at the
// front of the next message as <bash-input>/<bash-stdout>/<bash-stderr> blocks, which a
// transcript read splits back into shell rows. thread.remembered {scope, file} is a "#" line
// saved to a CLAUDE.md. thread.task {id, kind: shell|agent, title, status, call, background,
// summary, error} is a background task: started with its kind and title, updated with the
// fields that changed (status running, completed, failed or killed), ended with a summary;
// threads.tasks {thread} lists them (seedTasks) and threads.kill-task {thread, task} stops one.

import { toolDetail } from "./tool-detail.js";

/**
 * @typedef {"idle"|"starting"|"working"|"asking"|"waiting"|"paused"|"stopped"|"finished"|"failed"} SessionState
 *   Sessions' canonical, person-facing vocabulary (lib/thread-status.js, on work/sessions):
 *   thread.status/canonical_status. "idle" default below is legacy, replaced by the first
 *   thread.state or thread.status event/snapshot.
 * @typedef {{ key: string, kind: "user", text: string, uuid?: string, at?: number, seq?: number, command?: true, surface?: string|null,
 *   steered?: boolean, step?: number|null, local?: boolean, confirmed?: boolean, opened?: boolean,
 *   images?: number|import("./composer-state.js").Attachment[] }} UserItem
 * @typedef {{ key: string, kind: "steer", uuid: string|null, user: string|null, step: number|null, turn: string|null, pending: boolean,
 *   taken?: boolean, at?: number, seq?: number }} SteerItem
 * @typedef {{ key: string, kind: "text"|"reasoning", message: string|null, block: number, text: string, streaming: boolean, at?: number, seq?: number, provider?: string, model?: string|null }} TextItem
 * @typedef {{ key: string, kind: "tool", call: string, name: string, status: "running"|"completed"|"failed"|"canceled", summary?: string,
 *   error?: string|boolean, input?: any, output?: string|null, detail?: import("./tool-detail.js").ToolDetail, duration_ms?: number|null,
 *   patch?: any, images?: import("./composer-state.js").Attachment[], at?: number, seq?: number,
 *   reply?: string, render?: Record<string, any> }} ToolItem
 *   reply: a teammate's answer (team_ask/team.ask only, attachHandoffReply below), once it lands.
 * @typedef {{ key: string, kind: "turn", n?: number, ok?: boolean, result?: string, cost_usd?: number, tokens?: any, duration_ms?: number|null,
 *   error?: string, canceled?: boolean, reason?: string|null, model?: string|null, open?: boolean, at?: number, seq?: number }} TurnItem
 * @typedef {{ key: string, kind: "notice", text: string, at?: number, seq?: number }} NoticeItem
 * @typedef {{ key: string, kind: "plan", items: { text: string, status: "pending"|"running"|"done" }[], at?: number, seq?: number }} PlanItem
 * @typedef {{ key: string, kind: "ask", ask: string, askKind: string, tool: string|null, state: "open"|"answered"|"cancelled",
 *   decision?: string|null, summary?: string|null, answers?: any, at?: number, seq?: number }} AskItem
 * @typedef {{ key: string, kind: "shell", command: string, output: string, exit: number|null, duration_ms: number|null, error?: string, at?: number, seq?: number,
 *   local?: boolean, answered?: boolean, echoed?: boolean }} ShellItem
 * @typedef {UserItem|TextItem|ToolItem|TurnItem|NoticeItem|PlanItem|AskItem|SteerItem|ShellItem} Item
 * @typedef {{ ask: string, kind: string, tool: string|null, state: "open"|"answered"|"cancelled", decision: string|null, at: number|null }} Ask
 * @typedef {{ uuid: string|null, text: string, queued: number|string|null, at: number|null, local?: boolean }} Queued
 * @typedef {{ content: string, status: string, activeForm?: string }} Todo
 * @typedef {{ id: string, kind: "shell"|"agent", title: string, status: string, call?: string|null, at?: number|null, derived?: boolean,
 *   background?: boolean, summary?: string, error?: string }} Task
 * @typedef {{ type: string, payload?: any, at?: number, id?: number|string }} SessionEvent
 * @typedef {{ uuid: string, seq: number|null, from: number|null, at: number }} Rewind
 *   A rewind: the message's line (seq) and time (from) once known, and when it happened (at).
 * @typedef {{
 *   thread: string, provider: string|null, model: string|null, effort?: string|null, auth: string|null, state: SessionState, turn: number|null,
 *   items: Item[], byKey: Map<string, Item>, queued: Queued[], asks: Map<string, Ask>,
 *   usage: any, limit: any, stopped: string|null,
 *   mode: string|null, modes: string[]|null, thinking: boolean|null,
 *   todos: { key: string, todos: Todo[] }|null, tasks: Map<string, Task>,
 *   rewound: { uuid: string, text: string, at: number|null }|null, purpose: string|null,
 *   meta: { live: number, notices: number, turns: number, lastId: number, stateSeen: boolean, statusSeen: boolean,
 *     uuids: Map<string, string>, idents: Map<string, string>, texts: Map<string, string>, taskEvents: boolean,
 *     rewinds: Rewind[], restores: { uuid: string, local: boolean, key: string }[] }
 * }} Session
 */

/** @param {string} thread @returns {Session} */
export function createSession(thread) {
  return {
    thread, provider: null, model: null, auth: null, state: "idle", turn: null,
    items: [], byKey: new Map(), queued: [], asks: new Map(), usage: null, limit: null, stopped: null,
    mode: null, modes: null, thinking: null, todos: null, tasks: new Map(), rewound: null, purpose: null,
    // Bookkeeping a view does not read: counters for keys, the newest event id applied, whether
    // the switchboard sends thread.state (then state is never guessed), whether it sends the
    // canonical thread.status too (then the legacy thread.state's word is stale noise and
    // ignored - thread.status fires at the same point, for every future change too, so this never
    // needs to reset), uuid -> key for users whose key was minted before their uuid was known,
    // transcript block identity -> key, the words of queued messages by uuid (a hand-over or a
    // steer from the queue may name only the uuid), and whether thread.task events come (then
    // tasks are theirs).
    meta: { live: 0, notices: 0, turns: 0, lastId: -Infinity, stateSeen: false, statusSeen: false, uuids: new Map(), idents: new Map(),
      texts: new Map(), taskEvents: false, rewinds: [], restores: [] },
  };
}

/** Whitespace folded, for comparing what was sent with what the transcript kept. @param {unknown} s */
const norm = s => String(s ?? "").replace(/\s+/g, " ").trim();

/** Sent text is cut to 2000 with an ellipsis; a cut text matches the transcript's by prefix. @param {string} live @param {string} full */
function sameText(live, full) {
  const a = norm(live), b = norm(full);
  if (a === b) return true;
  return a.endsWith("…") && a.length > 1 && b.startsWith(a.slice(0, -1).trimEnd());
}

/** Tool statuses in the ADR 0030 shape. @param {any} p */
function toolStatus(p) {
  if (typeof p.status === "string") return p.status;
  if (p.phase === "started") return "running";
  if (p.phase === "done") return p.error ? "failed" : "completed";
  return undefined;
}

/** @param {Session} s @param {Item} item @param {number} [at] index to insert at; the end when absent */
function insert(s, item, at) {
  if (at === undefined || at < 0 || at >= s.items.length) s.items.push(item);
  else s.items.splice(at, 0, item);
  s.byKey.set(item.key, item);
}

/** @param {Session} s @param {SessionState} state */
function guess(s, state) {
  // These guesses (below, at every place an event implies the thread must now be running, waiting
  // on an ask, or idle again) speak the same canonical vocabulary as thread.status now (lib/
  // thread-status.js: starting, working, asking, waiting, paused, stopped, finished, failed) -
  // never the switchboard's old internal words a person would misread ("waiting" only while an
  // ask is open, "idle" meaning ready). A guess never overrides a real thread.state/thread.status
  // once one has arrived (stateSeen).
  if (!s.meta.stateSeen) s.state = state;
}

/** The newest item for a message of a kind ("text" or "reasoning"). @param {Session} s @param {string} kind @param {string} message */
function lastOf(s, kind, message) {
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = /** @type {any} */ (s.items[i]);
    if (it.kind === kind && it.message === message) return /** @type {TextItem} */ (it);
  }
  return null;
}

/** One past the highest block index a message's items of a kind use. @param {Session} s @param {string} kind @param {string} message */
function nextBlock(s, kind, message) {
  let n = 0;
  for (const it of s.items) if (it.kind === kind && /** @type {TextItem} */ (it).message === message) n = Math.max(n, /** @type {TextItem} */ (it).block + 1);
  return n;
}

/**
 * Streaming text is done, and tools still running are canceled: nothing more is coming. A steer
 * still "steering" was taken by the turn that just ended (a box without thread.steered never
 * says when), so it reads as steered, without a step.
 * @param {Session} s @param {Set<string>} out
 */
function settle(s, out) {
  for (const it of s.items) {
    if ((it.kind === "text" || it.kind === "reasoning") && it.streaming) { it.streaming = false; out.add(it.key); }
    if (it.kind === "tool" && it.status === "running") { it.status = "canceled"; out.add(it.key); }
    if (it.kind === "steer" && it.pending) { it.pending = false; out.add(it.key); }
  }
}

/**
 * A live user message: sent (thread.sent) or announced with its uuid (thread.turn). A uuid seen
 * before, or a pending live message with the same text, is the same message.
 * @param {Session} s @param {{ text: string, uuid?: string, at?: number, surface?: string|null }} u @param {Set<string>} out
 */
function liveUser(s, u, out) {
  if (u.uuid && s.meta.uuids.has(u.uuid)) return;
  if (u.uuid) {
    // The box mints its own uuid: a steer drawn on send under the Deck's is this one, by its words.
    const mine = /** @type {UserItem|undefined} */ (s.items.find(it => it.kind === "user" && it.local && !it.confirmed && it.seq === undefined
      && it.uuid !== u.uuid && sameText(it.text, u.text)));
    if (mine) { adopt(s, mine, u.uuid, out); return; }
  }
  if (!u.uuid) {
    // An older switchboard echoes a steer without its uuid: the words drawn on send are it.
    const mine = s.items.find(it => it.kind === "user" && it.local && !it.confirmed && it.seq === undefined && sameText(it.text, u.text));
    if (mine) { /** @type {UserItem} */ (mine).confirmed = true; out.add(mine.key); return; }
  }
  if (u.uuid) {
    const same = s.items.find(it => it.kind === "user" && !it.uuid && it.seq === undefined && sameText(it.text, u.text));
    if (same) {
      /** @type {UserItem} */ (same).uuid = u.uuid;
      s.meta.uuids.set(u.uuid, same.key);
      out.add(same.key);
      return;
    }
  }
  const key = u.uuid ? `u:${u.uuid}` : `u:live:${++s.meta.live}`;
  /** @type {UserItem} */
  const item = { key, kind: "user", text: u.text };
  if (u.uuid) { item.uuid = u.uuid; s.meta.uuids.set(u.uuid, key); }
  if (u.at !== undefined) item.at = u.at;
  if (u.surface !== undefined) item.surface = u.surface;
  insert(s, item);
  out.add(key);
  // A steer confirmed before its words arrived: its marker names this item now.
  const marker = u.uuid ? /** @type {SteerItem|undefined} */ (s.byKey.get(`steer:${u.uuid}`)) : undefined;
  if (marker && !marker.user) { marker.user = key; item.steered = true; item.step = marker.step; out.add(marker.key); }
}

// ---- steering, the queue drawn on send, rewinds ------------------------------------------------

/**
 * A user item drawn under the Deck's uuid is known by the box's from now on (its marker too).
 * @param {Session} s @param {UserItem} user @param {string} uuid @param {Set<string>} out
 */
function adopt(s, user, uuid, out) {
  const was = user.uuid;
  user.uuid = uuid;
  user.confirmed = true;
  s.meta.uuids.set(uuid, user.key);
  if (was && was !== uuid) {
    const m = /** @type {SteerItem|undefined} */ (s.byKey.get(`steer:${was}`));
    // thread.steered may have come first under the box's uuid: that marker is the one to keep.
    const early = /** @type {SteerItem|undefined} */ (s.byKey.get(`steer:${uuid}`));
    if (m && early && early !== m && !early.user) {
      Object.assign(m, { step: early.step, pending: false, taken: true, turn: early.turn ?? m.turn });
      const i = s.items.indexOf(early);
      if (i >= 0) s.items.splice(i, 1);
      s.byKey.delete(early.key);
      out.add(early.key);
    }
    if (m) { m.uuid = uuid; s.byKey.set(`steer:${uuid}`, m); out.add(m.key); }
    if (s.meta.texts.has(was)) { s.meta.texts.set(uuid, /** @type {string} */ (s.meta.texts.get(was))); s.meta.texts.delete(was); }
  }
  out.add(user.key);
}

/**
 * The send's answer named the box's uuid for words drawn under the Deck's (a steer: {steered,
 * uuid}; a queued row: {queued_id, uuid}). Returns the keys touched.
 * @param {Session} s @param {string} local the Deck's uuid @param {string|null|undefined} uuid the box's
 */
export function confirmSend(s, local, uuid) {
  /** @type {Set<string>} */
  const out = new Set();
  if (!uuid || uuid === local) return [];
  const key = s.meta.uuids.get(local);
  const user = key ? /** @type {UserItem|undefined} */ (s.byKey.get(key)) : undefined;
  if (user && user.uuid === local) adopt(s, user, uuid, out);
  // A row drawn on send: its uuid is the box's now (thread.queued may have named it already).
  const row = s.queued.find(q => q.uuid === local);
  if (row) {
    if (s.queued.some(q => q !== row && q.uuid === uuid)) s.queued = s.queued.filter(q => q !== row);
    else row.uuid = uuid;
    if (s.meta.texts.has(local)) { s.meta.texts.set(uuid, /** @type {string} */ (s.meta.texts.get(local))); s.meta.texts.delete(local); }
    out.add("@queued");
  }
  return [...out];
}

/** The marker that heads a user item, if any. @param {Session} s @param {string} userKey */
function markerOf(s, userKey) {
  const i = s.items.findIndex(it => it.key === userKey);
  const m = i > 0 ? s.items[i - 1] : null;
  if (m && m.kind === "steer" && m.user === userKey) return /** @type {SteerItem} */ (m);
  return /** @type {SteerItem|undefined} */ (s.items.find(it => it.kind === "steer" && it.user === userKey));
}

/** Take an item out of the list and put it at `at` (the end when absent). @param {Session} s @param {Item} item @param {number} [at] */
function move(s, item, at) {
  const i = s.items.indexOf(item);
  if (i >= 0) s.items.splice(i, 1);
  if (at === undefined || at >= s.items.length) s.items.push(item);
  else s.items.splice(Math.max(0, at), 0, item);
}

/**
 * The marker for a steered user item, made or brought up to date, and always just before it.
 * @param {Session} s @param {UserItem} user @param {{ uuid?: string|null, step?: number|null, pending?: boolean, turn?: string|null, at?: number, seq?: number }} f
 * @param {Set<string>} out
 */
function ensureMarker(s, user, f, out) {
  let m = (f.uuid ? /** @type {SteerItem|undefined} */ (s.byKey.get(`steer:${f.uuid}`)) : undefined) ?? markerOf(s, user.key);
  if (!m) {
    m = { key: f.uuid ? `steer:${f.uuid}` : `steer:@${f.seq ?? user.key}`, kind: "steer", uuid: f.uuid ?? null, user: user.key,
      step: f.step ?? null, turn: f.turn ?? null, pending: !!f.pending };
    if (f.at !== undefined) m.at = f.at;
    s.byKey.set(m.key, m);
    move(s, m, s.items.indexOf(user));
    out.add(m.key);
    return m;
  }
  const before = JSON.stringify([m.step, m.pending, m.user]);
  m.user = user.key;
  if (f.step !== undefined && f.step !== null) m.step = f.step;
  if (f.pending !== undefined) m.pending = f.pending;
  if (f.turn) m.turn = f.turn;
  if (f.seq !== undefined) m.seq = f.seq;
  if (s.items[s.items.indexOf(user) - 1] !== m) {
    const i = s.items.indexOf(m);
    if (i >= 0) s.items.splice(i, 1);
    s.items.splice(s.items.indexOf(user), 0, m);
    out.add(m.key);
  }
  if (JSON.stringify([m.step, m.pending, m.user]) !== before) out.add(m.key);
  return m;
}

/**
 * The composer sent something: draw it now. "steer": the words and a "steering" marker at the
 * tail; "queue": a row in the queue, and again with `queued` (the row id threads.send answered)
 * once it is known, so the row's buttons can name it; "send" (the session idle): the words at
 * the tail, no marker, adopted by thread.sent's words or confirmSend. null draws nothing.
 * Returns the keys touched.
 * @param {Session} s @param {{ uuid: string, text: string, mode: "steer"|"queue"|"send"|null, at?: number, queued?: number|string|null,
 *   images?: import("./composer-state.js").Attachment[] }} m
 */
export function localSend(s, m) {
  /** @type {Set<string>} */
  const out = new Set();
  if (!m || !m.uuid) return [];
  if (m.mode === "queue") {
    const was = s.queued.find(q => q.uuid === m.uuid);
    if (!was) s.queued.push({ uuid: m.uuid, text: m.text, queued: m.queued ?? null, at: m.at ?? null, local: true });
    else if (m.queued != null && was.queued == null) was.queued = m.queued;
    s.meta.texts.set(m.uuid, m.text);
    out.add("@queued");
    return [...out];
  }
  if (m.mode !== "steer" && m.mode !== "send") return [];
  liveUser(s, { text: m.text, uuid: m.uuid, at: m.at }, out);
  const user = /** @type {UserItem|undefined} */ (s.byKey.get(/** @type {string} */ (s.meta.uuids.get(m.uuid))));
  if (!user) return [...out];
  if (m.images) user.images = m.images;
  user.local = true;
  // A plain send (the session idle): the row is drawn at once, with no steer marker.
  if (m.mode === "send") { out.add(user.key); return [...out]; }
  user.steered = true;
  // A marker thread.steered made first (it can overtake the send's answer) is already confirmed.
  ensureMarker(s, user, { uuid: m.uuid, pending: s.byKey.has(`steer:${m.uuid}`) ? undefined : true, at: m.at }, out);
  out.add(user.key);
  return [...out];
}

/**
 * A send that did not go through: what localSend drew for it goes (the words go back in the box).
 * @param {Session} s @param {string} uuid
 */
export function dropLocal(s, uuid) {
  /** @type {Set<string>} */
  const out = new Set();
  const before = s.queued.length;
  s.queued = s.queued.filter(q => !(q.uuid === uuid && q.local));
  if (s.queued.length !== before) out.add("@queued");
  const key = s.meta.uuids.get(uuid);
  const user = key ? /** @type {UserItem|undefined} */ (s.byKey.get(key)) : undefined;
  if (user && user.local && user.seq === undefined) {
    const m = markerOf(s, user.key);
    for (const it of [m, user]) {
      if (!it) continue;
      const i = s.items.indexOf(it);
      if (i >= 0) s.items.splice(i, 1);
      s.byKey.delete(it.key);
      out.add(it.key);
    }
    s.meta.uuids.delete(uuid);
  }
  s.meta.texts.delete(uuid);
  return [...out];
}

/**
 * The step a steer joined at, counted when thread.steered arrives: the tool calls of the running
 * turn that have finished. The turn is everything after the last closed turn marker.
 * @param {Session} s
 */
function stepNow(s) {
  let n = 0;
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i];
    if (it.kind === "turn" && !it.open) break;
    if (it.kind === "tool" && it.status !== "running") n++;
  }
  return n;
}

/** @param {Session} s @param {any} p @param {number|undefined} at @param {Set<string>} out */
function onSteered(s, p, at, out) {
  const uuid = String(p.uuid ?? "");
  if (!uuid) return;
  // The final contract names no step; an older build of the proposal did.
  const step = typeof p.step === "number" ? p.step : stepNow(s);
  let key = s.meta.uuids.get(uuid);
  if (!key && s.meta.texts.has(uuid)) {
    // Steered from the queue: the words are the queued ones.
    liveUser(s, { text: /** @type {string} */ (s.meta.texts.get(uuid)), uuid, at }, out);
    key = s.meta.uuids.get(uuid);
  }
  s.meta.texts.delete(uuid);
  const user = key ? /** @type {UserItem|undefined} */ (s.byKey.get(key)) : undefined;
  if (!user) {
    // Words not seen yet (another screen steered): the marker waits at the tail for them.
    let m = /** @type {SteerItem|undefined} */ (s.byKey.get(`steer:${uuid}`));
    if (!m) {
      m = { key: `steer:${uuid}`, kind: "steer", uuid, user: null, step, turn: p.turn ?? null, pending: false, taken: true };
      if (at !== undefined) m.at = at;
      insert(s, m);
    } else Object.assign(m, { step, pending: false, taken: true });
    out.add(m.key);
    return;
  }
  // Where the words joined is the turn's tail now: a live item moves there, a transcript's stays.
  const m = ensureMarker(s, user, { uuid, step, pending: false, turn: p.turn ?? null, at }, out);
  m.taken = true;
  if (at !== undefined) m.at = at;
  if (user.seq === undefined) { move(s, m); move(s, user); }
  user.steered = true;
  user.step = step;
  out.add(m.key);
  out.add(user.key);
}

/**
 * A rewind (threads.rewind): the same thread went back to just before a message of the person's.
 * That message and everything after it leave the view; the rewind is kept (noteRewind) so a later
 * read of the transcript, which still holds the abandoned branch, skips it too. s.rewound carries
 * the words back for the composer (the answer's text, when this screen asked).
 * @param {Session} s @param {any} p @param {number|undefined} at @param {Set<string>} out
 */
function onRewound(s, p, at, out) {
  const uuid = String(p.uuid ?? "");
  if (!uuid) return;
  if (p.restore === "code") { onRestored(s, uuid, p, at, out); return; }
  const key = s.meta.uuids.get(uuid) ?? s.items.find(it => it.kind === "user" && it.uuid === uuid)?.key;
  const user = key ? /** @type {UserItem|undefined} */ (s.byKey.get(key)) : undefined;
  // Applied already (the answer, then its event; or the other way round): the box's time wins.
  const known = s.meta.rewinds.find(r => r.uuid === uuid);
  if (known && !user) { if (!p.local && at !== undefined) known.at = at; return; }
  const text = typeof p.text === "string" ? p.text : user?.text ?? "";
  noteRewind(s, { uuid, at: at ?? Date.now(), seq: user?.seq ?? null, from: user?.at ?? null });
  const i = user ? s.items.indexOf(user) : -1;
  if (i >= 0) {
    // A steer marker heading it goes with it.
    const head = i > 0 && s.items[i - 1].kind === "steer" && /** @type {SteerItem} */ (s.items[i - 1]).user === user?.key ? i - 1 : i;
    for (const it of s.items.splice(head)) {
      s.byKey.delete(it.key);
      out.add(it.key);
      if (it.kind === "user" && it.uuid) { s.meta.uuids.delete(it.uuid); s.meta.texts.delete(it.uuid); }
      if (it.kind === "ask") s.asks.delete(it.ask);
    }
    for (const [ident, k] of s.meta.idents) if (!s.byKey.has(k)) s.meta.idents.delete(ident);
    derive(s, out);
  }
  s.rewound = { uuid, text, at: at ?? null };
  out.add("@rewound");
  const nkey = `rw:${uuid}:${++s.meta.notices}`;
  const quote = text.length > 60 ? text.slice(0, 59) + "…" : text;
  const files = filesNote(p.files);
  insert(s, /** @type {NoticeItem} */ ({ key: nkey, kind: "notice", text: (quote ? `Rewound to before "${quote}"` : "Rewound") + (files ? ` · ${files}` : ""),
    ...(at !== undefined ? { at } : {}) }));
  out.add(nkey);
  out.add("@session");
}

/**
 * How a rewind's files went, for its notice: "Restored 3 files", "No files to restore", or why
 * they could not be put back. Null when the rewind did not touch files.
 * @param {any} files {restored, files_changed?, why?} @returns {string|null}
 */
export function filesNote(files) {
  if (!files || typeof files !== "object") return null;
  if (files.restored === false) return "Could not restore the files" + (files.why ? `: ${files.why}` : "");
  if (!Array.isArray(files.files_changed)) return "Restored the files";
  const n = files.files_changed.length;
  return n ? `Restored ${n} file${n === 1 ? "" : "s"}` : "No files to restore";
}

/**
 * A code-only rewind: the files went back, the conversation stays. Nothing leaves the view and
 * no branch is abandoned; a notice says what came back. The answer (local) and its event are one
 * restore: whichever comes second finds the first's unpaired record and only updates its notice.
 * @param {Session} s @param {string} uuid @param {any} p @param {number|undefined} at @param {Set<string>} out
 */
function onRestored(s, uuid, p, at, out) {
  const local = Boolean(p.local);
  const text = filesNote(p.files) || "Restored the files";
  const pair = s.meta.restores.find(r => r.uuid === uuid && r.local !== local);
  if (pair) {
    s.meta.restores.splice(s.meta.restores.indexOf(pair), 1);
    const n = /** @type {NoticeItem|undefined} */ (s.byKey.get(pair.key));
    if (n && p.files && n.text !== text) { n.text = text; out.add(n.key); }
    return;
  }
  const key = `rs:${uuid}:${++s.meta.notices}`;
  insert(s, /** @type {NoticeItem} */ ({ key, kind: "notice", text, ...(at !== undefined ? { at } : {}) }));
  s.meta.restores.push({ uuid, local, key });
  out.add(key);
}

/**
 * The header's context meter, "62% of context", from thread.usage's context; null until the box
 * says the share (an older box, or a model whose window it does not know).
 * @param {any} usage @returns {{ text: string, title: string|null, share: number }|null}
 */
export function contextLabel(usage) {
  const c = usage && usage.context;
  if (!c || typeof c.share !== "number" || !isFinite(c.share) || c.share < 0) return null;
  const pct = Math.min(100, Math.round(c.share * 100));
  const title = typeof c.used === "number" && typeof c.max === "number" ? `${c.used.toLocaleString("en-US")} of ${c.max.toLocaleString("en-US")} tokens` : null;
  return { text: `${pct}% of context`, title, share: c.share };
}

/**
 * Remember a rewind without touching the items: what a view does for thread.rewound events it
 * reads back on open, before the transcript's blocks, so the abandoned branch is never drawn.
 * `at` is when it happened (the event's time); seq and from (the message's line and time) are
 * learnt from the transcript when not given.
 * @param {Session} s @param {{ uuid: string, at: number, seq?: number|null, from?: number|null }} r
 */
export function noteRewind(s, r) {
  if (!r || !r.uuid) return;
  const was = s.meta.rewinds.find(x => x.uuid === r.uuid && x.at === r.at);
  if (was) { if (r.seq != null) was.seq = r.seq; if (r.from != null) was.from = r.from; return; }
  s.meta.rewinds.push({ uuid: String(r.uuid), at: Number(r.at) || Date.now(), seq: r.seq ?? null, from: r.from ?? null });
}

/**
 * Is this transcript block on a branch a rewind left? From the rewound message's line on, written
 * after that message and before the rewind. A turn block is dated by its start, so the turn the
 * message closed (written before it) stays.
 * @param {Session} s @param {any} b
 */
function abandoned(s, b) {
  for (const r of s.meta.rewinds) {
    if (b.kind === "user" && b.uuid === r.uuid) {
      if (r.seq == null) r.seq = b.seq;
      if (r.from == null && typeof b.ts === "number" && b.ts) r.from = b.ts;
      return true;
    }
    if (r.seq == null || b.seq < r.seq) continue;
    const ts = typeof b.ts === "number" ? b.ts : 0;
    if (!ts || ts >= r.at) continue;
    if (b.kind === "turn" && (r.from == null ? b.seq <= r.seq : ts < r.from)) continue;
    return true;
  }
  return false;
}

/**
 * A "!" command the person ran here, drawn on run and filled from threads.shell's answer
 * {code, output} (uncut; the event's output is cut at 4000). Returns the keys touched.
 * @param {Session} s
 * @param {{ id: string, command: string, output?: string, exit?: number|null, duration_ms?: number|null, error?: string, at?: number }} r
 */
export function localShell(s, r) {
  const key = `sh:${r.id}`;
  const answered = r.output !== undefined || r.exit != null || !!r.error;
  const was = /** @type {ShellItem|undefined} */ (s.byKey.get(key));
  /** @type {ShellItem} */
  const item = { key, kind: "shell", command: r.command, output: String(r.output ?? was?.output ?? ""), exit: r.exit ?? was?.exit ?? null,
    duration_ms: r.duration_ms ?? null, local: true, ...(answered ? { answered: true } : {}),
    ...(r.error ? { error: r.error } : {}), ...(r.at !== undefined ? { at: r.at } : {}) };
  if (was) Object.assign(was, item); else insert(s, item);
  return [key];
}

/**
 * thread.shell {command, code, output}: the row drawn here for it (the newest with that command
 * not echoed yet) takes it, else it is a row of its own (run on another screen).
 * @param {Session} s @param {any} p @param {number|undefined} at @param {SessionEvent} e @param {Set<string>} out
 */
function onShell(s, p, at, e, out) {
  const command = String(p.command ?? "");
  if (!command) return;
  const exit = typeof p.code === "number" ? p.code : null;
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = /** @type {ShellItem} */ (s.items[i]);
    if (it.kind !== "shell" || !it.local || it.echoed || !sameText(command, it.command)) continue;
    it.echoed = true;
    // The answer's output is whole; the event's is cut.
    if (!it.answered) { it.output = String(p.output ?? ""); it.exit = exit; }
    out.add(it.key);
    return;
  }
  const key = `sh:e${e.id ?? ++s.meta.notices}`;
  if (s.byKey.has(key)) return;
  insert(s, /** @type {ShellItem} */ ({ key, kind: "shell", command, output: String(p.output ?? ""), exit, duration_ms: null, ...(at !== undefined ? { at } : {}) }));
  out.add(key);
}

/** "!" lines at the front of a message, as the box sends them to Claude. */
const SHELL_BLOCK = /^\s*<bash-input>([\s\S]*?)<\/bash-input>\s*<bash-stdout>([\s\S]*?)<\/bash-stdout>\s*(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?/;

/**
 * A transcript user line split into the "!" lines it carried and the person's own words.
 * @param {string} text @returns {{ shells: { command: string, output: string }[], text: string }}
 */
export function splitShells(text) {
  const shells = [];
  let rest = String(text ?? "");
  for (let m = SHELL_BLOCK.exec(rest); m; m = SHELL_BLOCK.exec(rest)) {
    const out = m[2] ?? "", err = m[3] ?? "";
    shells.push({ command: m[1], output: out + (err ? (out ? "\n" : "") + err : "") });
    rest = rest.slice(m[0].length);
  }
  return { shells, text: shells.length ? rest.replace(/^\s+/, "") : String(text ?? "") };
}

/**
 * threads.tasks' answer: the box's list of this thread's background tasks. From then on they
 * are the box's, as with thread.task. Returns the keys touched.
 * @param {Session} s @param {any[]} list
 */
export function seedTasks(s, list) {
  if (!Array.isArray(list)) return [];
  /** @type {Set<string>} */
  const out = new Set();
  if (!s.meta.taskEvents) { s.meta.taskEvents = true; s.tasks = new Map(); out.add("@tasks"); }
  for (const t of list) if (t && t.id != null) { putTask(s, t, undefined); out.add("@tasks"); }
  return [...out];
}

/** One task from the box (thread.task or threads.tasks), merged over what was known. @param {Session} s @param {any} p @param {number|undefined} at */
function putTask(s, p, at) {
  const id = String(p.id);
  const was = s.tasks.get(id);
  // The status words the box uses: running, completed, failed, killed (Claude Code's stopped).
  const status = p.status === "stopped" ? "killed" : p.status;
  /** @type {Task} */
  const t = { id, kind: p.kind === "agent" || p.kind === "shell" ? p.kind : was?.kind ?? "shell", title: String(p.title ?? was?.title ?? ""),
    status: String(status ?? was?.status ?? "running"), at: was?.at ?? at ?? null };
  const call = p.call ?? was?.call;
  if (call) t.call = String(call);
  const background = p.background ?? was?.background;
  if (typeof background === "boolean") t.background = background;
  const summary = p.summary ?? was?.summary;
  if (summary) t.summary = String(summary);
  const error = p.error ?? was?.error;
  if (error) t.error = String(error);
  s.tasks.set(id, t);
}

/**
 * Messages a rewind can go back to: the person's own (not commands) that have a uuid, newest
 * first. What the rewind sheet lists (the box has no threads.checkpoints).
 * @param {Session} s @returns {{ uuid: string, text: string, at: number|null, key: string }[]}
 */
export function checkpoints(s) {
  const out = [];
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i];
    if (it.kind === "user" && it.uuid && !it.command) out.push({ uuid: it.uuid, text: it.text, at: it.at ?? null, key: it.key });
  }
  return out;
}

// ---- todos and background tasks, from the tool calls ---------------------------------------------

/** The newest TodoWrite's list. @param {Session} s */
function latestTodos(s) {
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = /** @type {any} */ (s.items[i]);
    if (it.kind === "tool" && it.name === "TodoWrite" && it.input && Array.isArray(it.input.todos)) {
      return { key: it.key, todos: it.input.todos.filter((/** @type {any} */ t) => t && typeof t === "object")
        .map((/** @type {any} */ t) => ({ content: String(t.content ?? ""), status: String(t.status ?? "pending"), ...(t.activeForm ? { activeForm: String(t.activeForm) } : {}) })) };
    }
  }
  return null;
}

const SHELL_ID = /\b(?:ID|id)[:\s]+([A-Za-z0-9_-]+)/;
const SHELL_STATUS = /<status>\s*([a-z_]+)\s*<\/status>/i;

/**
 * Background tasks, until the box sends thread.task: a Bash call run in the background is a
 * running shell (named by the id its output gives) until a KillShell names it or a BashOutput says
 * it ended; a Task or Agent call is a running subagent while its call runs.
 * @param {Session} s @returns {Map<string, Task>}
 */
function deriveTasks(s) {
  /** @type {Map<string, Task>} */
  const tasks = new Map();
  for (const it of s.items) {
    if (it.kind !== "tool") continue;
    const inp = it.input && typeof it.input === "object" ? it.input : {};
    const out = String(it.output ?? "");
    if (it.name === "Bash" && inp.run_in_background) {
      const id = SHELL_ID.exec(out)?.[1] || it.call;
      tasks.set(id, { id, kind: "shell", title: String(inp.command || inp.description || it.summary || "command"),
        status: it.status === "failed" ? "failed" : "running", call: it.call, at: it.at ?? null, derived: true });
    } else if ((it.name === "KillShell" || it.name === "KillBash") && tasks.has(String(inp.shell_id))) {
      /** @type {Task} */ (tasks.get(String(inp.shell_id))).status = "killed";
    } else if (it.name === "BashOutput" && tasks.has(String(inp.bash_id ?? inp.shell_id))) {
      const st = SHELL_STATUS.exec(out)?.[1];
      if (st && st !== "running") /** @type {Task} */ (tasks.get(String(inp.bash_id ?? inp.shell_id))).status = st;
    } else if ((it.name === "Task" || it.name === "Agent") && (it.status === "running" || inp.run_in_background)) {
      if (inp.run_in_background && it.status !== "running" && it.status !== "completed") continue;
      tasks.set(it.call, { id: it.call, kind: "agent", title: String(inp.description || it.summary || "subagent"), status: "running",
        call: it.call, at: it.at ?? null, derived: true });
    }
  }
  return tasks;
}

/** After tool calls changed: the todo list and the derived tasks, and "@todos"/"@tasks" when they moved. @param {Session} s @param {Set<string>} out */
function derive(s, out) {
  const todos = latestTodos(s);
  if (JSON.stringify(todos) !== JSON.stringify(s.todos)) { s.todos = todos; out.add("@todos"); }
  if (s.meta.taskEvents) return;
  const tasks = deriveTasks(s);
  if (JSON.stringify([...tasks]) !== JSON.stringify([...s.tasks])) { s.tasks = tasks; out.add("@tasks"); }
}

/** Did a change touch a tool call, or take items away? @param {Session} s @param {Set<string>} out */
const touchedTools = (s, out) => [...out].some(k => k.startsWith("t:") || (!k.startsWith("@") && !s.byKey.has(k)));

/** @param {Session} s @param {any} p @param {number|undefined} at @param {SessionEvent} e @param {Set<string>} out */
function onText(s, p, at, e, out) {
  const text = typeof p.text === "string" ? p.text : null;
  if (p.notice) {
    const key = `n:${e.id ?? ++s.meta.notices}`;
    if (s.byKey.has(key)) return;
    insert(s, /** @type {NoticeItem} */ ({ key, kind: "notice", text: text ?? "", ...(at !== undefined ? { at } : {}) }));
    out.add(key);
    return;
  }
  const kind = p.kind === "reasoning" ? "reasoning" : "text";
  const prefix = kind === "reasoning" ? "r" : "m";
  const message = String(p.message ?? "");
  const delta = typeof p.delta === "string" ? p.delta : null;
  const done = Boolean(p.done);

  /** @type {TextItem|null} */
  let item = null;
  if (typeof p.block === "number") item = /** @type {TextItem|null} */ (s.byKey.get(`${prefix}:${message}:${p.block}`) ?? null);
  else {
    // No block index (an old switchboard): the message's newest item while it streams. A done
    // text that the message already holds (the transcript got there first) is that item; any
    // other done text for a finished item is the message's next block, never an overwrite.
    const last = lastOf(s, kind, message);
    if (last && last.streaming) item = last;
    else if (done && text !== null) {
      const held = s.items.find(it => it.kind === kind && /** @type {TextItem} */ (it).message === message && norm(/** @type {TextItem} */ (it).text) === norm(text));
      if (held) return;
    }
  }
  if (item && item.seq !== undefined) {
    // The transcript's text is already in place: live text only ends its streaming.
    if (done && item.streaming) { item.streaming = false; out.add(item.key); }
    return;
  }
  if (!item) {
    const block = typeof p.block === "number" ? p.block : nextBlock(s, kind, message);
    // Who wrote it, when the box says (every reply's event carries provider and model): taken once, never guessed.
    item = /** @type {TextItem} */ ({ key: `${prefix}:${message}:${block}`, kind, message, block, text: "", streaming: true, ...(at !== undefined ? { at } : {}),
      ...(typeof p.provider === "string" && p.provider ? { provider: p.provider } : {}), ...(typeof p.model === "string" && p.model ? { model: p.model } : {}) });
    insert(s, item);
  }
  if (delta !== null) item.text += delta;
  if (text !== null) item.text = text;
  item.streaming = !done;
  out.add(item.key);
  guess(s, "working");
}

/** @param {Session} s @param {any} p @param {number|undefined} at @param {Set<string>} out */
function onTool(s, p, at, out) {
  const call = String(p.call ?? p.id ?? "");
  if (!call) return;
  const key = `t:${call}`;
  const status = toolStatus(p);
  let item = /** @type {ToolItem|undefined} */ (s.byKey.get(key));
  if (!item) {
    item = { key, kind: "tool", call, name: String(p.name ?? p.tool ?? ""), status: /** @type {any} */ (status ?? "running") };
    if (at !== undefined) item.at = at;
    insert(s, item);
  } else if (status && !(status === "running" && item.status !== "running")) {
    // A terminal status is never taken back by a late "running".
    item.status = /** @type {any} */ (status);
  }
  // Live events carry no duration: a call that ends is as long as its two events are apart.
  if (item.status !== "running" && item.duration_ms == null && item.at !== undefined && at !== undefined && at >= item.at) item.duration_ms = at - item.at;
  const name = p.name ?? p.tool;
  if (name && !item.name) item.name = String(name);
  if (typeof p.summary === "string" && p.summary) item.summary = p.summary;
  if (p.error !== undefined && p.error !== false && p.error !== null) item.error = p.error;
  // Most tools' live events carry no input yet (built up as the call streams; the transcript
  // fills it in later) - but a handoff's whole input is one small object, present as soon as the
  // call starts, and the row needs the teammate's role and the ask's own words right away, not
  // after a reopen. Never overwrites input that already arrived (a later live event, or the
  // transcript read patching it in).
  if (p.input !== undefined && item.input === undefined) item.input = p.input;
  if (p.render && typeof p.render === "object") item.render = p.render;
  // A command's exit code when the provider said one (Codex and Grok over ACP): data, shown on the row.
  if (typeof p.exit_code === "number" && Number.isInteger(p.exit_code)) /** @type {any} */ (item).exit = p.exit_code;
  out.add(key);
  guess(s, "working");
}

/** @param {Session} s @param {string} type @param {any} p @param {number|undefined} at @param {Set<string>} out */
function onAsk(s, type, p, at, out) {
  const id = String(p.ask ?? "");
  if (!id) return;
  const key = `a:${id}`;
  if (type === "ask.raised") {
    /** @type {Ask} */
    const a = { ask: id, kind: p.kind || "permission", tool: p.tool ?? null, state: "open", decision: null, at: at ?? null };
    s.asks.set(id, a);
    const item = /** @type {AskItem|undefined} */ (s.byKey.get(key));
    if (item) { item.state = "open"; item.askKind = a.kind; }
    else insert(s, /** @type {AskItem} */ ({ key, kind: "ask", ask: id, askKind: a.kind, tool: a.tool, state: "open", decision: null,
      summary: p.summary ?? null, ...(at !== undefined ? { at } : {}) }));
    out.add(key);
    guess(s, "asking");
    return;
  }
  // The old switchboard says a withdrawn ask as ask.answered with decision "cancelled".
  const cancelled = type === "ask.cancelled" || p.decision === "cancelled";
  const state = cancelled ? "cancelled" : "answered";
  const decision = cancelled ? (p.decision ?? "cancelled") : (p.decision ?? null);
  const a = s.asks.get(id) ?? { ask: id, kind: p.kind || "permission", tool: p.tool ?? null, state, decision, at: at ?? null };
  a.state = state; a.decision = decision;
  s.asks.set(id, a);
  const item = /** @type {AskItem|undefined} */ (s.byKey.get(key));
  if (item) {
    item.state = state; item.decision = decision;
    if (p.answers) item.answers = p.answers;
    out.add(key);
  }
  if (![...s.asks.values()].some(x => x.state === "open")) guess(s, "working");
}

/** @param {Session} s @param {any} p @param {number|undefined} at @param {Set<string>} out */
function onFinished(s, p, at, out) {
  settle(s, out);
  const n = s.turn ?? ++s.meta.turns;
  const key = `turn:${n}`;
  let item = /** @type {TurnItem|undefined} */ (s.byKey.get(key));
  if (!item) { item = { key, kind: "turn", n }; if (at !== undefined) item.at = at; insert(s, item); }
  const cost = typeof p.cost === "number" ? p.cost : typeof p.cost_usd === "number" ? p.cost_usd : undefined;
  Object.assign(item, {
    ok: p.ok ?? !p.error,
    ...(typeof p.result === "string" ? { result: p.result } : {}),
    ...(cost !== undefined ? { cost_usd: cost } : {}),
    ...(p.tokens ? { tokens: p.tokens } : {}),
    ...(p.duration_ms !== undefined ? { duration_ms: p.duration_ms } : {}),
    ...(p.error ? { error: String(p.error) } : {}),
    ...(p.canceled ? { canceled: true } : {}),
    reason: p.reason ?? p.stop_reason ?? null,
  });
  out.add(key);
  guess(s, "waiting");
  out.add("@session");
}

/**
 * thread.turn {steered: true, uuid, text}: steered words the turn never reached run as the next
 * turn, all of them as one message (text, joined; uuid, the first's). Every live steer the box has
 * not taken in (no thread.steered) was one: their markers go, the first (by uuid, else the oldest)
 * becomes a plain message at the tail with the joined text, and the rest fold into it.
 * @param {Session} s @param {any} p @param {number|undefined} at @param {Set<string>} out
 */
function steersRun(s, p, at, out) {
  const uuid = p.uuid ? String(p.uuid) : undefined;
  const text = typeof p.text === "string" ? p.text : "";
  const markers = /** @type {SteerItem[]} */ (s.items.filter(it => it.kind === "steer" && !it.taken && it.seq === undefined));
  const users = /** @type {UserItem[]} */ (markers.map(m => m.user && s.byKey.get(m.user)).filter(u => u && u.kind === "user" && u.seq === undefined));
  let first = uuid ? /** @type {UserItem|undefined} */ (s.byKey.get(/** @type {string} */ (s.meta.uuids.get(uuid) ?? ""))) : undefined;
  if (!first && users.length) {
    // Drawn here under the Deck's uuid and not yet tied to the box's: the oldest is the first.
    first = users[0];
    if (uuid) adopt(s, first, uuid, out);
  }
  for (const m of markers) {
    const i = s.items.indexOf(m);
    if (i >= 0) s.items.splice(i, 1);
    s.byKey.delete(m.key);
    if (m.uuid) s.byKey.delete(`steer:${m.uuid}`);
    out.add(m.key);
  }
  for (const u of users) {
    if (u === first) continue;
    const i = s.items.indexOf(u);
    if (i >= 0) s.items.splice(i, 1);
    s.byKey.delete(u.key);
    if (u.uuid && first) s.meta.uuids.set(u.uuid, first.key);
    out.add(u.key);
  }
  if (!first) { liveUser(s, { text, uuid, at }, out); first = uuid ? /** @type {UserItem|undefined} */ (s.byKey.get(/** @type {string} */ (s.meta.uuids.get(uuid) ?? ""))) : undefined; }
  if (!first) return;
  if (text) first.text = text;
  first.steered = false;
  first.step = null;
  first.opened = true;
  if (at !== undefined) first.at = at;
  if (first.seq === undefined) move(s, first);
  if (uuid) s.meta.texts.delete(uuid);
  out.add(first.key);
  guess(s, "working");
}

/**
 * A teammate's answer (core/team's threads.post -> thread.sent {kind: "teammate-result", surface:
 * <teammate's role>, text}), landing back in the thread that asked. Attaches to the OPEN handoff
 * tool item (the team_ask call that started it) rather than drawing a new row: the most recent
 * one for this role with no reply yet, oldest-first FIFO if more than one is open at once.
 * KNOWN GAP: threads.post's payload carries no request id, only the role, so this cannot tell
 * apart two concurrent open asks to the SAME teammate - flagged to teammates/sessions; the common
 * one-open-ask-per-role case is exact.
 * @param {Session} s @param {any} p @param {Set<string>} out
 */
function attachHandoffReply(s, p, out) {
  const role = String(p.surface ?? "");
  if (!role) return;
  const item = /** @type {ToolItem|undefined} */ (s.items.find(it => it.kind === "tool" && (it.name === "team_ask" || it.name === "team.ask")
    && it.input?.to === role && !it.reply));
  if (!item) return;
  item.reply = typeof p.text === "string" ? p.text : "";
  out.add(item.key);
}

/**
 * thread.sent: a message went in. via "turn" (a queued row handed over at a turn's end) and a
 * plain send are messages of their own; via "steer" (threads.send into a running turn) and "now"
 * (threads.send-now, a queued row into the running turn) are steers: the words and a "steering"
 * marker until thread.steered. A "now" with no turn running starts one (thread.turn came first
 * with its uuid): a message of its own. A hand-over may carry only its row id and uuid: the words
 * are the row's. A steer drawn on send that the box took as a plain message (the turn ended
 * first) loses its marker.
 * @param {Session} s @param {any} p @param {number|undefined} at @param {Set<string>} out
 */
function onSent(s, p, at, out) {
  // A teammate's result (core/team's threads.post, kind "teammate-result"): never an ordinary
  // user message - it attaches to the handoff row that asked, not a new row of its own.
  if (p.kind === "teammate-result") { attachHandoffReply(s, p, out); return; }
  const row = s.queued.find(q => (p.queued != null && q.queued === p.queued) || (p.uuid && q.uuid === p.uuid));
  const uuid = p.uuid || row?.uuid || undefined;
  const text = typeof p.text === "string" && p.text ? p.text : row?.text ?? (uuid ? s.meta.texts.get(uuid) : undefined) ?? "";
  if (p.queued != null || p.uuid) {
    const before = s.queued.length;
    s.queued = s.queued.filter(q => !((p.queued != null && q.queued === p.queued) || (uuid && q.uuid === uuid)));
    if (s.queued.length !== before) out.add("@queued");
  }
  liveUser(s, { text, uuid, at, surface: p.surface ?? null }, out);
  if (uuid && p.via !== "steer" && p.via !== "now") s.meta.texts.delete(uuid);
  const key = uuid ? s.meta.uuids.get(uuid) : undefined;
  const user = key ? /** @type {UserItem|undefined} */ (s.byKey.get(key)) : undefined;
  // How many pasted images came with it (the server does not echo the bytes back in the event).
  // A local send already drew the real pictures (localSend's array): never downgrade that to a
  // bare count just because the confirmation arrived.
  if (user && typeof p.images === "number" && p.images > 0 && !Array.isArray(user.images) && user.images !== p.images) { user.images = p.images; out.add(user.key); }
  if (user && user.seq === undefined) {
    const steer = p.via === "steer" || (p.via === "now" && !user.opened);
    const m = markerOf(s, user.key);
    if (steer) {
      user.steered = true;
      if (!m || m.pending) ensureMarker(s, user, { uuid, pending: true, turn: p.turn ?? null, ...(at !== undefined ? { at } : {}) }, out);
      out.add(user.key);
    } else if (m && m.pending && !m.taken) {
      // Drawn as a steer, taken as a message of its own.
      const i = s.items.indexOf(m);
      if (i >= 0) s.items.splice(i, 1);
      s.byKey.delete(m.key);
      out.add(m.key);
      user.steered = false;
      out.add(user.key);
    }
  }
  guess(s, "working");
  out.add("@session");
}

/**
 * One live event. Returns the keys it changed or added ("@session" and "@queued" for the header
 * and the queue). An event for another thread, or one whose numeric id was applied already, is
 * a no-op.
 * @param {Session} s @param {SessionEvent} e @returns {string[]}
 */
export function applyEvent(s, e) {
  /** @type {Set<string>} */
  const out = new Set();
  if (!e || typeof e.type !== "string") return [];
  const p = e.payload || {};
  if (p.thread && p.thread !== s.thread) return [];
  if (typeof e.id === "number") {
    if (e.id <= s.meta.lastId) return [];
    s.meta.lastId = e.id;
  }
  const at = typeof e.at === "number" ? e.at : undefined;
  switch (e.type) {
    case "thread.started":
      for (const k of /** @type {const} */ (["provider", "model", "auth", "purpose"])) if (p[k] != null) s[k] = String(p[k]);
      if (typeof p.mode === "string") s.mode = p.mode;
      if (Array.isArray(p.modes)) s.modes = p.modes.map(String);
      if (typeof p.thinking === "boolean") s.thinking = p.thinking;
      s.stopped = null;
      guess(s, "starting");
      out.add("@session");
      break;
    case "thread.state":
      // thread.status (below) is canonical and, once a box sends it at all, fires at the same
      // point as this legacy event for every future change too - so once seen, this raw word
      // (old vocabulary: "waiting" meaning an ask is open, "idle" meaning ready - swapped from
      // what a person would guess) is stale noise. An older box that never sends thread.status
      // keeps working exactly as before.
      if (s.meta.statusSeen) break;
      if (typeof p.state === "string") { s.state = p.state; s.meta.stateSeen = true; out.add("@session"); }
      break;
    case "thread.status":
      if (typeof p.status === "string") { s.state = p.status; s.meta.stateSeen = true; s.meta.statusSeen = true; out.add("@session"); }
      break;
    case "thread.sent": onSent(s, p, at, out); break;
    case "thread.turn": {
      const m = /:(\d+)$/.exec(String(p.turn ?? ""));
      if (m) { s.turn = Number(m[1]); out.add("@session"); }
      if (p.steered) { steersRun(s, p, at, out); break; }
      if (typeof p.text === "string") liveUser(s, { text: p.text, uuid: p.uuid || undefined, at }, out);
      const u = p.uuid ? s.byKey.get(/** @type {string} */ (s.meta.uuids.get(String(p.uuid)) ?? "")) : undefined;
      if (u && u.kind === "user") u.opened = true;
      break;
    }
    case "thread.queued": {
      // A teammate's result arriving while this thread is busy: it lands as an ordinary
      // thread.sent once this turn ends (threads.post -> queue()'s owned path), not a message to
      // draw meanwhile - never a "queued for after" row for it.
      if (p.kind === "teammate-result") break;
      /** @type {Queued} */
      const q = { uuid: p.uuid ?? null, text: String(p.text ?? ""), queued: p.queued ?? null, at: at ?? null };
      // The same row: by its id (threads.edit re-emits it with new words), by uuid (the row drawn
      // on send), or (an older switchboard) the row drawn on send with the same words.
      let i = q.queued != null ? s.queued.findIndex(x => x.queued === q.queued) : -1;
      if (i < 0 && q.uuid) i = s.queued.findIndex(x => x.uuid === q.uuid);
      // The box mints its own uuid, so a row drawn on send is also this one by its words until the answer names it.
      if (i < 0) i = s.queued.findIndex(x => x.local && x.queued == null && sameText(x.text, q.text));
      if (i >= 0) {
        const was = s.queued[i];
        s.queued[i] = { ...q, uuid: q.uuid ?? was.uuid, queued: q.queued ?? was.queued, at: was.local ? q.at : was.at ?? q.at };
      } else s.queued.push(q);
      const uuid = s.queued[i >= 0 ? i : s.queued.length - 1].uuid;
      if (uuid) s.meta.texts.set(uuid, q.text);
      out.add("@queued");
      break;
    }
    case "thread.unqueued": {
      const before = s.queued.length;
      const gone = s.queued.filter(q => (p.queued != null && q.queued === p.queued) || (p.uuid && q.uuid === p.uuid));
      s.queued = s.queued.filter(q => !gone.includes(q));
      if (s.queued.length !== before) out.add("@queued");
      // Taken back: its words are no longer coming. Sent or steered: thread.sent or thread.steered follows with them.
      if (p.reason === "taken") for (const u of [p.uuid, ...gone.map(q => q.uuid)]) if (u) s.meta.texts.delete(String(u));
      break;
    }
    case "thread.steered": onSteered(s, p, at, out); break;
    case "thread.rewound": onRewound(s, p, at, out); break;
    case "mode.changed":
      if (typeof p.mode === "string") { s.mode = p.mode; out.add("@session"); }
      break;
    case "model.changed":
      // With a scope it is sessions.models.set (a purpose's or a project's default), not this thread.
      if (p.scope != null) break;
    // falls through
    case "model.switched": case "thread.model":
      if (p.model != null && p.model !== "") { s.model = String(p.model); out.add("@session"); }
      break;
    case "effort.switched":
      s.effort = typeof p.effort === "string" && p.effort ? p.effort : null; out.add("@session");
      break;
    case "thinking.switched":
      if (typeof p.on === "boolean") { s.thinking = p.on; out.add("@session"); }
      break;
    case "thread.task": {
      if (p.id == null || p.id === "") break;
      // The box names its tasks now: the ones guessed from tool calls give way.
      if (!s.meta.taskEvents) { s.meta.taskEvents = true; s.tasks = new Map(); }
      putTask(s, p, at);
      out.add("@tasks");
      break;
    }
    case "thread.shell": onShell(s, p, at, e, out); break;
    case "thread.remembered": {
      const key = `n:${e.id ?? ++s.meta.notices}`;
      if (s.byKey.has(key)) break;
      const file = String(p.file ?? "").split(/[\\/]/).pop() || "CLAUDE.md";
      const where = p.scope === "user" ? "yours, every project" : p.scope === "local" ? "this folder, not shared" : "this project";
      insert(s, /** @type {NoticeItem} */ ({ key, kind: "notice", text: `Remembered in ${file} (${where})`, ...(at !== undefined ? { at } : {}) }));
      out.add(key);
      break;
    }
    case "thread.text": onText(s, p, at, e, out); break;
    // Thinking as its own event: the same row as thread.text kind "reasoning".
    case "thread.thinking": onText(s, { ...p, kind: "reasoning", notice: undefined }, at, e, out); break;
    case "thread.tool": onTool(s, p, at, out); break;
    // The agent's checklist, whole each time: one row, updated in place. An empty list takes nothing away.
    case "thread.plan": {
      const items = (Array.isArray(p.items) ? p.items : []).filter((/** @type {any} */ x) => x && typeof x.text === "string" && x.text)
        .map((/** @type {any} */ x) => ({ text: String(x.text), status: x.status === "done" || x.status === "running" ? x.status : "pending" }));
      if (!items.length) break;
      const old = /** @type {PlanItem|undefined} */ (s.byKey.get("plan"));
      if (old) old.items = items;
      else insert(s, /** @type {PlanItem} */ ({ key: "plan", kind: "plan", items, ...(at !== undefined ? { at } : {}) }));
      out.add("plan");
      break;
    }
    // An artifact the agent made or changed (AR2): one card per version, drawn by cards/artifact.js.
    case "thread.artifact": {
      if (!p.artifact) break;
      const key = `art:${p.artifact}:${p.version ?? 0}`;
      if (s.byKey.has(key)) break;
      insert(s, /** @type {any} */ ({ key, kind: "tool", call: key, name: "artifact", status: "completed", ...(at !== undefined ? { at } : {}),
        render: { kind: "artifact", id: String(p.artifact), thread: p.thread ?? null, version: p.version ?? null, type: p.kind ?? null, title: p.title ?? null, agent: p.agent ?? null, at: at ?? null, ...(p.mime ? { mime: String(p.mime) } : {}), ...(Number.isFinite(p.bytes) ? { bytes: p.bytes } : {}) } }));
      out.add(key);
      break;
    }
    case "ask.raised": case "ask.answered": case "ask.cancelled": onAsk(s, e.type, p, at, out); break;
    case "thread.usage":
      // cost_usd is the turn's own, total_cost_usd the session's so far: never the one for the other.
      s.usage = { ...(s.usage || {}), ...(p.tokens ? { tokens: p.tokens } : {}), ...(p.cost_usd != null ? { cost_usd: p.cost_usd } : {}),
        ...(p.total_cost_usd != null ? { total_cost_usd: p.total_cost_usd } : {}), ...(p.context ? { context: p.context } : {}) };
      out.add("@session");
      break;
    case "thread.limit": {
      const { thread: _t, ...l } = p;
      s.limit = l;
      out.add("@session");
      break;
    }
    case "thread.finished": onFinished(s, p, at, out); break;
    case "thread.stopped":
      settle(s, out);
      s.stopped = String(p.reason || "stop");
      // Mirrors lib/thread-status.js's threadStatus() (sessions, 28a8b4f8) for the best guess
      // before any real thread.status arrives: an idle timeout, a restart or a rewind are all
      // "paused" (resumable, not wrong); a one-shot's own "done" or a bare exit is "finished"; a
      // nonzero code or a signal is "failed" - never read back as an ordinary idle close, and an
      // idle close never read back as a crash. Anything else (the person pressed Stop) is "stopped".
      guess(s, s.stopped === "idle" || s.stopped === "restart" || s.stopped === "rewind" ? "paused"
        : s.stopped === "done" || s.stopped === "exited" ? "finished"
        : s.stopped.startsWith("exited ") ? "failed"
        : "stopped");
      out.add("@session");
      break;
    default: break;
  }
  if (touchedTools(s, out)) derive(s, out);
  return [...out];
}

// ---- transcript blocks ------------------------------------------------------

/**
 * A block's identity: blocks are unique by seq, kind and (for tools) id; two text blocks on one
 * line (text, tool, text in one content array) are told apart by their order on the line.
 * @param {any} b @param {number} ord
 */
const identOf = (b, ord) => `${b.seq}:${b.kind}:${b.kind === "tool" ? b.id : ord}`;

/**
 * The live item a new transcript block stands for, or null. Only live items (no seq yet) match,
 * each once, first in order.
 * @param {Session} s @param {any} b @param {Set<string>} taken @param {any[]} list the read's blocks @param {number} i this block's place in it (the blocks after it are "later")
 */
function matchLive(s, b, taken, list, i, anyLive = true) {
  const live = (/** @type {Item} */ it) => it.seq === undefined && !taken.has(it.key);
  if (b.kind === "tool") return s.byKey.get(`t:${b.id}`) ?? null;
  // Nothing on screen came from live events (a page of history, a session opened from its file):
  // only a turn read earlier can stand for this block, so no search of the items per block.
  if (!anyLive && b.kind !== "turn") return null;
  if (b.kind === "user") {
    if (b.command) return null;
    const same = s.items.find(it => it.kind === "user" && live(it) && sameText(/** @type {UserItem} */ (it).text, b.text));
    if (same) return same;
    // Redaction or a cut can change the text: the oldest live message that no later line of this
    // read names, sent no earlier than a minute before this line was written, is the one. Only a
    // line past everything on screen from the file: a page of older history never matches.
    if (s.items.some(it => it.seq !== undefined && it.seq >= b.seq)) return null;
    return s.items.find(it => it.kind === "user" && live(it) && (!b.ts || it.at === undefined || b.ts >= it.at - 60000)
      && !laterNames(list, i, /** @type {UserItem} */ (it).text)) ?? null;
  }
  if (b.kind === "text") {
    if (b.message == null) return null;
    return s.items.find(it => it.kind === "text" && live(it) && /** @type {TextItem} */ (it).message === b.message) ?? null;
  }
  if (b.kind === "thinking") return s.items.find(it => it.kind === "reasoning" && live(it)) ?? null;
  if (b.kind === "shell") return s.items.find(it => it.kind === "shell" && live(it) && sameText(/** @type {ShellItem} */ (it).command, b.command)) ?? null;
  if (b.kind === "turn") {
    // An open turn read earlier closes in place; else the oldest live turn marker.
    for (let i = s.items.length - 1; i >= 0; i--) {
      const it = /** @type {TurnItem} */ (s.items[i]);
      if (it.kind === "turn" && it.open && it.seq !== undefined && it.seq <= b.seq && !taken.has(it.key)) return it;
      if (it.kind === "turn" && it.seq !== undefined) break;
    }
    return anyLive ? s.items.find(it => it.kind === "turn" && live(it)) ?? null : null;
  }
  return null;
}

/** Does a user line after `i` in the read name this text? (No copy of the rest of the read per block.) @param {any[]} list @param {number} i @param {string} text */
function laterNames(list, i, text) {
  for (let j = i + 1; j < list.length; j++) { const x = list[j]; if (x && x.kind === "user" && sameText(text, x.text)) return true; }
  return false;
}

/** A key for a block no live item stands for. @param {Session} s @param {any} b @param {number} ord */
function newKey(s, b, ord) {
  if (b.kind === "tool") return `t:${b.id}`;
  if (b.kind === "user") return `u:@${b.seq}`;
  if (b.kind === "turn") return `turn:@${b.seq}`;
  if (b.kind === "thinking") return `r:@${b.seq}:${ord}`;
  if (b.kind === "shell") return `sh:@${b.seq}:${ord}`;
  if (b.message == null) return `m:@${b.seq}:${ord}`;
  let n = 0;
  while (s.byKey.has(`m:${b.message}:${n}`)) n++;
  return `m:${b.message}:${n}`;
}

/** The transcript's fields for an item of a block's kind. @param {any} b */
function fieldsOf(b) {
  const at = typeof b.ts === "number" && b.ts ? { at: b.ts } : {};
  switch (b.kind) {
    case "user": return { kind: "user", text: String(b.text ?? ""), ...(b.command ? { command: true } : {}),
      ...(typeof b.uuid === "string" && b.uuid ? { uuid: b.uuid } : {}),
      ...(b.steered ? { steered: true, step: typeof b.step === "number" ? b.step : null } : {}),
      ...(Array.isArray(b.images) && b.images.length ? { images: b.images } : {}), ...at };
    case "text": return { kind: "text", message: b.message ?? null, text: String(b.text ?? ""), streaming: false, ...at };
    case "thinking": return { kind: "reasoning", text: String(b.text ?? ""), streaming: false, ...at };
    case "tool": {
      const output = b.output ?? null;
      /** @type {Record<string, any>} */
      const f = { kind: "tool", call: b.id, name: String(b.tool ?? ""), input: b.input ?? {}, output,
        detail: toolDetail(b.tool, b.input, output ?? undefined, { bodies: false }), duration_ms: b.duration_ms ?? null, ...at };
      if (output !== null) f.status = b.error ? "failed" : "completed";
      if (b.error) f.error = true;
      if (b.patch) f.patch = b.patch;
      // A result a card draws (cards/index.js renderOf): pr_review, email_thread, calendar_event, diff, report, artifact.
      if (b.render && typeof b.render === "object") f.render = b.render;
      // A tool's own picture (cohesion item 18): the caps are already applied by transcripts.blocks.
      if (Array.isArray(b.images) && b.images.length) f.images = b.images;
      return f;
    }
    case "turn": return { kind: "turn", duration_ms: b.duration_ms ?? null, tokens: b.tokens ?? null, model: b.model ?? null, open: Boolean(b.open), ...at };
    // What ran is known from the line; its exit code is not (a live row keeps its own).
    case "shell": return { kind: "shell", command: String(b.command ?? ""), output: String(b.output ?? ""), ...at };
    default: return null;
  }
}

/**
 * A user line that carried "!" lines (threads.shell's output, sent with the next message): shell
 * blocks on its line, then the person's own words. Other blocks as they are.
 * @param {any[]} list
 */
function withShells(list) {
  if (!list.some(b => b.kind === "user" && typeof b.text === "string" && b.text.includes("<bash-input>"))) return list;
  const out = [];
  for (const b of list) {
    const sp = b.kind === "user" && typeof b.text === "string" ? splitShells(b.text) : null;
    if (!sp || !sp.shells.length) { out.push(b); continue; }
    for (const sh of sp.shells) out.push({ seq: b.seq, kind: "shell", ...(b.ts !== undefined ? { ts: b.ts } : {}), command: sh.command, output: sh.output });
    out.push({ ...b, text: sp.text });
  }
  return out;
}

/** Shallow: does the item already hold these fields? @param {any} item @param {Record<string, any>} f */
const holds = (item, f) => Object.keys(f).every(k => JSON.stringify(item[k]) === JSON.stringify(f[k]));

/**
 * What threads.get's events say is still in flight, for a view opened on a transcript: the
 * transcript holds neither the queue nor words steered into a turn Claude has not reached yet
 * (an Edit waiting on Allow blocks the turn, so a steer sent then stays pending until the answer).
 * Returns, in their order and without their ids (so applyEvent takes them after the cursor moved
 * past), the thread.queued events of rows still waiting (not unqueued, not handed over) and the
 * thread.sent steers (via "steer" or "now") with no thread.steered after them and no turn end
 * since (thread.finished: taken in, or run as the next turn, which the transcript then holds).
 * @param {SessionEvent[]} events oldest first
 * @returns {SessionEvent[]}
 */
export function pendingEvents(events) {
  /** @type {Map<string, SessionEvent[]>} row id (or uuid) -> its thread.queued events */
  const rows = new Map();
  /** @type {Map<string, SessionEvent>} steer uuid -> its thread.sent */
  const steers = new Map();
  const rowKey = (/** @type {any} */ p) => (p.queued != null ? `q:${p.queued}` : p.uuid ? `u:${p.uuid}` : null);
  const drop = (/** @type {any} */ p) => {
    for (const [k, list] of rows) {
      const q = /** @type {any} */ (list[0].payload || {});
      if ((p.queued != null && q.queued === p.queued) || (p.uuid && q.uuid === p.uuid)) rows.delete(k);
    }
  };
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e.type !== "string") continue;
    const p = /** @type {any} */ (e.payload || {});
    if (e.type === "thread.queued") {
      const k = rowKey(p);
      if (k) rows.set(k, [...(rows.get(k) || []), e]);
    } else if (e.type === "thread.unqueued") drop(p);
    else if (e.type === "thread.sent") {
      if (p.queued != null || p.uuid) drop(p);
      if ((p.via === "steer" || p.via === "now") && p.uuid) steers.set(String(p.uuid), e);
    } else if (e.type === "thread.steered") { if (p.uuid) steers.delete(String(p.uuid)); }
    else if (e.type === "thread.finished" || e.type === "thread.stopped" || (e.type === "thread.turn" && p.steered)) steers.clear();
  }
  const keep = [...[...rows.values()].flat(), ...steers.values()];
  const order = (/** @type {SessionEvent} */ e) => (Array.isArray(events) ? events.indexOf(e) : 0);
  return keep.sort((a, b) => order(a) - order(b)).map(({ id, ...rest }) => /** @type {SessionEvent} */ (rest));
}

/**
 * Blocks from recall.transcript, in seq order. A block matching a live item swaps that item's
 * fields for the transcript's in place (same key, same position); a block read before is skipped
 * unless it grew (a tool's output arrived, a turn closed); any other block is inserted where it
 * falls. Returns the keys changed or added.
 * @param {Session} s @param {any[]} blocks @returns {string[]}
 */
export function applyBlocks(s, blocks) {
  /** @type {Set<string>} */
  const out = new Set();
  if (!Array.isArray(blocks) || !blocks.length) return [];
  /** @type {Set<string>} live items claimed by this read */
  const taken = new Set();
  /** @type {Map<string, number>} same-kind blocks per line, for identity */
  const ords = new Map();

  // First pass: which item each block is (or null for a new one), so a new block can be placed
  // before the next block that is already on screen.
  // A branch a rewind left is never drawn again, whatever the transcript still holds.
  const list = withShells(blocks.filter(b => b && typeof b === "object" && typeof b.seq === "number" && !(s.meta.rewinds.length && abandoned(s, b))));
  const anyLive = s.items.some(it => it.seq === undefined);
  const plan = list.map((b, i) => {
    const ok = `${b.seq}:${b.kind}`;
    const ord = ords.get(ok) ?? 0;
    ords.set(ok, ord + 1);
    const ident = identOf(b, ord);
    const known = s.meta.idents.get(ident);
    const item = known ? s.byKey.get(known) ?? null : matchLive(s, b, taken, list, i, anyLive);
    if (item) taken.add(item.key);
    return { b, ord, ident, item };
  });

  /** @type {string|null} the item the previous block became */
  let prev = null;
  /** Where `prev` was last seen in the items: a hint, so a long read is not a search per block. */
  const hint = { at: -1 };
  plan.forEach((step, i) => {
    const { b, ord, ident } = step;
    const f = fieldsOf(b);
    if (!f) return;
    let item = step.item;
    if (item) {
      if (b.kind === "tool" && item.kind === "tool") {
        // A live "running" is not taken back by a read that has no result yet.
        if (f.status === undefined) delete f.status;
        if (item.status === "canceled" && f.status === undefined) delete f.status;
      }
      if (item.seq !== b.seq || !holds(item, f)) {
        Object.assign(item, f, { seq: b.seq });
        out.add(item.key);
      }
      s.meta.idents.set(ident, item.key);
      if (item.kind === "user") userRead(s, /** @type {UserItem} */ (item), b, out);
      prev = item.key;
      return;
    }
    const key = newKey(s, b, ord);
    if (s.byKey.has(key)) { s.meta.idents.set(ident, key); prev = key; return; }
    /** @type {any} */
    const made = { key, ...f, seq: b.seq };
    if (made.kind === "reasoning") made.message = null;
    if (made.kind === "text" || made.kind === "reasoning") made.block = b.kind === "text" && b.message != null ? Number(key.split(":").pop()) : ord;
    if (made.kind === "tool" && !made.status) made.status = "running";
    if (made.kind === "shell") { made.exit = null; made.duration_ms = null; }
    const at = placeOf(s, plan, i, prev, hint.at);
    insert(s, made, at);
    hint.at = at >= 0 && at < s.items.length && s.items[at] === made ? at : s.items.length - 1;
    s.meta.idents.set(ident, key);
    out.add(key);
    if (made.kind === "user") userRead(s, made, b, out);
    prev = key;
  });
  if (touchedTools(s, out)) derive(s, out);
  return [...out];
}

/** A user block read: its uuid is known by it, and a steer gets its marker. @param {Session} s @param {UserItem} item @param {any} b @param {Set<string>} out */
function userRead(s, item, b, out) {
  if (item.uuid && !s.meta.uuids.has(item.uuid)) s.meta.uuids.set(item.uuid, item.key);
  if (!b.steered) return;
  const m = ensureMarker(s, item, { uuid: item.uuid ?? null, step: typeof b.step === "number" ? b.step : null, pending: false, seq: b.seq,
    ...(typeof b.ts === "number" && b.ts ? { at: b.ts } : {}) }, out);
  if (typeof b.ts === "number" && b.ts && m.at === undefined) m.at = b.ts;
}

/**
 * Where a new block goes: after the previous block's item; else before the next block in this
 * read that is already on screen; else before the first item later in the file; else after the
 * last item from the file and the live items that happened before this block (by time).
 * @param {Session} s @param {{ b: any, item: Item|null }[]} plan @param {number} i @param {string|null} prev
 * @param {number} [hint] where `prev` probably is (checked before a search)
 */
function placeOf(s, plan, i, prev, hint = -1) {
  if (prev) {
    let at = hint >= 0 && s.items[hint]?.key === prev ? hint + 1 : s.items.findIndex(it => it.key === prev) + 1;
    // A live notice from before this block (a rewind's, say) stays above it.
    const ts = plan[i].b.ts;
    while (at > 0 && at < s.items.length && ts && s.items[at].kind === "notice" && s.items[at].seq === undefined && (s.items[at].at ?? Infinity) <= ts) at++;
    if (at > 0) return at;
  }
  for (let j = i + 1; j < plan.length; j++) {
    const it = plan[j].item;
    if (it) { const at = s.items.indexOf(it); if (at >= 0) return at; }
  }
  const b = plan[i].b;
  const later = s.items.findIndex(it => it.seq !== undefined && it.seq > b.seq);
  if (later >= 0) return later;
  let at = 0;
  for (let k = s.items.length - 1; k >= 0; k--) if (s.items[k].seq !== undefined) { at = k + 1; break; }
  while (at < s.items.length) {
    const it = s.items[at];
    if (!b.ts || it.at === undefined || it.at > b.ts) break;
    at++;
  }
  return at;
}
