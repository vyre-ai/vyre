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
// Steering (the composer's default while a turn runs): the words join the running turn at its
// next step. A steer is a user item plus a marker item just before it ("Steered at step N", key
// steer:<uuid>), placed where the words joined: localSend() draws both at once ("steering"),
// thread.sent {via: "steer"} (or "now", a queued row sent into the turn) echoes them, and
// thread.steered {uuid, turn} confirms them and moves them to the turn's tail. The event names no
// step: the step is counted here, the tool calls of that turn finished when it arrives. A
// transcript user block with steered: true (core/transcripts) gets the same marker on a re-read,
// with the transcript's step.
//
// The queue: rows are keyed by the box's threads_inbox row id (`queued`), uuid alongside.
// thread.queued adds a row, or (threads.edit) re-emits it with new words under the same id;
// thread.unqueued takes it away; thread.sent {queued, via: "turn"} hands it over at a turn's end
// (a message of its own) and {queued, via: "now"} steers it into the running turn.
// A rewind (thread.rewound {uuid, fork}) forks the session at that message: this session keeps
// every word, s.rewound names the fork (a new thread) and the words to take back there.

import { toolDetail } from "./tool-detail.js";

/**
 * @typedef {"starting"|"idle"|"running"|"waiting"|"stopped"|"failed"} SessionState
 * @typedef {{ key: string, kind: "user", text: string, uuid?: string, at?: number, seq?: number, command?: true, surface?: string|null,
 *   steered?: boolean, step?: number|null, local?: boolean, confirmed?: boolean }} UserItem
 * @typedef {{ key: string, kind: "steer", uuid: string|null, user: string|null, step: number|null, turn: string|null, pending: boolean,
 *   at?: number, seq?: number }} SteerItem
 * @typedef {{ key: string, kind: "text"|"reasoning", message: string|null, block: number, text: string, streaming: boolean, at?: number, seq?: number }} TextItem
 * @typedef {{ key: string, kind: "tool", call: string, name: string, status: "running"|"completed"|"failed"|"canceled", summary?: string,
 *   error?: string|boolean, input?: any, output?: string|null, detail?: import("./tool-detail.js").ToolDetail, duration_ms?: number|null,
 *   patch?: any, at?: number, seq?: number }} ToolItem
 * @typedef {{ key: string, kind: "turn", n?: number, ok?: boolean, result?: string, cost_usd?: number, tokens?: any, duration_ms?: number|null,
 *   error?: string, canceled?: boolean, reason?: string|null, model?: string|null, open?: boolean, at?: number, seq?: number }} TurnItem
 * @typedef {{ key: string, kind: "notice", text: string, at?: number }} NoticeItem
 * @typedef {{ key: string, kind: "ask", ask: string, askKind: string, tool: string|null, state: "open"|"answered"|"cancelled",
 *   decision?: string|null, summary?: string|null, answers?: any, at?: number }} AskItem
 * @typedef {{ key: string, kind: "shell", command: string, output: string, exit: number|null, duration_ms: number|null, error?: string, at?: number }} ShellItem
 * @typedef {UserItem|TextItem|ToolItem|TurnItem|NoticeItem|AskItem|SteerItem|ShellItem} Item
 * @typedef {{ ask: string, kind: string, tool: string|null, state: "open"|"answered"|"cancelled", decision: string|null, at: number|null }} Ask
 * @typedef {{ uuid: string|null, text: string, queued: number|string|null, at: number|null, local?: boolean }} Queued
 * @typedef {{ content: string, status: string, activeForm?: string }} Todo
 * @typedef {{ id: string, kind: "shell"|"agent", title: string, status: string, call?: string, at?: number|null, derived?: boolean }} Task
 * @typedef {{ type: string, payload?: any, at?: number, id?: number|string }} SessionEvent
 * @typedef {{
 *   thread: string, provider: string|null, model: string|null, auth: string|null, state: SessionState, turn: number|null,
 *   items: Item[], byKey: Map<string, Item>, queued: Queued[], asks: Map<string, Ask>,
 *   usage: any, limit: any, stopped: string|null,
 *   mode: string|null, modes: string[]|null, thinking: boolean|null,
 *   todos: { key: string, todos: Todo[] }|null, tasks: Map<string, Task>,
 *   rewound: { uuid: string, fork: string|null, text: string, at: number|null }|null, purpose: string|null,
 *   meta: { live: number, notices: number, turns: number, lastId: number, stateSeen: boolean,
 *     uuids: Map<string, string>, idents: Map<string, string>, texts: Map<string, string>, taskEvents: boolean }
 * }} Session
 */

