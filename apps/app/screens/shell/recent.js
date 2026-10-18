// @ts-check
// The Recent list under the places: the few latest chats, newest first. Pure, so Node tests it.
import { mergeSessions, title } from "../../src/chat/core/sessions.js";

export const RECENT_SHOWN = 5;

/**
 * @param {unknown} threads what threads.list answers (an array, or { threads })
 * @returns {{ id: string, label: string, href: string }[]}
 */
export function recentChats(threads) {
  const list = Array.isArray(threads) ? threads : /** @type {any} */ (threads)?.threads ?? [];
  return mergeSessions([], list).slice().sort((a, b) => (b.last || 0) - (a.last || 0)).slice(0, RECENT_SHOWN)
    .map(r => ({ id: r.id, label: String(title(r) || "Chat").slice(0, 60), href: `/u/chats/${encodeURIComponent(r.id)}` }));
}
