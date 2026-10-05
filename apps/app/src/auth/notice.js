// @ts-check
// What the person is told about their sign-in on this device. A paired device renews its own session with its key (wink-2, work/wink-session), so nothing is said while that works: no
// "ends in N days", no "sign in again". A notice appears only when a renewal FAILED, or when the browser will not keep the sign-in. The server refuses a failed renewal with one answer
// whatever the reason (`denied`, so the box tells nobody whether a device is locked, removed or wrong), so the words cover that case honestly; server text is never rendered.

import { REMOVED_NOTICE } from "../identity/wipe.js";

/** @typedef {"denied" | "unreachable" | "other"} RenewFailure */
/** @typedef {{ storageRefused: boolean, renewFailed: RenewFailure | null, removed?: boolean }} NoticeState */
/** @type {NoticeState} */
let state = { storageRefused: false, renewFailed: null, removed: readRemoved() };
/** A browser that wiped itself on removal reloads: the flag it left in the tab says why it is empty, once. */
function readRemoved() {
  try { if (typeof sessionStorage !== "undefined" && sessionStorage.getItem("vyre.removed") === "1") { sessionStorage.removeItem("vyre.removed"); return true; } } catch { /* no storage */ }
  return false;
}
/** @type {Set<() => void>} */
const subs = new Set();
const set = (/** @type {Partial<NoticeState>} */ p) => { state = { ...state, ...p }; for (const f of [...subs]) f(); };

/** The server removed this device: say so on the pairing screen. */
export const noteRemoved = () => set({ removed: true });
export const noteStorageRefused = () => { if (!state.storageRefused) set({ storageRefused: true }); };

/** What kind of failure a refused renewal was, from the error's code alone. @param {string | undefined} code @returns {RenewFailure} */
export const failureOf = (code) => (code === "denied" ? "denied" : code === "offline" || code === "unreachable" || code === "timeout" ? "unreachable" : "other");

/** A renewal failed: keep what kind. An unreachable server is not a refusal of the device, so it only says it will retry. @param {string | undefined} code */
export const noteRenewFailed = (code) => set({ renewFailed: failureOf(code) });
/** A session was renewed (or a new one made): the failure notice goes away. */
export const noteRenewed = () => { if (state.renewFailed !== null) set({ renewFailed: null }); };
export const clearNotice = () => set({ renewFailed: null });
export const snapshot = () => state;
/** @param {() => void} f */
export const subscribe = (f) => { subs.add(f); return () => { subs.delete(f); }; };

/** The words for a failed renewal. Never the server's own text. @param {RenewFailure} kind */
export function renewWords(kind) {
  if (kind === "unreachable") return "Cannot reach your server right now. You stay signed in; this will retry.";
  if (kind === "denied") return "This device could not sign in again. If it was locked after failed sign-ins, it unlocks by itself in 15 minutes. If it was removed, pair it again from your phone.";
  return "Signing in again did not work. If it keeps happening, pair this device again from your phone.";
}

/** What to say, or null. A failed renewal first, then the storage notice. @param {NoticeState} s @returns {{ tone: "warn" | "plain", text: string } | null} */
export function sessionNotice(s) {
  if (s.removed) return { tone: /** @type {const} */ ("warn"), text: REMOVED_NOTICE };
  if (s.renewFailed) return { tone: s.renewFailed === "unreachable" ? "plain" : "warn", text: renewWords(s.renewFailed) };
  if (s.storageRefused) return { tone: "plain", text: "This browser will not keep your sign-in, so it ends when you close this tab. Allow site storage to stay signed in." };
  return null;
}
