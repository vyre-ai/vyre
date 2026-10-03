// @ts-check
// The composer's pure side: which trigger is open at the caret (@ people and assistants, # records,
// / commands), how candidates rank, what a record's sealed fields say, and what Send does while a
// turn is on (it queues; the composer is never disabled). Reuses chat core's finders.

import { findMention, findVaultMention, applyMention, applyVault } from "../../../../deck/chat/core/composer-state.js";
import { findCommand, rankCommands, applyCommand } from "../../../../deck/chat/core/commands.js";
import { busyState } from "./frames.js";

/** @typedef {{ kind: "person" | "record" | "command", range: { start: number, end: number, query: string } }} Trigger */

/** The open trigger at the caret, if any. @param {string} text @param {number} caret @returns {Trigger | null} */
export function triggerAt(text, caret) {
  const c = findCommand(text, caret);
  if (c) return { kind: "command", range: c };
  const m = findMention(text, caret);
  if (m) return { kind: "person", range: m };
  const v = findVaultMention(text, caret);
  if (v) return { kind: "record", range: v };
  return null;
}

/** @template {{ name: string }} T @param {readonly T[]} list @param {string} query @returns {T[]} */
export function rankByName(list, query) {
  const q = String(query ?? "").trim().toLowerCase();
  const tier = (/** @type {string} */ n) => { const l = n.toLowerCase(); return !q || l.startsWith(q) ? 0 : l.includes(q) ? 1 : 2; };
  return list.filter((i) => tier(i.name) < 2).sort((a, b) => tier(a.name) - tier(b.name) || a.name.localeCompare(b.name));
}

/** "2 sealed fields" for the chip on a record with sealed fields, else null. @param {{ sealed?: number }} r */
export const sealedChip = (r) => (r.sealed ? `${r.sealed} sealed field${r.sealed === 1 ? "" : "s"}` : null);

/**
 * Pick a candidate: the text and caret after.
 * @param {string} text @param {Trigger} t @param {string} label
 */
export function pick(text, t, label) {
  if (t.kind === "command") return applyCommand(text, t.range, label);
  if (t.kind === "person") return applyMention(text, t.range, label);
  return applyVault(text, t.range, label);
}

/** What Send does. Never "disabled": empty is nothing to send; a busy turn queues. @param {{ text: string, attachments?: number, state: string }} o */
export function sendIntent({ text, attachments = 0, state }) {
  const has = text.trim().length > 0 || attachments > 0;
  if (!has) return { send: false, queue: false, label: "Send" };
  const queue = busyState(state);
  return { send: true, queue, label: queue ? "Queue" : "Send" };
}

/** @param {"mac" | "server"} where */
export const runsOnLabel = (where) => (where === "mac" ? "Runs on this Mac" : "Runs on the server");

export { rankCommands };
