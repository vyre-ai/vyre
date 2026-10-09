// @ts-check
// The words a "waiting on you" row is written in (core/approvals items, core/waiting). A title reaches every device and the lock screen, so anything shaped like a credential is dropped whole.
import { mentionsCredentialPrefix } from "./credential-shapes.js";

export const TITLE_MAX = 120;
export const DETAIL_MAX = 160;

const SECRET = [
  { test: (/** @type {string} */ s) => mentionsCredentialPrefix(s) },   // a key prefix anywhere (lib/credential-shapes.js)
  /[A-Za-z0-9_+/=-]{32,}/,
  /\b(password|passwd|secret|token|api[_-]?key)\s*[=:]/i,
];
/** @param {unknown} s */
export const one = s => String(s ?? "").replace(/\s+/g, " ").trim();
/** @param {string} s @param {number} n */
export const cap = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
/** @param {unknown} s @param {number} [n] @returns {string} empty when it looks like a secret */
export const clean = (s, n = TITLE_MAX) => { const t = one(s); return t && !SECRET.some(r => r.test(t)) ? cap(t, n) : ""; };
/** @param {unknown} v */
export const at = v => (typeof v === "number" && Number.isFinite(v) ? v : 0);
/** @param {string} k @param {unknown} v */
export const opt = (k, v) => (v ? { [k]: v } : {});
