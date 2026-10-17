// @ts-check
// Durable transcript cache per chat: frames are written as they are folded so "offline" always has something to show.

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
    return { head: Number(j.head) || 0, frames: j.frames };
  } catch { return null; }
}

/** @param {string} session @param {{ head: number, frames: any[] }} snap */
export function saveSessionCache(session, snap) {
  try {
    if (typeof localStorage === "undefined" || !snap || !Array.isArray(snap.frames)) return;
    const frames = snap.frames.slice(-MAX);
    localStorage.setItem(KEY(session), JSON.stringify({ head: snap.head | 0, frames, at: Date.now() }));
  } catch { /* quota or blocked storage */ }
}

/** @param {string} session */
export function hasSessionCache(session) {
  const c = loadSessionCache(session);
  return Boolean(c && c.frames.length);
}

/** Drop every cached chat transcript (sign-out: nothing readable stays in the browser store). */
export function clearAllSessionCaches() {
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
