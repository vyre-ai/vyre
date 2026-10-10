// @ts-check
// The one outgoing scrub (REVIEW-LEDGER 35): every message a session's process prints is cleaned of credential shapes before the Switchboard translates it, for every provider, so what reaches the
// transcript, recall and the screen never holds a key the agent happened to print (a token it read from its own login file, a key from an environment dump). It is the table every redactor reads
// (lib/credential-shapes.js). It reads no provider's format: every piece of text anywhere in a message (words, a tool call's input, streamed words, a result, a tool's output) is cleaned the same way, so a
// provider that changes its message shape is still covered. Costs one pass over the message's strings.
import { redact } from "../../lib/credential-shapes.js";

/** @param {any} v @param {number} depth @returns {any} the same value when nothing in it changed */
function clean(v, depth) {
  if (typeof v === "string") return v.length < 12 ? v : redact(v);
  if (!v || typeof v !== "object") return v;
  // Too deep to walk (a model or a tool controls how deep its output nests): the rest is cleaned as one piece of text, so a key at any depth goes.
  if (depth > 12) {
    let s; try { s = JSON.stringify(v); } catch { return "[too deep to show]"; }
    const r = redact(s);
    if (r === s) return v;
    try { return JSON.parse(r); } catch { return "[too deep to show]"; }
  }
  if (Array.isArray(v)) {
    let out = /** @type {any[] | null} */ (null);
    v.forEach((x, i) => { const c = clean(x, depth + 1); if (c !== x) { out = out || v.slice(); out[i] = c; } });
    return out || v;
  }
  /** @type {Record<string, any> | null} */ let out = null;
  for (const k of Object.keys(v)) { const x = v[k], c = clean(x, depth + 1); if (c !== x) { out = out || { ...v }; out[k] = c; } }
  return out || v;
}

/**
 * A copy of the message with credential shapes taken out of every text it carries; the very same object when there is nothing to take out.
 * @param {any} m
 */
export const scrubOut = m => clean(m, 0);
