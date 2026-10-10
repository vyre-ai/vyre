// @ts-check
// The one outgoing scrub (REVIEW-LEDGER 35): every message a session's process prints is cleaned of credential shapes before the Switchboard translates it, for every provider,
// so what reaches the transcript, recall and the screen never holds a key the agent happened to print (a token it read from its own login file, a key from an environment dump). It is the table every redactor
// reads (lib/credential-shapes.js). The four places a message carries words: an assistant text block, a tool_use input, a streamed text delta, and the turn's result.
import { redact } from "../../lib/credential-shapes.js";

/** @param {string} s */
const text = s => redact(s);

/** A tool_use input, cleaned as JSON so its shape survives; an input that no longer parses is kept as the cleaned text. @param {unknown} input */
function cleanInput(input) {
  const s = JSON.stringify(input ?? {});
  const r = redact(s);
  if (r === s) return input;
  try { return JSON.parse(r); } catch { return { text: r }; }
}

/**
 * A copy of the message with credential shapes taken out of the words it carries; the very same object when there is nothing to take out.
 * @param {any} m
 */
export function scrubOut(m) {
  if (!m || typeof m !== "object") return m;
  if (m.type === "assistant" && m.message && Array.isArray(m.message.content)) {
    let changed = false;
    const content = m.message.content.map((/** @type {any} */ b) => {
      if (b && b.type === "text" && typeof b.text === "string") { const t = text(b.text); if (t !== b.text) { changed = true; return { ...b, text: t }; } }
      if (b && b.type === "tool_use" && b.input !== undefined) { const i = cleanInput(b.input); if (i !== b.input) { changed = true; return { ...b, input: i }; } }
      return b;
    });
    return changed ? { ...m, message: { ...m.message, content } } : m;
  }
  if (m.type === "stream_event" && m.event && m.event.delta && typeof m.event.delta.text === "string") {
    const t = text(m.event.delta.text);
    return t === m.event.delta.text ? m : { ...m, event: { ...m.event, delta: { ...m.event.delta, text: t } } };
  }
  if (m.type === "result" && typeof m.result === "string") {
    const t = text(m.result);
    return t === m.result ? m : { ...m, result: t };
  }
  return m;
}
