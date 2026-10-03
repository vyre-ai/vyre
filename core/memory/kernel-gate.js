// @ts-check
// The minimum kernel wiring for core/memory in 0.3 (CUTOVER section G, a and c). Personal memory is one person's, so every tool is asked two things of the KERNEL, not of the
// 0.2 caller label (the `tailnet:` labels are going away):
//   a. the room: a call that runs in a chat with more than one person is refused. Personal memory never feeds a shared room. The room is the running turn's own, from
//      `ctx.kernel.audienceFor` (no argument names it). A call with no session of its own is not in a chat. A call WITH a session whose room cannot be built is refused.
//   c. whose: when the kernel built a chain with a person in it, that person is the owner of this home (kernel membership: role owner) and no other person is in the chain;
//      only that person's own assistants (agent hops) may stand beside them. A chain with no person (a module or the daemon calling) is not decided here: the legacy rules stand.
// With no kernel on the daemon (`ctx.kernel` absent) nothing changes. The 0.2 reach rules (projects.reach, agent project grants) still run after this, and only narrow.

/** @param {any} ctx @param {{ denied: (message: string) => Error }} o */
export function createKernelGate(ctx, { denied }) {
  /** @param {string} tool @param {any} extra @returns {Promise<void>} */
  return async function gate(tool, extra) {
    const k = ctx.kernel;
    if (!k) return;
    const hasSession = Boolean(extra && typeof extra.token === "string" && extra.token);
    /** @type {any} */ let chain = null;
    try { chain = await k.chain(extra || {}); } catch { if (hasSession) throw denied(`${tool}: this session could not be checked`); }
    // a. the room. The kernel writes the chat into a session's token, and the chain it builds carries it (`chain.room`): a chat session must have a room the kernel can build,
    //    and that room must be one person. A session with no chat, or a call with no session, is not in a chat.
    if (chain && chain.room) {
      let room = null;
      try { room = typeof k.audienceFor === "function" ? await k.audienceFor(extra || {}) : null; } catch { room = null; }
      if (!room) throw denied(`${tool}: the room this runs in is not known, so personal memory is not read`);
      if (room.group === true) throw denied(`${tool}: personal memory is not shared in a group chat`);
    }
    // c. whose memory
    if (!chain || !Array.isArray(chain.hops) || !chain.hops.length) return;
    const hops = chain.hops.map((/** @type {any} */ h) => h.actor);
    if (hops.every((/** @type {any} */ a) => a.kind === "service")) return;
    const first = hops[0];
    if (first.kind !== "person" || hops.slice(1).some((/** @type {any} */ a) => a.kind === "person")) throw denied(`${tool}: personal memory is read only by its person and that person's own assistant`);
    let m = null;
    try { m = typeof k.membership === "function" ? await k.membership(first.id) : null; } catch { m = null; }
    if (!m || m.member !== true || m.role !== "owner") throw denied(`${tool}: personal memory is read only by its person and that person's own assistant`);
  };
}
