// @ts-check
// Stream frames folded into rows (docs/work/chat.md, 0.3 stream frame). Pure: no React, no clock.
// A frame is { v:1, id, cur, session, turn, type, time, corr, data }. The folder keeps one item per
// row, keyed so a re-read gives the same keys, and tells the caller what a frame touched:
//   - `layout`: a row was added (the transcript re-lays); anything else only repaints its own row.
//   - `touched`: item keys whose content changed.
// A frame with cur <= last is dropped (resume replays never repeat). A queued user message does
// not become a row: it sits in `queue()` (shown above the composer) until it is picked up.

/**
 * @typedef {{ v?: number, id?: string, cur: number, span?: number, session?: string, turn?: string|null, type: string, time?: number, corr?: string|null, t?: number,
 *   author?: string, acts_for?: string, message?: string, data: any }} Frame
 * @typedef {{ key: string, kind: string, [k: string]: any }} Item
 * @typedef {{ type: "item", key: string, kind: string }} LayoutRow
 */

const STATES = ["starting", "working", "asking", "waiting", "paused", "stopped", "finished", "failed"];
/** Status changes that leave a quiet line in the transcript. */
const NOTICE_STATES = { paused: "Paused. Your next message resumes it.", stopped: "Stopped.", finished: "Finished.", failed: "The session failed." };

/** The states in which a message you send is queued, not taken. @param {string} state */
export const busyState = (state) => state === "working" || state === "asking" || state === "starting";

