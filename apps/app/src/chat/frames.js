// @ts-check
// Stream frames folded into rows (team/archive/work-journals/chat.md, 0.3 stream frame). Pure: no React, no clock.
// A frame is { v:1, id, cur, session, turn, type, time, corr, data }. The folder keeps one item per
// row, keyed so a re-read gives the same keys, and tells the caller what a frame touched:
//   - `layout`: a row was added (the transcript re-lays); anything else only repaints its own row.
//   - `touched`: item keys whose content changed.
// A frame with cur <= last is dropped (resume replays never repeat). A queued user message does
// not become a row: it sits in `queue()` (shown above the composer) until it is picked up.

/**
 * @typedef {{ v?: number, id?: string, cur: number, span?: number, session?: string, turn?: string|null, type: string, time?: number, corr?: string|null, t?: number,
 *   author?: string, acts_for?: string, message?: string, via?: string, data: any }} Frame
 * @typedef {{ key: string, kind: string, [k: string]: any }} Item
 * @typedef {{ type: "item", key: string, kind: string }} LayoutRow
 */

import { kindOf } from "./frame-type.js";
import { quoteFromData } from "./reply.js";
import { turnSummary } from "./turn-summary.js";

const STATES = ["starting", "working", "asking", "waiting", "paused", "stopped", "finished", "failed"];
/** Status changes that leave a quiet line in the transcript. */
/** A failed status whose note is one of these says it in the app's own words (the stream's plain frame for a reply that could not resume after a restart). */
const FAILED_NOTES = { "couldn't resume, ask again": "Couldn't resume. Ask again." };
const NOTICE_STATES = { paused: "Paused. Your next message resumes it.", stopped: "Stopped.", finished: "Finished.", failed: "This chat failed." };

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
const who = (f) => ({ ...(f.author ? { author: f.author } : {}), ...(f.acts_for ? { actsFor: f.acts_for } : {}), ...(f.via === "assistant" ? { via: "assistant" } : {}) });

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
  // A group chat's log carries no status frames (the stream drops them): its state is read from the
  // replies instead, working while any assistant's message is open and ready otherwise.
  let sawStatus = false;
  /** Where the turn in progress began in `rows`, and when (-1 while none is). */
  let turnFrom = -1, turnAt = 0;
  /** A group chat's turn (it has no status frames): the row after the person's last message, and that message's key. */
  let turnUserAt = -1, turnUserKey = "";
  /** @type {Set<string>} */ const open = new Set();
  const groupState = () => {
    if (sawStatus || !participants.size) return;
    const next = open.size ? "working" : "waiting";
    if (status.state !== next) { status.state = next; bump("@status"); }
  };
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
  /** Messages the person just sent that the box has not echoed yet: they show at once, dimmed, and go when the box's own row arrives (or the send fails). @type {{ key: string, text: string }[]} */
  let optimistic = [];
  let optimisticN = 0;
  /** The echo of a send takes the placeholder's place. @param {string} text */
  function settleOptimistic(text) {
    const i = optimistic.findIndex((o) => o.text.trim() === text.trim());
    if (i < 0) return false;
    dropRow(optimistic[i].key);
    optimistic.splice(i, 1);
    return true;
  }
  /** @param {string} key */
  function dropRow(key) {
    const at = rows.findIndex((r) => r.key === key);
    if (at >= 0) { rows.splice(at, 1); layoutRev++; }
    items.delete(key);
    bump(key);
  }

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
    const kind = kindOf(f.type);
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
        if (d.state !== "cancelled") settleOptimistic(String(d.text ?? ""));
        if (d.state === "cancelled") {
          // Taken back before it was picked up: it leaves the queue and was never a message.
          if (queued.delete(key)) { queueSnap = [...queued.values()]; bump("@queue"); }
        } else if (d.state === "queued") {
          queued.set(key, { key, kind: "user", text: String(d.text ?? ""), queued: true, queuedAt: d.queued_at ?? f.time ?? 0 });
          queueSnap = [...queued.values()];
          bump("@queue");
        } else {
          if (queued.delete(key)) { queueSnap = [...queued.values()]; bump("@queue"); }
          // A private message (enc) holds no words the home can read: the row says so, and a device that holds the key draws it (not built yet).
          const it = { key, kind: "user", text: d.enc !== undefined ? "Private message" : String(d.text ?? items.get(key)?.text ?? ""), ...(Array.isArray(d.attachments) && d.attachments.length ? { attachments: d.attachments.filter((/** @type {any} */ a) => a && typeof a.name === "string").map((/** @type {any} */ a) => ({ id: String(a.id), name: a.name, mime: String(a.mime || ""), bytes: Number(a.bytes) || 0 })) } : {}), ...(d.enc !== undefined ? { private: true } : {}), queued: false, pickedUp: d.state === "picked-up", ...(typeof f.time === "number" ? { at: f.time } : {}), ...(typeof d.tz === "string" && d.tz ? { tz: d.tz } : {}), ...who(f), ...(d.parent ? { parent: d.parent } : {}), ...quoteFromData(d) };
          if (put(key, "user", it)) out.layout = true;
          else { items.set(key, it); }
          if (d.state !== "cancelled") { turnUserAt = rows.findIndex((r) => r.key === key) + 1; turnUserKey = key; }
          touch(key);
        }
        break;
      }
      case "text-delta": {
        const mid = f.message ?? d.message;
        // Thinking is its own row, drawn folded under the reply it belongs to: never as the reply, and never dropped (the person may want to see how it got there).
        if (d.reasoning) {
          const rk = "r:" + mid + ":" + (d.index ?? 0);
          const before = items.get(rk);
          if (before && before.done) break;
          const rit = { key: rk, kind: "reasoning", text: (before?.text ?? "") + String(d.text ?? ""), done: false, ...(before ? { author: before.author, actsFor: before.actsFor } : who(f)), ...(d.provider ? { provider: String(d.provider), model: d.model ?? null } : before?.provider ? { provider: before.provider, model: before.model ?? null } : {}) };
          if (put(rk, "reasoning", rit)) out.layout = true;
          else items.set(rk, rit);
          touch(rk);
          break;
        }
        const key = "a:" + mid;
        const prev = items.get(key);
        // One row per message: two assistants streaming at once never share text. A finished or cut row takes no more.
        if (prev && prev.done) break;
        const text = (prev?.text ?? "") + String(d.text ?? "");
        open.add(String(mid));
        const it = { key, kind: "text", text, done: false, ...(d.via ? { via: String(d.via) } : prev?.via ? { via: prev.via } : {}), settled: Math.max(0, text.length - HOLDBACK), ...(prev ? { author: prev.author, actsFor: prev.actsFor, parent: prev.parent } : { ...who(f), ...(d.parent ? { parent: d.parent } : {}) }), ...(groupOf.has(mid) ? { group: groupOf.get(mid) } : {}), ...(d.provider ? { provider: String(d.provider), model: d.model ?? null } : prev?.provider ? { provider: prev.provider, model: prev.model ?? null } : {}) };
        if (put(key, "text", it)) out.layout = true;
        else items.set(key, it);
        out.appended = { key, length: text.length };
        touch(key);
        break;
      }
      case "step-summary": {
        // A group chat has no status frames; a step that closes is the cursored sign that the assistant did something. What the turn did so far is one line, kept under its last message.
        if (sawStatus || turnUserAt < 0) break;
        const sum = turnSummary(rows.slice(turnUserAt).map((r) => items.get(r.key)), 0);
        if (!sum) break;
        const key = "z:" + turnUserKey;
        const row = { key, kind: "turnsummary", ...sum };
        if (put(key, "turnsummary", row)) out.layout = true; else items.set(key, row);
        touch(key);
        break;
      }
      case "text-done": {
        const key = "a:" + (f.message ?? d.message);
        const it = items.get(key);
        open.delete(String(f.message ?? d.message));
        if (it && patch(key, { done: true, settled: it.text.length })) touch(key);
        const rk = "r:" + (f.message ?? d.message) + ":" + (d.index ?? 0);
        if (items.has(rk) && patch(rk, { done: true })) touch(rk);
        // the turn's line stays under the turn's last message
        const zk = "z:" + turnUserKey;
        if (turnUserKey && items.has(zk)) { const at = rows.findIndex((r) => r.key === zk); if (at >= 0 && at !== rows.length - 1) { const [r] = rows.splice(at, 1); rows.push(r); layoutRev++; out.layout = true; } }
        // The reply's cited fields (field-ref, drawn per viewer by the server into field blocks): one block row each, after its text.
        if (Array.isArray(d.blocks)) {
          d.blocks.slice(0, 8).forEach((/** @type {any} */ b, /** @type {number} */ i) => {
            const bk = "f:" + (f.message ?? d.message) + ":" + i;
            if (items.has(bk)) patch(bk, { block: b }); else put(bk, "block", { key: bk, kind: "block", tool: "field", toolKind: null, summary: "", status: "done", output: "", pct: null, block: b, ...who(f) });
            out.layout = true;
            touch(bk);
          });
        }
        break;
      }
      case "text-cut": {
        // The door caught a sealed value: the held-back tail was never final, so it goes.
        const key = "a:" + (f.message ?? d.message);
        const it = items.get(key);
        open.delete(String(f.message ?? d.message));
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
        // A person who joins sees the chat from their own join: the server sends who was there before as `quiet` (the roster, no marker), and the join itself is the one
        // marker a new participant sees, drawn as a quiet line ("Chris joined") with nothing above it.
        // A frame that names nobody and whose id is no readable name (a person's id, a model slot's) makes no line: "Per i44k... joined" tells a person nothing.
        if (d.quiet || (!names.has(String(d.who)) && /(^|:)per_|^model:|#/.test(String(d.who)))) break;
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
      case "handoff": {
        // "Asked kit (billing)": one row per request, its state replaced by every later frame; the teammate's own frames (data.via = the request) draw nested under it (IFACE-activity.md).
        const key = "h:" + d.request;
        const prev = items.get(key);
        const to = d.to && typeof d.to === "object" ? d.to : {};
        const ended = (/** @type {any} */ x) => x === "done" || x === "failed" || x === "cancelled";
        const it = { key, kind: "handoff", request: String(d.request), agent: String(to.agent ?? prev?.agent ?? ""), role: String(to.role ?? prev?.role ?? ""), name: String(to.name ?? prev?.name ?? to.agent ?? ""), project: to.project ?? prev?.project ?? null,
          text: String(d.text ?? prev?.text ?? ""), state: prev && ended(prev.state) && !ended(d.state) ? prev.state : String(d.state ?? "queued"), thread: d.thread ?? prev?.thread ?? null, result: d.result ?? prev?.result ?? null, ...who(f) };
        if (put(key, "handoff", it)) out.layout = true;
        else items.set(key, it);
        touch(key);
        // The report-back is its own row, after the teammate's steps that came before it, so the conversation reads in the order it happened.
        const rk = "hr:" + d.request;
        if (it.result && !items.has(rk)) { put(rk, "handoffResult", { key: rk, kind: "handoffResult", request: it.request, name: it.name, state: it.state, result: it.result }); out.layout = true; touch(rk); }
        break;
      }
      case "tool-started": {
        const key = "t:" + d.tool_id;
        const rk = d.kind && d.kind !== "tool" ? "block" : "tool";
        const it = { key, kind: rk, tool: String(d.tool ?? "tool"), toolKind: d.kind ?? null, summary: String(d.summary ?? ""), status: "running", output: "", pct: null, block: null, ...(d.via ? { via: String(d.via) } : {}) };
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
        // A turn begins when the chat starts working and ends when it stops: what it did is one line under it.
        if (state === "working" && status.state !== "working") { turnFrom = rows.length; turnAt = f.time ?? 0; }
        else if (status.state === "working" && state !== "working" && turnFrom >= 0) {
          const sum = turnSummary(rows.slice(turnFrom).map((r) => items.get(r.key)), turnAt && f.time ? f.time - turnAt : 0);
          turnFrom = -1;
          if (sum) { const key = "z:" + f.cur; put(key, "turnsummary", { key, kind: "turnsummary", ...sum }); out.layout = true; touch(key); }
        }
        sawStatus = true;
        status.state = state;
        status.turn = d.turn ?? status.turn;
        status.stopping = Boolean(d.stopping);
        bump("@status");
        const notice = (state === "failed" && typeof d.note === "string" && /** @type {Record<string, string>} */ (FAILED_NOTES)[d.note]) || /** @type {Record<string, string>} */ (NOTICE_STATES)[state];
        if (notice) {
          const key = "s:" + f.cur;
          put(key, "notice", { key, kind: "notice", text: notice });
          out.layout = true;
          touch(key);
        }
        break;
      }
      case "reset": {
        rows = []; items.clear(); queued.clear(); queueSnap = []; layoutRev++; optimistic = [];
        open.clear(); participants.clear(); names.clear(); presence.clear(); reactions.clear(); pins.clear(); mentions.clear(); groups.clear(); groupOf.clear();
        last = typeof d.head === "number" ? d.head : f.cur;
        bump("@status");
        return { ...out, layout: true, reset: true };
      }
      default:
        break;
    }
    groupState();
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
    /** A message the person just sent, shown at once and dimmed until the box echoes it; returns its row key. @param {string} text */
    addOptimistic(text) {
      const key = "o:" + ++optimisticN;
      optimistic.push({ key, text });
      put(key, "user", { key, kind: "user", text, queued: false, pickedUp: false, pending: true });
      return key;
    },
    /** The send failed: the placeholder goes. @param {string} key */
    dropOptimistic(key) {
      const i = optimistic.findIndex((o) => o.key === key);
      if (i < 0) return false;
      optimistic.splice(i, 1);
      dropRow(key);
      return true;
    },
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
