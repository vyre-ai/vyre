// @ts-check
// Who asked the chat turn running on a thread. An ask the owner's words make in a chat is recorded for THAT person (vault.said.record carries the asker), and the vault answers a call's match only
// for the same person, so a member's later request in the same chat does not ride the owner's ask. The vault asks here, by module, for the asker of the turn that is making the call.

/**
 * Whether the run on a thread is a turn a person is at: not a Flow's (flow_origin), not one made to act as someone (run_as), not a one-off or a job. The same test as ownerDirect (asker-account.js); the vault
 * asks it before it lets the person's assistant use the person's own items without a grant (core/vault/use.js). A run whose options cannot be read is not attended.
 * @param {any} sb @param {string} id
 */
export function attendedRun(sb, id) {
  try {
    const r = /** @type {any} */ (sb.db.prepare("SELECT purpose, opts FROM threads_runs WHERE id = ?").get(id));
    if (!r) return false;
    const o = r.opts ? JSON.parse(String(r.opts)) : {};
    return !(o.flow_origin || o.run_as || o.runas || o.once === true || r.purpose === "job" || o.purpose === "job");
  } catch { return false; }
}

/** @param {any} ctx @param {any} sb the Switchboard */
export function registerTurnAsker(ctx, sb) {
  ctx.tool("threads.turn-asker", {
    description: "Who asked the chat turn now running on a thread (a per_ id), or none for a turn that is not a chat's, and whether a person is at it (not a Flow, job or run_as turn). Only the vault and Files ask, to match an ask to the person who made it.", internal: true, callers: ["module"],
    input: { type: "object", required: ["thread"], properties: { thread: { type: "string" } } },
    // Who is running on a thread is the vault's to ask, not any module's (an added one too): it answers module:vault and module:files, which keep what a tag lends for the person who tagged it.
    run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      if (!["module:vault", "module:files"].includes(String(meta && meta.caller))) throw Object.assign(new Error("only the vault and Files ask who asked a turn"), { code: "denied" });
      const id = String(i.thread), asker = sb.turnAsker.get(id) || null;
      return { asker, attended: asker ? attendedRun(sb, id) : false };
    },
  });
}
