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
