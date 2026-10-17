// @ts-check
// Who asked the chat turn running on a thread. An ask the owner's words make in a chat is recorded for THAT person (vault.said.record carries the asker), and the vault answers a call's match only
// for the same person, so a member's later request in the same chat does not ride the owner's ask. The vault asks here, by module, for the asker of the turn that is making the call.

/** @param {any} ctx @param {any} sb the Switchboard */
export function registerTurnAsker(ctx, sb) {
  ctx.tool("threads.turn-asker", {
    description: "Who asked the chat turn now running on a thread (a per_ id), or none for a turn that is not a chat's. Only the vault asks, to match an ask to the person who made it.", internal: true, callers: ["module"],
    input: { type: "object", required: ["thread"], properties: { thread: { type: "string" } } },
    // Who is running on a thread is the vault's to ask, not any module's (an added one too): it answers module:vault alone.
    run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      if (String(meta && meta.caller) !== "module:vault") throw Object.assign(new Error("only the vault asks who asked a turn"), { code: "denied" });
      return { asker: sb.turnAsker.get(String(i.thread)) || null };
    },
  });
}
