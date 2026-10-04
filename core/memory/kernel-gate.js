// @ts-check
// The minimum kernel wiring for core/memory in 0.3 (CUTOVER section G, a and c). Personal memory is one person's, so every tool is asked two things of the KERNEL, not of the
// 0.2 caller label (the `tailnet:` labels are going away):
//   a. the room: a call that runs in a chat with more than one person is refused. Personal memory never feeds a shared room. The room is the running turn's own, from
//      `ctx.kernel.audienceFor` (no argument names it). A call with no session of its own is not in a chat. A call WITH a session whose room cannot be built is refused.
//   c. whose: when the kernel built a chain with a person in it, that person is the owner of this home (kernel membership: role owner) and no other person is in the chain;
//      only that person's own assistants (agent hops) may stand beside them. A chain with no person (a module or the daemon calling) is not decided here: the legacy rules stand.
// With no kernel on the daemon (`ctx.kernel` absent) there is no `Who`, and every access predicate answers no. The 0.2 reach rules (projects.reach, agent project grants) still run after this, and only narrow.

/** Tools a person asks the ONE Ask door through: in a room they are answered from the Space's memory alone, not refused. */
export const ROOM_ANSWERS = new Set(["memory.ask"]);

import { whoOfChain, whoOfModule } from "./who.js";

/** @param {any} ctx @param {{ denied: (message: string) => Error }} o */
export function createKernelGate(ctx, { denied }) {
  /** The chain the kernel builds from the daemon's proven facts alone (the surface or device this call arrived on), when there are any; a session token's chain does not carry it. */
  const surfaceOf = async (/** @type {any} */ extra) => {
    if (!extra || !extra.kernelFacts || typeof extra.kernelFacts !== "object") return null;
    try { const c = await ctx.kernel.chain({ kernelFacts: extra.kernelFacts }); return c && c.hops && c.hops.length && c.hops.every((/** @type {any} */ h) => h.actor.kind !== "service") ? c : null; } catch { return null; }
  };
  /** @param {string} tool @param {any} extra @returns {Promise<{ group?: true, who?: import("./who.js").Who } | void>} the call's `Who` from its chain (nothing when the kernel is off); `group: true` for a room-answered tool in a room; refuses everything else in a room */
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
      if (room.group === true) {
        if (ROOM_ANSWERS.has(tool)) return { group: true, who: whoOfChain(chain, await surfaceOf(extra)) };
        throw denied(`${tool}: personal memory is not shared in a group chat`);
      }
    }
    // c. whose memory
    // No person chain on this call. The daemon builds one for every person surface it proved (CLI, local, Deck, mobile, a paired or signed-in owner device) and for every session
    // token; a model on the socket, a client's claim and an unproven caller get none, and a caller LABEL decides nothing. Two named exceptions, both set by the daemon and never by a
    // client: a first-party module's own call (the registry's `firstParty` flag; its authority is the module's reach rules), and the Capsule (CAPSULE_EXCEPTION above).
    if (!chain || !Array.isArray(chain.hops) || !chain.hops.length || chain.hops.every((/** @type {any} */ h) => h.actor.kind === "service")) {
      if (extra && extra.firstParty === true && String(extra.caller || "").startsWith("module:")) return { who: whoOfModule(String(extra.caller)) };
      throw denied(`${tool}: this call carries no kernel chain, so personal memory is not read`);
    }
    const hops = chain.hops.map((/** @type {any} */ h) => h.actor);
    const first = hops[0];
    if (first.kind !== "person" || hops.slice(1).some((/** @type {any} */ a) => a.kind === "person")) throw denied(`${tool}: personal memory is read only by its person and that person's own assistant`);
    let m = null;
    try { m = typeof k.membership === "function" ? await k.membership(first.id) : null; } catch { m = null; }
    if (!m || m.member !== true || m.role !== "owner") throw denied(`${tool}: personal memory is read only by its person and that person's own assistant`);
    const who = whoOfChain(chain, await surfaceOf(extra));
    if (who.conflict) throw denied(`${tool}: this chain names more than one agent, so it is not known which is asking`);
    return { who };
  };
}
