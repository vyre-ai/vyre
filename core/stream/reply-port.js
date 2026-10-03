// @ts-check
// reply-port: how a reply is opened in a chat and who may receive it (task O, chat 0.3; ruling in team/0.3/DESIGN-chat.md "How the kernel holds a chat").
//
// A reply STREAMS like a one-to-one chat's. It is opened for the asker's assistant session, the chat stamps it with its membership version at that moment,
// its text is written delta by delta, and it is closed with the final text and blocks. It is delivered only to the people who were in the chat at that
// version: someone who joins while it streams, or afterwards, never receives it; nothing is held back and nothing is re-run when the room grows
// (`room_changed` is dropped). The stream does not decide who was in the chat: it asks this port, `mayReceive`, for each frame and each viewer.
//
// WIRED. group.js picks the port: the kernel's own (`kernelPort`: chats.appendOpen to open, chats.mayReceive(viewerChain, id) to deliver; kernel-2's
// work/kernel-chats-2, merged) when ctx.kernel has both, else the stand-in (`mirrorPort`, for a kernel without them) that stamps with the group log's cursor, reads the
// kernel's list while the reply streams and writes the whole text with chats.append at close; or a `replyPort` handed to createGroups (the tests: fake-reply-port.js, the
// same contract over an in-memory chat). Every frame of a reply carries `data.rid` (the kernel's message id) and `data.ver` (the version it was opened at); the viewer's
// `may(frame)` asks `mayReceive` with the VIEWER's own chain (stream.open's), so the answer is for the person asking. A tool, ask or held thought of a turn carries `data.at`
// (the group log's cursor) and is asked of the group's own mirrored list.

/**
 * @typedef {{ id: string, ver: number, write: (delta: string) => void | Promise<void>, close: (final: { text: string, blocks?: any[] }) => void | Promise<void> }} OpenReply
 * @typedef {{
 *   open: (o: { grp: string, token: string, message: string, thread?: string }) => Promise<OpenReply>,
 *   mayReceive: (grp: string, person: string, reply: { kid: string, ver: number, cur: number }, chain: any) => boolean,
 *   follow?: boolean,
 * }} ReplyPort
 */

/** The note a withdrawn reply carries (the kernel took its permission back while it streamed). @param {string} message */
export const cutNote = message => ({ message, note: "This reply was withdrawn" });
