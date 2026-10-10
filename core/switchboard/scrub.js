// @ts-check
// switchboard scrub: the ONE outgoing scrub of a session's own messages, for every provider (Claude, Codex, Grok), before anything persists or shows them (the transcript, Recall, the screen, events).
// Through the inference door every message out was cleaned (lib/door-bridge.js cleanOut); a run with no door (a subscription login goes direct) had nothing, so a CLI that printed its own login token or a
// key it read from a file would have landed it in the record. This does it once, here, with the same credential table every redactor reads (lib/credential-shapes.js).
// Four shapes carry words out: the assistant's text (and thinking), a stream delta, a tool call's input, and a tool's result (the reply to a call, and the turn's final result). A key split across two
// stream deltas is not caught by the delta; the whole text block that follows it is scrubbed whole, and that is what the record keeps.
import { redact } from "../../lib/credential-shapes.js";

/** Every string inside a value, redacted; the shape is kept. @param {any} v @returns {any} */
function deep(v) {
  if (typeof v === "string") return redact(v);
  if (Array.isArray(v)) return v.map(deep);
  if (v && typeof v === "object") { /** @type {Record<string, any>} */ const out = {}; for (const [k, x] of Object.entries(v)) out[k] = deep(x); return out; }
  return v;
}

/** One block of a message's content. @param {any} b */
function block(b) {
  if (!b || typeof b !== "object") return b;
  if (b.type === "text" && typeof b.text === "string") return { ...b, text: redact(b.text) };
  if (b.type === "thinking" && typeof b.thinking === "string") return { ...b, thinking: redact(b.thinking) };
  if (b.type === "tool_use") return { ...b, input: deep(b.input) };
  if (b.type === "tool_result") return { ...b, content: deep(b.content) };
  return b;
}

/**
 * A message from a session's agent, with credentials removed from every place it carries words. Anything else passes unchanged (init, usage, plan).
 * @param {any} m
 */
export function scrubOut(m) {
  if (!m || typeof m !== "object") return m;
  if ((m.type === "assistant" || m.type === "user") && m.message && Array.isArray(m.message.content)) return { ...m, message: { ...m.message, content: m.message.content.map(block) } };
  if (m.type === "stream_event" && m.event && m.event.delta && typeof m.event.delta === "object") {
    const d = m.event.delta;
    const delta = { ...d, ...(typeof d.text === "string" ? { text: redact(d.text) } : {}), ...(typeof d.thinking === "string" ? { thinking: redact(d.thinking) } : {}), ...(typeof d.partial_json === "string" ? { partial_json: redact(d.partial_json) } : {}) };
    return { ...m, event: { ...m.event, delta } };
  }
  if (m.type === "result" && typeof m.result === "string") return { ...m, result: redact(m.result) };
  return m;
}
