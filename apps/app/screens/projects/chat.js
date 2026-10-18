// @ts-check
// A project's group chat, pure: the answer of work.project.chat { project } read as one of five states. The tool returns { chat, id, member, people[], missing[], extra[], readonly[], readonly_for_you }; a person who is on the
// team but not yet in the chat gets { member: false, waiting: true }, a viewer asking before anyone made it gets { chat: null, pending: true }, and a writer asking before anyone made it gets { chat: null, needs_ring: true } (a device makes the ring and asks again). `missing` are team members not in the chat yet, `extra` people in it who are
// not on the team: a device in the chat applies both (work.chat.change), so the screen only says it is under way. Tested by chat.test.js. The hook is useProjectChat.ts.

/**
 * @param {{ data?: any, error?: { code: string, message: string } } | undefined} r
 * @returns {{ state: "open", chat: string, adding: number, readOnly: boolean } | { state: "making" } | { state: "waiting" } | { state: "pending" } | { state: "missing" } | { state: "failed", why: string }}
 */
export function chatAnswer(r) {
  if (r && r.error) {
    const e = r.error;
    if (e.code === "unknown_tool" || e.code === "no_such_tool" || (e.code === "not_found" && /no such tool/i.test(e.message || ""))) return { state: "missing" };
    return { state: "failed", why: e.message || "The group chat did not open." };
  }
  const d = r && r.data;
  if (d && d.pending === true && !d.chat) return { state: "pending" };
  // no chat yet and the server never makes the key: a device in the team makes the ring (ensureProjectChat) and asks again. The person is not shown this; the page waits.
  if (d && d.needs_ring === true && !d.chat) return { state: "making" };
  if (d && d.member === false && d.waiting === true) return { state: "waiting" };
  if (!d || typeof d.chat !== "string" || !d.chat) return { state: "failed", why: "The group chat did not open." };
  return { state: "open", chat: d.chat, adding: Array.isArray(d.missing) ? d.missing.length : 0, readOnly: d.readonly_for_you === true };
}

/** What the page says about the chat, in one line, or null when the button alone is enough. @param {ReturnType<typeof chatAnswer>} c */
export function chatNote(c) {
  if (c.state === "waiting") return "The group chat is made on a teammate's device first. It opens here the next time you come in.";
  if (c.state === "pending") return "Nobody has made this project's group chat yet.";
  if (c.state === "open" && c.adding) return `Adding ${c.adding} ${c.adding === 1 ? "person" : "people"} to the group chat...`;
  if (c.state === "open" && c.readOnly) return "You can read the group chat. Only the team writes in it.";
  return null;
}

/** Where a chat opens. @param {string} id */
export const chatPath = (id) => `/u/chats/${encodeURIComponent(id)}`;

/**
 * What the page shows once ensureProjectChat (src/chat/project-chat.ts: makes or mends the chat on this device) and the read of work.project.chat have both answered. A made chat is open, and the read adds whether the person
 * can only read it and who is still being added. A teammate's device that has to make it first is waiting. A viewer before anyone made it is pending; a box without the tool shows nothing; anything else is a failure with the line the keys gave.
 * @param {{ chat: string | null, state: "ready" | "waiting" | "none", say?: string }} ensured @param {ReturnType<typeof chatAnswer>} read
 */
export function chatState(ensured, read) {
  if (ensured.state === "ready" && ensured.chat) return read.state === "open" ? { ...read, chat: ensured.chat } : /** @type {const} */ ({ state: "open", chat: ensured.chat, adding: 0, readOnly: false });
  if (read.state === "pending" || read.state === "missing") return read;
  if (ensured.state === "waiting" || read.state === "making" || read.state === "waiting") return /** @type {const} */ ({ state: "waiting" });
  return /** @type {const} */ ({ state: "failed", why: ensured.say || (read.state === "failed" ? read.why : "The group chat did not open.") });
}
