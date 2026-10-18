// @ts-check
// "Fork and continue in Space's Cloud / on My Computer": a copy of the chat that starts in the other place, with this one left where it is. The chat's own place chip says which other place there is (chipOf's moveTo);
// the box does the two steps it already has, threads.fork and then runner.move of the copy, and the words here come from its answers. Pure, so Node tests it with a fake box.

/** The row the sheet offers, or null when the chat has no other place to offer. @param {"mac" | "server" | null | undefined} to */
export function forkMoveOffer(to) {
  if (to === "server") return { to, title: "Fork and continue in Space's Cloud", sub: "A copy that runs in Space's Cloud" };
  if (to === "mac") return { to, title: "Fork and continue on My Computer", sub: "A copy that runs on My Computer" };
  return null;
}

/** @param {unknown} e */
const reasonOf = (e) => (e instanceof Error && e.message ? e.message : "That did not go through.");

/**
 * Fork the chat, then move the copy. A copy that was made is always kept: when it cannot be moved the note says where it runs and why, and the person has the copy either way.
 * @param {{ fork: (thread: string) => Promise<{ ok: true, thread: string } | { ok: false, reason: string }>, move: (thread: string, to: "mac" | "server") => Promise<{ where?: string } | null> }} box
 * @param {string} thread @param {"mac" | "server"} to
 * @returns {Promise<{ ok: true, thread: string, note: string } | { ok: false, reason: string }>}
 */
export async function forkAndMove(box, thread, to) {
  const f = await box.fork(thread);
  if (!f.ok) return f;
  const place = to === "server" ? "Space's Cloud" : "My Computer";
  /** @param {string} w */
  const at = (w) => (w === "mac" ? "on My Computer" : "in Space's Cloud");
  try {
    const p = await box.move(f.thread, to);
    if (p && p.where && p.where !== to) return { ok: true, thread: f.thread, note: `The copy is made and runs ${at(p.where)}.` };
    return { ok: true, thread: f.thread, note: `The copy runs ${at(to)}.` };
  } catch (e) {
    return { ok: true, thread: f.thread, note: `The copy is made, but it could not go to ${place}: ${reasonOf(e)}` };
  }
}
