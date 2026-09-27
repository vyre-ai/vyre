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
// (the header fields) and "@queued" (the queue).

import { toolDetail } from "./tool-detail.js";

/**
 * @typedef {"starting"|"idle"|"running"|"waiting"|"stopped"|"failed"} SessionState
 * @typedef {{ key: string, kind: "user", text: string, uuid?: string, at?: number, seq?: number, command?: true, surface?: string|null }} UserItem
 * @typedef {{ key: string, kind: "text"|"reasoning", message: string|null, block: number, text: string, streaming: boolean, at?: number, seq?: number }} TextItem
 * @typedef {{ key: string, kind: "tool", call: string, name: string, status: "running"|"completed"|"failed"|"canceled", summary?: string,
 *   error?: string|boolean, input?: any, output?: string|null, detail?: import("./tool-detail.js").ToolDetail, duration_ms?: number|null,
 *   patch?: any, at?: number, seq?: number }} ToolItem
 * @typedef {{ key: string, kind: "turn", n?: number, ok?: boolean, result?: string, cost_usd?: number, tokens?: any, duration_ms?: number|null,
 *   error?: string, canceled?: boolean, reason?: string|null, model?: string|null, open?: boolean, at?: number, seq?: number }} TurnItem
 * @typedef {{ key: string, kind: "notice", text: string, at?: number }} NoticeItem
 * @typedef {{ key: string, kind: "ask", ask: string, askKind: string, tool: string|null, state: "open"|"answered"|"cancelled",
 *   decision?: string|null, summary?: string|null, answers?: any, at?: number }} AskItem
 * @typedef {UserItem|TextItem|ToolItem|TurnItem|NoticeItem|AskItem} Item
 * @typedef {{ ask: string, kind: string, tool: string|null, state: "open"|"answered"|"cancelled", decision: string|null, at: number|null }} Ask
 * @typedef {{ uuid: string|null, text: string, queued: number|string|null, at: number|null }} Queued
 * @typedef {{ type: string, payload?: any, at?: number, id?: number|string }} SessionEvent
 * @typedef {{
 *   thread: string, provider: string|null, model: string|null, auth: string|null, state: SessionState, turn: number|null,
 *   items: Item[], byKey: Map<string, Item>, queued: Queued[], asks: Map<string, Ask>,
 *   usage: any, limit: any, stopped: string|null,
 *   meta: { live: number, notices: number, turns: number, lastId: number, stateSeen: boolean,
 *     uuids: Map<string, string>, idents: Map<string, string> }
 * }} Session
 */

/** @param {string} thread @returns {Session} */
export function createSession(thread) {
  return {
    thread, provider: null, model: null, auth: null, state: "idle", turn: null,
    items: [], byKey: new Map(), queued: [], asks: new Map(), usage: null, limit: null, stopped: null,
    // Bookkeeping a view does not read: counters for keys, the newest event id applied, whether
    // the switchboard sends thread.state (then state is never guessed), uuid -> key for users
    // whose key was minted before their uuid was known, and transcript block identity -> key.
    meta: { live: 0, notices: 0, turns: 0, lastId: -Infinity, stateSeen: false, uuids: new Map(), idents: new Map() },
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

/** Streaming text is done, and tools still running are canceled: nothing more is coming. @param {Session} s @param {Set<string>} out */
function settle(s, out) {
  for (const it of s.items) {
    if ((it.kind === "text" || it.kind === "reasoning") && it.streaming) { it.streaming = false; out.add(it.key); }
    if (it.kind === "tool" && it.status === "running") { it.status = "canceled"; out.add(it.key); }
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
}

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
      for (const k of /** @type {const} */ (["provider", "model", "auth"])) if (p[k] != null) s[k] = String(p[k]);
      s.stopped = null;
      guess(s, "starting");
      out.add("@session");
      break;
    case "thread.state":
      if (typeof p.state === "string") { s.state = p.state; s.meta.stateSeen = true; out.add("@session"); }
      break;
    case "thread.sent": {
      if (p.queued != null || p.uuid) {
        const before = s.queued.length;
        s.queued = s.queued.filter(q => !((p.queued != null && q.queued === p.queued) || (p.uuid && q.uuid === p.uuid)));
        if (s.queued.length !== before) out.add("@queued");
      }
      liveUser(s, { text: String(p.text ?? ""), uuid: p.uuid || undefined, at, surface: p.surface ?? null }, out);
      guess(s, "running");
      out.add("@session");
      break;
    }
    case "thread.turn": {
      const m = /:(\d+)$/.exec(String(p.turn ?? ""));
      if (m) { s.turn = Number(m[1]); out.add("@session"); }
      if (typeof p.text === "string") liveUser(s, { text: p.text, uuid: p.uuid || undefined, at }, out);
      break;
    }
    case "thread.queued":
      s.queued.push({ uuid: p.uuid ?? null, text: String(p.text ?? ""), queued: p.queued ?? null, at: at ?? null });
      out.add("@queued");
      break;
    case "thread.unqueued": {
      const before = s.queued.length;
      s.queued = s.queued.filter(q => !((p.uuid && q.uuid === p.uuid) || (p.queued != null && q.queued === p.queued)));
      if (s.queued.length !== before) out.add("@queued");
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
    case "user": return { kind: "user", text: String(b.text ?? ""), ...(b.command ? { command: true } : {}), ...at };
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
    prev = key;
  });
  return [...out];
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
