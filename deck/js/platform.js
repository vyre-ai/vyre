// @ts-check
// Where the app is running, for presentation only (PLAN.md C22). The Windows app (Tauri) and the
// Mac app inject `window.__vyreShell = { os, version }` before the page's own scripts; a query or a
// header can't set it, so a link can't pretend to be the shell. It only changes how things look
// (Ctrl or Cmd glyphs, rail keys, no browser install card). It never grants anything, and the
// in-page Needs and Gate rows show whatever it says.

import { macKeys } from "./rail.js";

/** The desktop shell hosting this page, or null in a browser tab. @returns {{ os: string, version: string } | null} */
export function shell() {
  const s = /** @type {any} */ (globalThis).__vyreShell;
  return s && typeof s === "object" && typeof s.os === "string" ? { os: String(s.os), version: String(s.version || "") } : null;
}

/** Whether this is an installed app window (the shell, or an installed web app), not a browser tab. */
export function installed() {
  if (shell()) return true;
  try { return typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches; } catch { return false; }
}

/** Cmd on a Mac (the shell's word first, else the browser's), Ctrl everywhere else. */
export const mac = () => { const s = shell(); return s ? s.os === "mac" : macKeys(); };

/**
 * A key chord as this platform writes it: kbd("K") is "⌘K" on a Mac and "Ctrl+K" elsewhere;
 * kbd("Enter") is "⌘⏎" and "Ctrl+Enter".
 * @param {string} key
 */
export function kbd(key) {
  if (mac()) return "⌘" + (key === "Enter" ? "⏎" : key);
  return "Ctrl+" + key;
}
