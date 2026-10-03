// @ts-check
// reply-port: how a reply is opened in a chat and who may receive it (task O, chat 0.3; ruling in team/0.3/DESIGN-chat.md "How the kernel holds a chat").
//
// A reply STREAMS like a one-to-one chat's. It is opened for the asker's assistant session, the chat stamps it with its membership version at that moment,
// its text is written delta by delta, and it is closed with the final text and blocks. It is delivered only to the people who were in the chat at that
// version: someone who joins while it streams, or afterwards, never receives it; nothing is held back and nothing is re-run when the room grows
// (`room_changed` is dropped). The stream does not decide who was in the chat: it asks this port, `mayReceive`, for each frame and each viewer.
//
// THE SWAP POINT. group.js takes `replyPort` (createGroups option; index.js passes none). The default is the stand-in in group.js (`mirrorPort`): it stamps
// with the group log's cursor, reads the kernel's list with chats.read at open so the stamp is the kernel's truth then, and writes the whole text to the
// kernel with chats.append when the reply closes. When kernel-2's `chats.appendOpen(token)` is merged, replace that one object by a port built on it:
//
//   open({ grp, token })        -> const h = await ctx.kernel.chats.appendOpen(token);  return { ver: h.version, write: h.write, close: h.close }
//   mayReceive(grp, p, ver, c)  -> the kernel's answer for "was p in chat grp at membership version ver (and still is)"
//
// (h.version and the kernel's answer are what the ruling says the kernel stamps and decides; confirm their names with kernel-2.) Nothing else in the
// stream changes. core/stream/fake-reply-port.js is the same contract over an in-memory chat, used by the tests.

/**
 * @typedef {{ ver: number, write: (delta: string) => void | Promise<void>, close: (final: { text: string, blocks?: any[] }) => void | Promise<void> }} OpenReply
 * @typedef {{
 *   open: (o: { grp: string, token: string, message: string }) => Promise<OpenReply>,
 *   stamp: (grp: string) => number,
 *   mayReceive: (grp: string, person: string, ver: number, cur: number) => boolean,
 *   sync?: (grp: string, token: string) => Promise<void>,
 * }} ReplyPort
 */

/** The note a withdrawn reply carries (the kernel took its permission back while it streamed). @param {string} message */
export const cutNote = message => ({ message, note: "This reply was withdrawn" });
