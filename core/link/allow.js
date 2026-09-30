// @ts-check
// allow: the tools the box may ask a paired Mac to run through the link.
//
// Both ends check this list: the box refuses anything else before it queues a request, and the Mac
// refuses anything else before it runs one, so a box that was changed or taken over still cannot
// make the Mac do more than read its catalog, its projects, its sessions and its threads.
// recall.thread and recall.transcript (the same session as blocks, tool calls and their output
// included) are the only ones that return what was said, and a surface asks for them only when
// someone opens that session.

/** @type {readonly string[]} */
export const ALLOW = Object.freeze(["projects.catalog", "projects.list", "recall.search", "recall.sessions", "recall.thread", "recall.transcript", "threads.list", "threads.asks"]);

// The writes the box may ask of a Mac: typing into one of its sessions, and answering one of its
// asks. Both ends check the list, as for ALLOW, and both refuse a write unless the request says it
// is the person's (`as: "person"`), which the box's switchboard sets only for the person's own
// callers (the Deck, the terminal, the Capsule, the owner's devices over the tailnet), never for
// an agent, MCP, a guest or a module. The Mac runs them as the caller "link:box", so a session
// busy in a terminal queues the words the way it does for the person on the Mac.
// threads.answer needs more than `as`: an assertion signed by the paired box's key, bound to this
// Mac, that ask and that exact answer, for 60 s and one use (assert.js). Leases and releases do
// not cross (docs/adr/0021-box-reads-the-mac.md, "Sending to a Mac session" and "v2").

/** @type {readonly string[]} */
export const WRITE = Object.freeze(["threads.send", "threads.answer"]);

/** The events of a Mac thread the box sent to that the Mac forwards back (link.events). */
/** @type {readonly string[]} */
export const FOLLOWED = Object.freeze(["thread.queued", "thread.sent", "thread.text", "thread.finished", "thread.stopped", "thread.contended", "thread.limit"]);

/**
 * The events of every ask on the Mac, for any of its threads, that the Mac forwards while paired:
 * an ask raised, and its end (ask.answered, whose decision is "cancelled" when it closed unanswered).
 * Asks are few, and the person must see each on the box to answer it there.
 * @type {readonly string[]}
 */
export const ASKS = Object.freeze(["ask.raised", "ask.answered"]);
