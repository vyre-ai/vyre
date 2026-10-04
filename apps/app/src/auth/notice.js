// @ts-check
// What the person is told about their sign-in on this device: the browser would not keep it (so it ends with the tab), it ends soon (a 30-day session), or it has ended. One small shared
// state, no storage of its own for anything secret; the expiry time is a number the box already gave. Pure helpers plus a tiny store a screen subscribes to.

const DAY = 86_400_000;
/** Warn this long before the session ends. */
export const SOON_MS = 3 * DAY;

/** @typedef {{ storageRefused: boolean, expires: number | null, ended: boolean }} NoticeState */
/** @type {NoticeState} */
let state = { storageRefused: false, expires: null, ended: false };
/** @type {Set<() => void>} */
const subs = new Set();
const set = (/** @type {Partial<NoticeState>} */ p) => { state = { ...state, ...p }; for (const f of [...subs]) f(); };

export const noteStorageRefused = () => { if (!state.storageRefused) set({ storageRefused: true }); };
/** The box's `expires` (ms epoch) for the session it just gave. A later one replaces it and ends any "ended" state. @param {number} ms */
export const noteExpires = (ms) => { if (Number.isFinite(ms) && ms > 0) set({ expires: ms, ended: false }); };
export const noteEnded = () => set({ ended: true });
export const clearNotice = () => set({ expires: null, ended: false });
export const snapshot = () => state;
/** @param {() => void} f */
export const subscribe = (f) => { subs.add(f); return () => { subs.delete(f); }; };

/** What to say, most urgent first, or null. @param {NoticeState} s @param {number} now @returns {{ tone: "warn" | "plain", text: string } | null} */
export function sessionNotice(s, now) {
  if (s.ended || (s.expires !== null && s.expires <= now)) return { tone: "warn", text: "Your sign-in on this device has ended. Sign in again from your phone." };
  if (s.expires !== null && s.expires - now <= SOON_MS) {
    const days = Math.max(1, Math.ceil((s.expires - now) / DAY));
    return { tone: "warn", text: `Your sign-in on this device ends in ${days} ${days === 1 ? "day" : "days"}. Sign in again from your phone before then.` };
  }
  if (s.storageRefused) return { tone: "plain", text: "This browser will not keep your sign-in, so it ends when you close this tab. Allow site storage to stay signed in." };
  return null;
}
