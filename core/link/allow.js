// @ts-check
// allow: the tools the box may ask a paired Mac to run through the link.
//
// Both ends check this list: the box refuses anything else before it queues a request, and the Mac
// refuses anything else before it runs one, so a box that was changed or taken over still cannot
// make the Mac do more than read its catalog, its projects, its sessions and its threads.
// recall.thread is the only one that returns what was said, and a surface asks for it only when
// someone opens that session.

/** @type {readonly string[]} */
export const ALLOW = Object.freeze(["projects.catalog", "projects.list", "recall.search", "recall.sessions", "recall.thread", "threads.list"]);

// The one write the box may ask of a Mac: typing into one of its sessions. Both ends check it, as
// for ALLOW, and both refuse it unless the request says it is the person's (`as: "person"`), which
// the box's switchboard sets only for the person's own callers (the Deck, the terminal, the
// Capsule, the owner's devices over the tailnet), never for an agent, MCP, a guest or a module.
// The Mac runs it as the caller "link:box", so a session busy in a terminal queues the words the
// way it does for the person on the Mac. Answering permission questions, leases and releases do
// not cross (docs/adr/0021-box-reads-the-mac.md, "Sending to a Mac session").

/** @type {readonly string[]} */
export const WRITE = Object.freeze(["threads.send"]);

/** The events of a Mac thread the box sent to that the Mac forwards back (link.events). */
/** @type {readonly string[]} */
export const FOLLOWED = Object.freeze(["thread.queued", "thread.sent", "thread.text", "thread.finished", "thread.stopped", "thread.contended", "thread.limit"]);