/** @param {string} thread @returns {Session} */
export function createSession(thread) {
  return {
    thread, provider: null, model: null, auth: null, state: "idle", turn: null,
    items: [], byKey: new Map(), queued: [], asks: new Map(), usage: null, limit: null, stopped: null,
    mode: null, modes: null, thinking: null, todos: null, tasks: new Map(), rewound: null, purpose: null,
    // Bookkeeping a view does not read: counters for keys, the newest event id applied, whether
    // the switchboard sends thread.state (then state is never guessed), uuid -> key for users
    // whose key was minted before their uuid was known, transcript block identity -> key, the
    // words of queued messages by uuid (a hand-over or a steer from the queue may name only the
    // uuid), and whether thread.task events come (then tasks are theirs).
    meta: { live: 0, notices: 0, turns: 0, lastId: -Infinity, stateSeen: false, uuids: new Map(), idents: new Map(),
      texts: new Map(), taskEvents: false },
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
 * once it is known, so the row's buttons can name it. A plain send (idle) draws nothing:
 * thread.sent does. Returns the keys touched.
 * @param {Session} s @param {{ uuid: string, text: string, mode: "steer"|"queue"|null, at?: number, queued?: number|string|null }} m
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
  if (m.mode !== "steer") return [];
  liveUser(s, { text: m.text, uuid: m.uuid, at: m.at }, out);
  const user = /** @type {UserItem|undefined} */ (s.byKey.get(/** @type {string} */ (s.meta.uuids.get(m.uuid))));
  if (!user) return [...out];
  user.local = true;
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
      m = { key: `steer:${uuid}`, kind: "steer", uuid, user: null, step, turn: p.turn ?? null, pending: false };
      if (at !== undefined) m.at = at;
      insert(s, m);
    } else Object.assign(m, { step, pending: false });
    out.add(m.key);
    return;
  }
  // Where the words joined is the turn's tail now: a live item moves there, a transcript's stays.
  const m = ensureMarker(s, user, { uuid, step, pending: false, turn: p.turn ?? null, at }, out);
  if (at !== undefined) m.at = at;
  if (user.seq === undefined) { move(s, m); move(s, user); }
  user.steered = true;
  user.step = step;
  out.add(m.key);
  out.add(user.key);
}

/**
 * A rewind forks the session at a message of the person's (threads.rewind): the fork is a new
 * thread holding what came before it. This session keeps every word; a notice says where it went.
 * @param {Session} s @param {any} p @param {number|undefined} at @param {Set<string>} out
 */
function onRewound(s, p, at, out) {
  const uuid = String(p.uuid ?? "");
  const key = s.meta.uuids.get(uuid) ?? s.items.find(it => it.kind === "user" && it.uuid === uuid)?.key;
  const user = key ? /** @type {UserItem|undefined} */ (s.byKey.get(key)) : undefined;
  const fork = p.fork != null && p.fork !== "" ? String(p.fork) : null;
  s.rewound = { uuid, fork, text: user?.text ?? String(p.text ?? ""), at: at ?? null };
  out.add("@rewound");
  const nkey = `rw:${uuid}:${++s.meta.notices}`;
  const quote = s.rewound.text.length > 60 ? s.rewound.text.slice(0, 59) + "…" : s.rewound.text;
  const text = quote ? `Rewound to before "${quote}" in a new session` : "Rewound in a new session";
  insert(s, /** @type {NoticeItem} */ ({ key: nkey, kind: "notice", text, ...(at !== undefined ? { at } : {}) }));
  out.add(nkey);
}

/**
 * A "!" command the person ran in the session's folder, from threads.shell's answer (no event
 * carries it): a row with the command and its output. Returns the keys touched.
 * @param {Session} s
 * @param {{ id: string, command: string, output?: string, exit?: number|null, duration_ms?: number|null, error?: string, at?: number }} r
 */
export function localShell(s, r) {
  const key = `sh:${r.id}`;
  /** @type {ShellItem} */
  const item = { key, kind: "shell", command: r.command, output: String(r.output ?? ""), exit: r.exit ?? null, duration_ms: r.duration_ms ?? null,
    ...(r.error ? { error: r.error } : {}), ...(r.at !== undefined ? { at: r.at } : {}) };
  const was = s.byKey.get(key);
  if (was) Object.assign(was, item); else insert(s, item);
  return [key];
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
    item = /** @type {TextItem} */ ({ key: `${prefix}:${message}:${block}`, kind, message, block, text: "", streaming: true, ...(at !== undefined ? { at } : {}) });
    insert(s, item);
  }
  if (delta !== null) item.text += delta;
  if (text !== null) item.text = text;
  item.streaming = !done;
  out.add(item.key);
  guess(s, "running");
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
  out.add(key);
  guess(s, "running");
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
    guess(s, "waiting");
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
  if (![...s.asks.values()].some(x => x.state === "open")) guess(s, "running");
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
  guess(s, "idle");
  out.add("@session");
}

