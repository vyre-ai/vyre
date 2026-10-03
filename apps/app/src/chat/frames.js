// @ts-check
// Stream frames folded into rows (docs/work/chat.md, 0.3 stream frame). Pure: no React, no clock.
// A frame is { v:1, id, cur, session, turn, type, time, corr, data }. The folder keeps one item per
// row, keyed so a re-read gives the same keys, and tells the caller what a frame touched:
//   - `layout`: a row was added (the transcript re-lays); anything else only repaints its own row.
//   - `touched`: item keys whose content changed.
// A frame with cur <= last is dropped (resume replays never repeat). A queued user message does
// not become a row: it sits in `queue()` (shown above the composer) until it is picked up.

/**
 * @typedef {{ v?: number, id?: string, cur: number, session?: string, turn?: string, type: string, time?: number, corr?: string, t?: number, data: any }} Frame
 * @typedef {{ key: string, kind: string, [k: string]: any }} Item
 * @typedef {{ type: "item", key: string, kind: string }} LayoutRow
 */

const STATES = ["starting", "working", "asking", "waiting", "paused", "stopped", "finished", "failed"];
/** Status changes that leave a quiet line in the transcript. */
const NOTICE_STATES = { paused: "Paused. Your next message resumes it.", stopped: "Stopped.", finished: "Finished.", failed: "The session failed." };

/** The states in which a message you send is queued, not taken. @param {string} state */
export const busyState = (state) => state === "working" || state === "asking" || state === "starting";

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
    if (f.cur <= last) return { ...out, dup: true };
    if (f.type !== "session.reset" && last > 0 && f.cur > last + 1) out.gap = true;
    last = f.cur;
    const d = f.data ?? {};
    const kind = f.type.replace(/^session\./, "");
    /** @param {string} key */
    const touch = (key) => { bump(key); out.touched.push(key); };
    switch (kind) {
      case "user-message": {
        const key = "u:" + d.message;
        if (d.state === "queued") {
          queued.set(key, { key, kind: "user", text: String(d.text ?? ""), queued: true, queuedAt: d.queued_at ?? f.time ?? 0 });
          queueSnap = [...queued.values()];
          bump("@queue");
        } else {
          if (queued.delete(key)) { queueSnap = [...queued.values()]; bump("@queue"); }
          const it = { key, kind: "user", text: String(d.text ?? items.get(key)?.text ?? ""), queued: false, pickedUp: d.state === "picked-up" };
          if (put(key, "user", it)) out.layout = true;
          else { items.set(key, it); }
          touch(key);
        }
        break;
      }
      case "text-delta": {
        const key = "a:" + d.message;
        const prev = items.get(key);
        const text = (prev?.text ?? "") + String(d.text ?? "");
        const it = { key, kind: "text", text, done: false };
        if (put(key, "text", it)) out.layout = true;
        else items.set(key, it);
        out.appended = { key, length: text.length };
        touch(key);
        break;
      }
      case "text-done": {
        const key = "a:" + d.message;
        if (patch(key, { done: true })) touch(key);
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
        const files = [{ path: String(d.path ?? ""), op: d.op ?? "edit", diff: typeof d.diff === "string" ? d.diff : "" }];
        put(key, "block", { key, kind: "block", tool: "file", toolKind: "file", summary: String(d.path ?? ""), status: "done", output: "", pct: null, block: { block: "diff", files } });
        out.layout = true;
        touch(key);
        break;
      }
      case "ask": {
        const key = "k:" + d.ask_id;
        const it = { key, kind: "ask", ask: String(d.ask_id), askKind: d.kind ?? "permission", task: d.task ?? null, title: d.title ?? null, state: "open", decision: null };
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
        last = f.cur;
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
