// @ts-check
// Durable transcript cache per chat: frames are written as they are folded so "offline" always has something to show.

import { messageIndex } from "./message-index.js";

const PREFIX = "vyre.chat.cache.";
const KEY = (/** @type {string} */ session) => `${PREFIX}${session}`;
const MAX = 400;

/** @param {string} session */
export function loadSessionCache(session) {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(KEY(session));
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.frames)) return null;
    return { head: Number(j.head) || 0, frames: j.frames, unsent: Array.isArray(j.unsent) ? j.unsent : [] };
  } catch { return null; }
}

/** `unsent` is the person's messages the box did not take (chat/unsent.js): kept so they still show as "Not sent" when the chat is opened again. @param {string} session @param {{ head: number, frames: any[], unsent?: any[] }} snap */
export function saveSessionCache(session, snap) {
  try {
    if (typeof localStorage === "undefined" || !snap || !Array.isArray(snap.frames)) return;
    const frames = snap.frames.slice(-MAX);
    const unsent = Array.isArray(snap.unsent) && snap.unsent.length ? { unsent: snap.unsent.slice(0, 50) } : {};
    localStorage.setItem(KEY(session), JSON.stringify({ head: snap.head | 0, frames, ...unsent, at: Date.now() }));
  } catch { /* quota or blocked storage */ }
}

/** @param {string} session */
export function hasSessionCache(session) {
  const c = loadSessionCache(session);
  return Boolean(c && c.frames.length);
}

/** Drop every cached chat transcript (sign-out: nothing readable stays in the browser store), and the on-device message index with it. */
export function clearAllSessionCaches() {
  messageIndex.clear();
  try {
    if (typeof localStorage === "undefined") return;
    const drop = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) drop.push(k);
    }
    for (const k of drop) localStorage.removeItem(k);
  } catch { /* blocked storage */ }
}
