// @ts-check
// A project's group chat, pure: the answer of work.project.chat { project } -> { chat, missing[], extra[] } read as open, missing (the tool is not on this box yet, so the screen shows nothing) or failed.
// Tested by chat.test.js. The screen is useProjectChat.ts.

/** @param {{ data?: any, error?: { code: string, message: string } } | undefined} r @returns {{ state: "open", chat: string, missing: string[], extra: string[] } | { state: "missing" } | { state: "failed", why: string }} */
export function chatAnswer(r) {
  if (r && r.error) {
    const e = r.error;
    if (e.code === "unknown_tool" || e.code === "no_such_tool" || (e.code === "not_found" && /no such tool/i.test(e.message || ""))) return { state: "missing" };
    return { state: "failed", why: e.message || "The group chat did not open." };
  }
  const d = r && r.data;
  if (!d || typeof d.chat !== "string" || !d.chat) return { state: "failed", why: "The group chat did not open." };
  return { state: "open", chat: d.chat, missing: Array.isArray(d.missing) ? d.missing.map(String) : [], extra: Array.isArray(d.extra) ? d.extra.map(String) : [] };
}

/** Where a chat opens. @param {string} id */
export const chatPath = (id) => `/u/chats/${encodeURIComponent(id)}`;
