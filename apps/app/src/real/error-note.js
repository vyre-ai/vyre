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
