// @ts-check
// Rows from the paired Mac (docs/work/federation.md, design 5). On the box, the catalogue, search,
// sessions and threads take in the Mac's rows too, each labelled `source: "mac"` and `machine`.
// The Deck shows them with a machine chip and reads them, but never acts on them: a Mac thread
// runs on the Mac, so sending, resuming, stopping or answering it from here would act on nothing
// or on the wrong machine. Box rows (and every row on a Mac, which is never labelled) get no chip.
//
// Whether a paired Mac is away comes from link.macs, the box's own record of which Macs hold a
// request open. It is read once per view load or refresh, never while the page is hidden, and the
// Mac itself is never asked.

import { h } from "./dom.js";

/** Is this row the Mac's? @param {any} row */
export const isMac = row => !!row && row.source === "mac";

/** The note in place of a Mac row's actions. @param {any} row */
export const readOnlyNote = row => `On ${machineOf(row)}. Open it there to continue.`;

/** The Mac's name for a row, "your Mac" when the row does not say. @param {any} row */
const machineOf = row => (row && row.machine ? String(row.machine) : "your Mac");

/**
 * The machine chip for a Mac row, or null for any other row.
 * @param {any} row
 * @returns {HTMLElement | null}
 */
export function machineChip(row) {
  if (!isMac(row)) return null;
  return h("span", { class: "tag machine", title: `On ${machineOf(row)}` }, machineOf(row));
}

/**
 * The names of the paired Macs that are offline, from link.macs's answer.
 * @param {any} macs
 * @returns {string[]}
 */
export function offlineNames(macs) {
  return (Array.isArray(macs) ? macs : []).filter(m => m && m.online === false).map(m => String(m.name || m.node || "your Mac"));
}

/**
 * One quiet chip per offline Mac, where that Mac's rows would appear, or null when none is away.
 * @param {any} macs link.macs's answer
 * @returns {HTMLElement | null}
 */
export function offlineChip(macs) {
  const names = offlineNames(macs);
  if (!names.length) return null;
  return h("span", { class: "machine-offline" }, names.map(n => h("span", { class: "tag machine off", title: `${n} is not reachable, so its sessions are not listed` }, `${n} offline`)));
}

/**
 * Read link.macs for a view that is loading or refreshing. While the page is hidden it keeps what
 * it had rather than asking. A machine without the link (a Mac, or a box without the module)
 * answers no Macs.
 * @param {(tool: string, input?: any) => Promise<{ data?: any, error?: any }>} attempt js/api.js's attempt
 * @param {any[]} [prev] the last answer, kept while hidden
 * @returns {Promise<any[]>}
 */
export async function readMacs(attempt, prev = []) {
  if (typeof document !== "undefined" && document.hidden) return prev;
  const r = await attempt("link.macs");
  return Array.isArray(r.data) ? r.data : [];
}
