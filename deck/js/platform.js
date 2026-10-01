// @ts-check
// Where the app is running, for presentation only (PLAN.md C22). The Windows app (Tauri) and the
// Mac app inject `window.__VYRE_SHELL__ = { platform }` before the page's own scripts; a query or a
// header can't set it, so a link can't pretend to be the shell. It only changes how things look
// (Ctrl or Cmd glyphs, rail keys, no browser install card). It never grants anything, and the
// in-page Needs and Gate rows show whatever it says.

import { macKeys } from "./mac-keys.js";

/**
 * The desktop shell hosting this page, or null in a browser tab. The Windows app injects
 * `window.__VYRE_SHELL__ = { platform: "windows" }` (frozen, before any page script); the older
 * `__vyreShell = { os, version }` still reads. `os` is "windows", "mac" or "linux" whichever spelling came.
 * @returns {{ os: string, version: string } | null}
 */
export function shell() {
  const g = /** @type {any} */ (globalThis);
  const s = g.__VYRE_SHELL__ && typeof g.__VYRE_SHELL__ === "object" ? g.__VYRE_SHELL__ : g.__vyreShell;
  const raw = s && typeof s === "object" ? (typeof s.platform === "string" ? s.platform : typeof s.os === "string" ? s.os : "") : "";
  if (!raw) return null;
  const os = /^(mac|macos|darwin|osx)$/i.test(raw) ? "mac" : /^win/i.test(raw) ? "windows" : /^linux$/i.test(raw) ? "linux" : raw.toLowerCase();
  return { os, version: String(s.version || "") };
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
