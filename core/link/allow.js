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

/**
 * The one call that is neither a read of the Mac nor a write to its sessions: a learned website operation, run by name in the person's own Chrome (docs: team/0.3.1/DESIGN-site-operations.md,
 * rung "mac"). Both ends check this list as for ALLOW. It runs only an operation the person approved for the box on this Mac (link.ops.allow), a read at once; an outward one only with an
 * assertion signed by the box's key, bound to this Mac, that site, that operation and those exact inputs (assert.js signCall), for 60 s and one use.
 * @type {readonly string[]}
 */
export const CALL = Object.freeze(["chrome.op.call", "computer.call"]);

// computer.call is the other call of the same kind: Vyre Computer's `computer` tool on the box asks this Mac to look, act or find files (lib/computer-classes.js). It runs only for a class the person
// allowed for the box on this Mac (link.computer.allow); there is no outward path through it (an engine's own Gate still holds a send, and nothing is signed for it); the box's `computer` module
// is the only caller the box lets send it.
