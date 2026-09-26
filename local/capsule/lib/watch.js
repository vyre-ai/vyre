// @ts-check
// watch: "tell me when the intake thread is done". The Capsule keeps watches on threads and
// reports back when one finishes, stops or asks for something.
//
// It needs nothing new from vyred: the main process already follows the event stream, so a watch
// is a filter on events it sees anyway. Each watch fires once and is gone. What fired stays as a
// report (the thread, why, the last thing it said) until the user reads or clears it, and the
// main process turns each new report into a macOS notification.
//
// Watches and reports are kept in a small file beside the frecency file, so a Capsule that
// restarts still knows what the user is waiting for. Only thread ids, their labels, and the last
// reply's first 600 characters are kept.

import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {{ thread: string, label: string, until: "done"|"asks"|"either", at: number }} Watch
 * @typedef {{ id: string, thread: string, label: string, why: "finished"|"failed"|"stopped"|"asked", text: string,
 *   cost: number|null, at: number, read: boolean }} Report
 */

const KEEP_TEXT = 600;
const MAX_REPORTS = 30;

export class Watches {
  /** @param {{ file?: string|null, now?: () => number }} [opts] */
  constructor({ file = null, now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    /** @type {Map<string, Watch>} */
    this.watches = new Map();
    /** @type {Report[]} newest first */
    this.reports = [];
    /** @type {Map<string, string>} the last whole message each watched thread said */
    this.last = new Map();
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const w of j.watches || []) if (w && w.thread) this.watches.set(String(w.thread), w);
      this.reports = Array.isArray(j.reports) ? j.reports.slice(0, MAX_REPORTS) : [];
    } catch {}
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ watches: [...this.watches.values()], reports: this.reports }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {}
  }

  /** Watch a thread. Watching it again replaces the old watch. @param {string} thread @param {string} label */
  add(thread, label, until = /** @type {Watch["until"]} */ ("either")) {
    const w = { thread: String(thread), label: String(label || thread).slice(0, 80), until, at: this.now() };
    this.watches.set(w.thread, w);
    this.save();
    return w;
  }

  remove(thread) { const had = this.watches.delete(String(thread)); if (had) this.save(); return had; }

  has(thread) { return this.watches.has(String(thread)); }

  list() { return [...this.watches.values()]; }

  /** Reports not yet read, newest first. */
  unread() { return this.reports.filter(r => !r.read); }

  read(id) { const r = this.reports.find(x => x.id === id); if (r && !r.read) { r.read = true; this.save(); } return r || null; }

  clear() { this.reports = []; this.save(); }

  /**
   * One event from the stream. Returns the report it fired, or null.
   * @param {any} e
   * @returns {Report|null}
   */
  onEvent(e) {
    const thread = e && e.thread ? String(e.thread) : "";
    const w = thread ? this.watches.get(thread) : null;
    if (!w) return null;
    const p = e.payload || {};
    if (e.type === "thread.text" && p.done && typeof p.text === "string") { this.last.set(thread, p.text); return null; }
    let why = /** @type {Report["why"]|null} */ (null);
    if (e.type === "thread.finished" && w.until !== "asks") why = p.ok === false ? "failed" : "finished";
    else if (e.type === "thread.stopped" && w.until !== "asks") why = "stopped";
    else if (e.type === "ask.raised" && w.until !== "done") why = "asked";
    if (!why) return null;
    const text = why === "asked" ? String(p.summary || p.tool || "a question") : why === "failed" ? String(p.error || "") : this.last.get(thread) || "";
    const r = /** @type {Report} */ ({ id: `${thread}:${e.id || this.now()}`, thread, label: w.label, why, text: text.slice(0, KEEP_TEXT),
      cost: typeof p.cost_usd === "number" ? p.cost_usd : null, at: Number(e.at) || this.now(), read: false });
    this.watches.delete(thread);
    this.last.delete(thread);
    this.reports = [r, ...this.reports].slice(0, MAX_REPORTS);
    this.save();
    return r;
  }
}

/** The notification a report becomes: a title and one line. */
export function notice(r) {
  const title = r.why === "asked" ? `${r.label} is asking` : r.why === "failed" ? `${r.label} failed` : r.why === "stopped" ? `${r.label} stopped` : `${r.label} is done`;
  const body = (r.text || "").replace(/\s+/g, " ").trim().slice(0, 140) || (r.why === "finished" ? "It finished its turn." : "");
  return { title, body };
}

/** "watch the intake thread", "tell me when harlow is done": the name the user means, or null. */
export function watchWords(text) {
  const t = String(text || "").trim();
  const m = /^(?:watch|monitor|track)\s+(?:the\s+)?(.+?)(?:\s+thread)?(?:\s+and\s+tell\s+me.*)?$/i.exec(t)
    || /^(?:tell|ping|notify)\s+me\s+when\s+(?:the\s+)?(.+?)(?:\s+thread)?\s+(?:is\s+)?(?:done|finishes|finished|asks)\s*\.?$/i.exec(t);
  return m ? m[1].trim() : null;
}