/** The last characters of streamed text the door may still cut: provisional until text-done. Same as core/stream HOLDBACK (frames.test.js checks). */
export const HOLDBACK = 40;
/** Frames with no cursor: delivered as they come, never replayed. */
const EPHEMERAL = ["presence", "read-marker"];
/** A name a person can read for an id nobody named: "person:alex" is "Alex", "assistant:kit-2" is "Kit 2". @param {string} id */
export const plainName = (id) => {
  const s = String(id).slice(String(id).indexOf(":") + 1).replace(/[-_.]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : String(id);
};
/** Who wrote a frame, for the row. @param {Frame} f */
const who = (f) => ({ ...(f.author ? { author: f.author } : {}), ...(f.acts_for ? { actsFor: f.acts_for } : {}) });

/** @param {string} b64 */
function decode(b64) {
  try {
    if (typeof atob === "function") {
      const bin = atob(b64);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }
  } catch {}
  return "";
}

export function createFolder() {
  /** @type {LayoutRow[]} */ let rows = [];
  /** @type {Map<string, Item>} */ const items = new Map();
  /** @type {Map<string, number>} */ const revs = new Map();
  /** @type {Map<string, Item>} */ const queued = new Map();
  let last = 0;
  let snap = /** @type {LayoutRow[]} */ ([]);
  let snapRev = -1;
  let layoutRev = 0;
  let queueSnap = /** @type {Item[]} */ ([]);
  const status = { state: "starting", turn: /** @type {string|null} */ (null), stopping: false };
  /** @type {Map<string, { role?: string }>} */ const participants = new Map();
  /** @type {Map<string, string>} who -> the name its participant frame gave */ const names = new Map();
  const nameOf = (/** @type {string} */ id) => names.get(id) ?? plainName(id);
  /** @type {Map<string, { state: string, doing?: string, at: number }>} */ const presence = new Map();
  /** @type {Map<string, Map<string, Set<string>>>} message -> emoji -> who */ const reactions = new Map();
  /** @type {Set<string>} */ const pins = new Set();
  /** @type {Map<string, string[]>} message -> who was mentioned */ const mentions = new Map();
  /** @type {Map<string, { group: string, question: string, members: { who: string, message: string }[], keep: string|null }>} */ const groups = new Map();
  /** @type {Map<string, string>} answer message -> group */ const groupOf = new Map();
  const read = { upto: 0 };

  /** @param {string} key @param {string} kind @param {Item} item */
  function put(key, kind, item) {
    const had = items.has(key);
    items.set(key, item);
    if (!had) {
      rows.push({ type: "item", key, kind });
      layoutRev++;
    }
    return !had;
  }
  /** @param {string} key @param {Record<string, any>} patch */
  function patch(key, patch) {
    const it = items.get(key);
    if (!it) return null;
    const next = { ...it, ...patch };
    items.set(key, next);
    return next;
  }
  const bump = (/** @type {string} */ k) => revs.set(k, (revs.get(k) ?? 0) + 1);

  /**
   * @param {Frame} f
   * @returns {{ dup: boolean, gap: boolean, layout: boolean, touched: string[], reset?: boolean, appended?: { key: string, length: number } | null }}
   */
  function apply(f) {
    const out = { dup: false, gap: false, layout: false, touched: /** @type {string[]} */ ([]), appended: /** @type {{ key: string, length: number } | null} */ (null) };
    if (!f || typeof f.cur !== "number" || typeof f.type !== "string") return { ...out, dup: true };
    const d = f.data ?? {};
    const kind = f.type.replace(/^session\./, "");
    // Ephemeral frames have no cursor: they never move `last`, and a repeat is harmless.
    if (EPHEMERAL.includes(kind)) {
      if (kind === "presence") { presence.set(String(d.who), { state: d.state, ...(d.doing ? { doing: d.doing } : {}), at: f.time ?? 0 }); bump("@presence"); }
      else if (typeof d.upto === "number" && d.upto > read.upto) { read.upto = d.upto; bump("@read"); }
      return { ...out, dup: true };
    }
    // Control frames (cur 0): a heartbeat changes nothing; a reset clears and takes the log's head.
    if (kind === "heartbeat") return { ...out, dup: true };
    if (kind !== "reset") {
      if (f.cur <= last) return { ...out, dup: true };
      // A merged history frame covers `span` cursors and ends at `cur`.
      if (last > 0 && f.cur - (f.span ?? 1) + 1 > last + 1) out.gap = true;
      last = f.cur;
    }
    /** @param {string} key */
    const touch = (key) => { bump(key); out.touched.push(key); };
    switch (kind) {
      case "user-message": {
        const key = "u:" + d.message;
        if (d.state === "cancelled") {
          // Taken back before it was picked up: it leaves the queue and was never a message.
          if (queued.delete(key)) { queueSnap = [...queued.values()]; bump("@queue"); }
        } else if (d.state === "queued") {
          queued.set(key, { key, kind: "user", text: String(d.text ?? ""), queued: true, queuedAt: d.queued_at ?? f.time ?? 0 });
          queueSnap = [...queued.values()];
          bump("@queue");
        } else {
          if (queued.delete(key)) { queueSnap = [...queued.values()]; bump("@queue"); }
          const it = { key, kind: "user", text: String(d.text ?? items.get(key)?.text ?? ""), queued: false, pickedUp: d.state === "picked-up", ...who(f), ...(d.parent ? { parent: d.parent } : {}) };
          if (put(key, "user", it)) out.layout = true;
          else { items.set(key, it); }
          touch(key);
        }
        break;
      }
      case "text-delta": {
        if (d.reasoning) break; // thinking is not drawn as a reply
        const mid = f.message ?? d.message;
        const key = "a:" + mid;
        const prev = items.get(key);
        // One row per message: two assistants streaming at once never share text. A finished or cut row takes no more.
        if (prev && prev.done) break;
        const text = (prev?.text ?? "") + String(d.text ?? "");
        const it = { key, kind: "text", text, done: false, settled: Math.max(0, text.length - HOLDBACK), ...(prev ? { author: prev.author, actsFor: prev.actsFor, parent: prev.parent } : { ...who(f), ...(d.parent ? { parent: d.parent } : {}) }), ...(groupOf.has(mid) ? { group: groupOf.get(mid) } : {}) };
        if (put(key, "text", it)) out.layout = true;
        else items.set(key, it);
        out.appended = { key, length: text.length };
        touch(key);
        break;
      }
      case "text-done": {
        const key = "a:" + (f.message ?? d.message);
        const it = items.get(key);
        if (it && patch(key, { done: true, settled: it.text.length })) touch(key);
        break;
      }
      case "text-cut": {
        // The door caught a sealed value: the held-back tail was never final, so it goes.
        const key = "a:" + (f.message ?? d.message);
        const it = items.get(key);
        if (it) {
          const text = it.text.slice(0, it.settled ?? Math.max(0, it.text.length - HOLDBACK));
          patch(key, { done: true, text, settled: text.length, cut: String(d.note ?? "") });
          touch(key);
        }
        break;
      }
      case "participant-joined":
      case "participant-left": {
        if (typeof d.name === "string" && d.name) names.set(String(d.who), d.name);
        if (kind === "participant-joined") participants.set(String(d.who), { ...(d.role ? { role: d.role } : {}) }); else participants.delete(String(d.who));
        bump("@participants");
        const key = "p:" + f.cur;
        put(key, "notice", { key, kind: "notice", text: `${nameOf(String(d.who))} ${kind === "participant-joined" ? "joined" : "left"}` });
        out.layout = true;
        touch(key);
        break;
      }
      case "reaction": {
        const m = String(d.message);
        let byEmoji = reactions.get(m);
        if (!byEmoji) { byEmoji = new Map(); reactions.set(m, byEmoji); }
        let set = byEmoji.get(d.emoji);
        if (!set) { set = new Set(); byEmoji.set(d.emoji, set); }
        const a = f.author ?? "";
        if (d.on) set.add(a); else set.delete(a);
        if (!set.size) byEmoji.delete(d.emoji);
        bump("r:" + m);
        out.touched.push("a:" + m, "u:" + m);
        break;
      }
      case "pin": {
        if (d.on) pins.add(String(d.message)); else pins.delete(String(d.message));
        bump("@pins");
        out.touched.push("a:" + d.message, "u:" + d.message);
        break;
      }
      case "mention": {
        mentions.set(String(d.message), Array.isArray(d.who) ? d.who.map(String) : []);
        out.touched.push("a:" + d.message, "u:" + d.message);
        break;
      }
      case "fanout": {
        // One question to several assistants or models: their answers are one group until one is kept.
        const g = { group: String(d.group), question: String(d.message), members: Array.isArray(d.members) ? d.members.map((/** @type {any} */ m) => ({ who: String(m.who), message: String(m.message) })) : [], keep: /** @type {string|null} */ (null) };
        groups.set(g.group, g);
        for (const m of g.members) {
          groupOf.set(m.message, g.group);
          const it = items.get("a:" + m.message);
          if (it) { items.set("a:" + m.message, { ...it, group: g.group }); out.touched.push("a:" + m.message); }
        }
        bump("@groups");
        break;
      }
      case "fanout-keep": {
        const g = groups.get(String(d.group));
        if (g && g.members.some((m) => m.message === d.keep)) { g.keep = String(d.keep); bump("@groups"); for (const m of g.members) out.touched.push("a:" + m.message); }
        break;
      }
      case "tool-started": {
        const key = "t:" + d.tool_id;
        const rk = d.kind && d.kind !== "tool" ? "block" : "tool";
        const it = { key, kind: rk, tool: String(d.tool ?? "tool"), toolKind: d.kind ?? null, summary: String(d.summary ?? ""), status: "running", output: "", pct: null, block: null };
        if (put(key, rk, it)) out.layout = true;
        else items.set(key, it);
        touch(key);
        break;
      }
      case "tool-progress": {
        const key = "t:" + d.tool_id;
        const it = items.get(key);
        if (it) {
          patch(key, { output: it.output + (typeof d.text === "string" ? d.text : ""), pct: typeof d.pct === "number" ? d.pct : it.pct });
          touch(key);
        }
        break;
      }
      case "tool-finished": {
        const key = "t:" + d.tool_id;
        const status = d.ok === false ? "failed" : "done";
        if (items.has(key)) patch(key, { status, block: d.result ?? null });
        else if (put(key, d.result ? "block" : "tool", { key, kind: d.result ? "block" : "tool", tool: String(d.tool ?? "tool"), toolKind: null, summary: "", status, output: "", pct: null, block: d.result ?? null })) out.layout = true;
        touch(key);
        break;
      }
      case "term-chunk": {
        const key = "x:" + d.term;
        const text = decode(String(d.b64 ?? ""));
        const prev = items.get(key);
        if (prev) patch(key, { output: prev.output + text });
        else { put(key, "block", { key, kind: "block", tool: "terminal", toolKind: "terminal", summary: "Terminal", status: "running", output: text, pct: null, block: null, term: true }); out.layout = true; }
        touch(key);
        break;
      }
      case "term-command": {
        const key = "c:" + f.cur;
        put(key, "notice", { key, kind: "notice", text: "You ran " + String(d.command ?? "") });
        out.layout = true;
        touch(key);
        break;
      }
      case "file-changed": {
        const key = "f:" + f.cur;
        // `diff` is a Block ({ block: "diff", files }) from core/stream, or a plain unified diff.
        const dd = d.diff;
        const block = dd && typeof dd === "object" && dd.block ? dd : { block: "diff", files: [{ path: String(d.path ?? ""), op: d.op ?? "edit", diff: typeof dd === "string" ? dd : "" }] };
        put(key, "block", { key, kind: "block", tool: "file", toolKind: "file", summary: String(d.path ?? ""), status: "done", output: "", pct: null, block });
        out.layout = true;
        touch(key);
        break;
      }
      case "ask": {
        const key = "k:" + d.ask_id;
        const it = { key, kind: "ask", ask: String(d.ask_id), askKind: d.kind ?? "permission", task: d.task ?? null, title: d.title ?? d.summary ?? null, state: "open", decision: null };
        if (put(key, "ask", it)) out.layout = true;
        else items.set(key, it);
        touch(key);
        break;
      }
      case "ask-answered": {
        const key = "k:" + d.ask_id;
        if (patch(key, { state: "answered", decision: d.decision ?? "approve" })) touch(key);
        break;
      }
      case "status": {
        const state = STATES.includes(d.state) ? d.state : status.state;
        status.state = state;
        status.turn = d.turn ?? status.turn;
        status.stopping = Boolean(d.stopping);
        bump("@status");
        const notice = /** @type {Record<string, string>} */ (NOTICE_STATES)[state];
        if (notice) {
          const key = "s:" + f.cur;
          put(key, "notice", { key, kind: "notice", text: notice });
          out.layout = true;
          touch(key);
        }
        break;
      }
      case "reset": {
        rows = []; items.clear(); queued.clear(); queueSnap = []; layoutRev++;
        participants.clear(); names.clear(); presence.clear(); reactions.clear(); pins.clear(); mentions.clear(); groups.clear(); groupOf.clear();
        last = typeof d.head === "number" ? d.head : f.cur;
        bump("@status");
        return { ...out, layout: true, reset: true };
      }
      default:
        break;
    }
    return out;
  }

  /** Fold many frames at once (history, a resume replay); one result for the lot. @param {readonly Frame[]} frames */
  function applyAll(frames) {
    let layout = false;
    let reset = false;
    const touched = new Set();
    for (const f of frames) {
      const r = apply(f);
      if (r.layout) layout = true;
      if (r.reset) reset = true;
      for (const k of r.touched) touched.add(k);
    }
    return { layout, reset, touched: [...touched] };
  }

  return {
    apply,
    applyAll,
    /** The layout rows, oldest first; a new array only when a row was added or removed. */
    get rows() {
      if (snapRev !== layoutRev) { snap = rows.slice(); snapRev = layoutRev; }
      return snap;
    },
    get last() { return last; },
    get status() { return status; },
    /** @param {string} key */
    item: (key) => items.get(key) ?? null,
    /** @param {string} key */
    rev: (key) => revs.get(key) ?? 0,
    /** Who is in the chat, from participant-joined and -left. */
    participants: () => [...participants.keys()],
    /** A readable name for a participant id: the name its frame gave, else the id's own word, capitalised. */
    name: nameOf,
    /** Who is typing or doing what right now (the caller expires entries older than a few seconds). */
    presence: () => [...presence].map(([who, p]) => ({ who, ...p })),
    /** Reactions on a message: [{ emoji, who: [...] }]. @param {string} message */
    reactions: (message) => [...(reactions.get(message) ?? [])].map(([emoji, s]) => ({ emoji, who: [...s] })),
    /** Pinned message ids. */
    pinned: () => [...pins],
    /** Who a message mentioned. @param {string} message */
    mentioned: (message) => mentions.get(message) ?? [],
    /** A fan-out group: its answers, and the one kept (null until a tap keeps one). @param {string} group */
    group: (group) => { const g = groups.get(group); return g ? { ...g, members: g.members.slice() } : null; },
    /** This person's read marker: the cursor they have read up to. */
    get readUpto() { return read.upto; },
    /** Queued user messages, oldest first; they leave when picked up. */
    queue: () => queueSnap,
    size: () => items.size,
  };
}

/** The words for the header chip. @param {{ state: string, stopping?: boolean }} s */
export function headerState(s) {
  if (s.stopping && busyState(s.state)) return { word: "stopping", busy: true, canStop: false };
  if (s.state === "asking") return { word: "needs you", busy: true, canStop: true };
  if (busyState(s.state)) return { word: s.state === "starting" ? "starting" : "working", busy: true, canStop: true };
  if (s.state === "waiting") return { word: "ready", busy: false, canStop: false };
  return { word: s.state, busy: false, canStop: false };
}
