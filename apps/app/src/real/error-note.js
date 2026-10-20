// @ts-check
// What the error card shows for a failed call: the box's words, then what to do, then the code (G28; the entries are in lib/error-catalogue.js). The box names the specifics in its message; the
// catalogue says what the code means and the recourse. A code with no entry still shows the code and the message, never nothing.
import { entryFor } from "../../../../lib/error-catalogue.js";

/**
 * @param {{ code?: unknown, message?: unknown } | null | undefined} error
 * @param {string} [fallback] the words when the error has none
 * @returns {{ code: string, title: string, reason: string, recourse: string }}
 */
export function errorNote(error, fallback = "That did not go through.") {
  const code = error && typeof error.code === "string" ? error.code : "";
  const e = code ? entryFor(code) : null;
  const message = error && typeof error.message === "string" ? error.message.trim() : "";
  return { code, title: e ? e.title : "", reason: message || (e ? e.description : fallback), recourse: e ? e.recourse : "" };
}

/** Words a person should not read: a tool or call name (spaces.list), a record or Space address, an internal id, a code in brackets. */
const TECHNICAL = /\b[a-z][a-z0-9_-]*\.[a-z][a-z0-9_.-]*\b|vyre:\/\/|\bspc_[a-z2-7]{6,}|\bper_[a-z0-9]{6,}|\b[a-z]+_[a-z_]+\b|[{}[\]]/;

/**
 * One line for a toast or a banner, in plain words: the box's own sentence when it is one a person can read, else the catalogue's title and what to do, else the fallback. Never a raw tool name, address or code.
 * @param {unknown} error an Error, a { code, message } or anything thrown
 * @param {string} [fallback] the words when nothing better is known
 */
export function plainError(error, fallback = "That did not go through. Try again.") {
  const e = error && typeof error === "object" ? /** @type {{ code?: unknown, message?: unknown }} */ (error) : { message: typeof error === "string" ? error : "" };
  const n = errorNote({ code: e.code, message: e.message }, fallback);
  const said = typeof e.message === "string" ? e.message.trim() : "";
  // the box's sentence, with a trailing pointer in brackets for a model ("(spaces.list shows ...)") taken off
  const own = said.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const sentence = (/** @type {string} */ s) => { const t = s.charAt(0).toUpperCase() + s.slice(1); return /[.!?]$/.test(t) ? t : `${t}.`; };
  if (own && !TECHNICAL.test(own)) return sentence(own);
  if (n.title) return `${sentence(n.title)}${n.recourse ? ` ${n.recourse}` : ""}`;
  return fallback;
}
