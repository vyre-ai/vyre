// @ts-check
// A headless thread's output as the right pane shows it: lines of plain text, each with a
// style, built from thread events. The words come from formatEvent (the same as
// `vyre threads watch`), so the screen and the watch never describe an event differently.
//
// Every event is kept by id, so the backlog from threads.get and the live stream can overlap
// without a line showing twice, and events that arrive before the backlog are held, not lost.

import { formatEvent } from "../commands/threads.js";
import { sanitize } from "./width.js";

const MAX_LINES = 1000;

/** @typedef {{ text: string, style: "text"|"dim"|"beacon"|"sent" }} Line */
/** @typedef {{ lines: Line[], open: boolean, streamed: Set<string>, last: number, ready: boolean, queued: any[] }} Transcript */

/** @returns {Transcript} */
export function transcript() {
  return { lines: [], open: false, streamed: new Set(), last: 0, ready: false, queued: [] };
}

const styleOf = e => {
  if (e.type === "thread.text") return e.payload && e.payload.notice ? "dim" : "text";
  if (e.type === "ask.raised") return "beacon";
  if (e.type === "thread.sent") return "sent";
  return "dim";
};

/** Add text to the transcript: continues an open line, and ends it when the text ends in \n. */
function write(tr, s, style) {
  const parts = sanitize(s, { newlines: true }).split("\n");
  parts.forEach((part, i) => {
    if (i === 0 && tr.open) tr.lines[tr.lines.length - 1].text += part;
    else tr.lines.push({ text: part, style });
  });
  tr.open = !s.endsWith("\n");
  if (!tr.open) tr.lines.pop(); // the empty piece after the last \n
  if (tr.lines.length > MAX_LINES) tr.lines.splice(0, tr.lines.length - MAX_LINES);
}

/**
 * One event into the transcript. Events at or before the last one applied are skipped, so the
 * same event from the backlog and from the stream shows once. Returns whether anything changed.
 * @param {Transcript} tr @param {{ id?: number|string, type: string, payload?: any }} e
 */
export function apply(tr, e) {
  const id = Number(e.id) || 0;
  if (!tr.ready) { tr.queued.push(e); return false; }
  if (id && id <= tr.last) return false;
  if (id) tr.last = id;
  if (e.type === "ask.raised") {
    const p = e.payload || {};
    end(tr);
    write(tr, `? ${p.tool || "tool"}: ${p.summary || ""}${p.destination ? " -> " + p.destination : ""}\n`, "beacon");
    write(tr, "  in the Inbox: a allows, d denies\n", "dim");
    return true;
  }
  const s = formatEvent(/** @type {any} */ (e), tr.streamed);
  if (s == null) return false;
  const inline = e.type === "thread.text" && Boolean(e.payload && e.payload.delta);
  if (tr.open && !inline && s !== "\n") end(tr);
  if (s === "\n") { end(tr); return true; }
  write(tr, s, styleOf(e));
  return true;
}

function end(tr) { tr.open = false; }

/**
 * The backlog arrived: apply it, then whatever the stream delivered while it was on its way.
 * @param {Transcript} tr @param {any[]} events oldest first
 */
export function load(tr, events) {
  tr.ready = true;
  const queued = tr.queued;
  tr.queued = [];
  for (const e of events) apply(tr, e);
  for (const e of queued) apply(tr, e);
}