/**
 * thread.sent: a message went in. via "turn" (a queued row handed over at a turn's end) and a
 * plain send are messages of their own; via "steer" (threads.send into a running turn) and "now"
 * (threads.send_now, a queued row into the running turn) are steers: the words and a "steering"
 * marker until thread.steered. A hand-over may carry only its row id and uuid: the words are the
 * row's. A steer drawn on send that the box took as a plain message (the turn ended first) loses
 * its marker.
 * @param {Session} s @param {any} p @param {number|undefined} at @param {Set<string>} out
 */
function onSent(s, p, at, out) {
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
  if (user && user.seq === undefined) {
    const steer = p.via === "steer" || p.via === "now";
    const m = markerOf(s, user.key);
    if (steer) {
      user.steered = true;
      if (!m || m.pending) ensureMarker(s, user, { uuid, pending: true, turn: p.turn ?? null, ...(at !== undefined ? { at } : {}) }, out);
      out.add(user.key);
    } else if (p.via !== undefined && m && m.pending) {
      // Drawn as a steer, taken as a message of its own.
      const i = s.items.indexOf(m);
      if (i >= 0) s.items.splice(i, 1);
      s.byKey.delete(m.key);
      out.add(m.key);
      user.steered = false;
      out.add(user.key);
    }
  }
  guess(s, "running");
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
      if (typeof p.state === "string") { s.state = p.state; s.meta.stateSeen = true; out.add("@session"); }
      break;
    case "thread.sent": onSent(s, p, at, out); break;
    case "thread.turn": {
      const m = /:(\d+)$/.exec(String(p.turn ?? ""));
      if (m) { s.turn = Number(m[1]); out.add("@session"); }
      if (typeof p.text === "string") liveUser(s, { text: p.text, uuid: p.uuid || undefined, at }, out);
      break;
    }
    case "thread.queued": {
      /** @type {Queued} */
      const q = { uuid: p.uuid ?? null, text: String(p.text ?? ""), queued: p.queued ?? null, at: at ?? null };
      // The same row: by its id (threads.edit re-emits it with new words), by uuid (the row drawn
      // on send), or (an older switchboard) the row drawn on send with the same words.
      let i = q.queued != null ? s.queued.findIndex(x => x.queued === q.queued) : -1;
      if (i < 0 && q.uuid) i = s.queued.findIndex(x => x.uuid === q.uuid);
      if (i < 0 && !q.uuid) i = s.queued.findIndex(x => x.local && sameText(x.text, q.text));
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
    case "thread.mode":
      if (typeof p.mode === "string") s.mode = p.mode;
      if (Array.isArray(p.modes)) s.modes = p.modes.map(String);
      out.add("@session");
      break;
    case "thread.model":
      if (p.model != null) { s.model = String(p.model); out.add("@session"); }
      break;
    case "thread.thinking":
      if (typeof p.on === "boolean") { s.thinking = p.on; out.add("@session"); }
      break;
    case "thread.task": {
      const id = String(p.id ?? "");
      if (!id) break;
      // The box names its tasks now: the ones guessed from tool calls give way.
      if (!s.meta.taskEvents) { s.meta.taskEvents = true; s.tasks = new Map(); }
      const was = s.tasks.get(id);
      s.tasks.set(id, { id, kind: p.kind === "agent" ? "agent" : "shell", title: String(p.title ?? was?.title ?? ""), status: String(p.status ?? was?.status ?? "running"),
        at: was?.at ?? at ?? null });
      out.add("@tasks");
      break;
    }
    case "thread.text": onText(s, p, at, e, out); break;
    case "thread.tool": onTool(s, p, at, out); break;
    case "ask.raised": case "ask.answered": case "ask.cancelled": onAsk(s, e.type, p, at, out); break;
    case "thread.usage":
      s.usage = { ...(s.usage || {}), ...(p.tokens ? { tokens: p.tokens } : {}), ...(p.cost_usd != null ? { cost_usd: p.cost_usd } : {}),
        ...(p.context ? { context: p.context } : {}) };
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
      // Closed for idleness (ADR 0030 section 7): no process, but the next message resumes it.
      guess(s, /^(crash|exited [^0])/.test(s.stopped) ? "failed" : s.stopped === "idle" ? "idle" : "stopped");
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
      ...(b.steered ? { steered: true, step: typeof b.step === "number" ? b.step : null } : {}), ...at };
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
      return f;
    }
    case "turn": return { kind: "turn", duration_ms: b.duration_ms ?? null, tokens: b.tokens ?? null, model: b.model ?? null, open: Boolean(b.open), ...at };
    default: return null;
  }
}

/** Shallow: does the item already hold these fields? @param {any} item @param {Record<string, any>} f */
const holds = (item, f) => Object.keys(f).every(k => JSON.stringify(item[k]) === JSON.stringify(f[k]));

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
  const list = blocks.filter(b => b && typeof b === "object" && typeof b.seq === "number");
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
    if (hint >= 0 && s.items[hint]?.key === prev) return hint + 1;
    const at = s.items.findIndex(it => it.key === prev);
    if (at >= 0) return at + 1;
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
