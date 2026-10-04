// @ts-check
// modules: the owner's reset of the accepted first-party module list (kernel/home.js resetModulesList). A rollback to an older release is below the counter the home already accepted, so the
// older build's list is refused until the owner says so, once, with their presence. This module only carries that act: the kernel checks that the chain is exactly the owner (never a
// delegated, viewer or room chain), checks the presence proof over the counter it forgets, and writes the one `kernel.modules-list-reset` event. Nothing here decides.
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/** @type {Record<string, string>} */
const WHY = {
  owner_only: "only the owner resets the module list",
  no_signed_list: "this build has no signed module list to reset",
  no_presence_verifier: "this home cannot check your presence yet",
  needs_presence: "this needs your presence: approve it on your device",
  no_proof: "this needs your presence: approve it on your device",
};

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.tool("modules.list.reset", {
      description: "Forget the accepted first-party module list so an older release's list can be used (a rollback). The owner only, with their presence. Writes one event.",
      input: { type: "object", properties: {}, additionalProperties: false },
      callers: ["cli", "local", "deck", "capsule", "mobile", "device"],
      run: async (/** @type {any} */ _input, /** @type {any} */ meta) => {
        if (typeof ctx.modulesListReset !== "function" || !ctx.kernel) throw refuse("this build runs without its kernel, so there is no module list to reset", "unavailable");
        const chain = await ctx.kernel.chain(meta);
        const proof = ctx.kernel.proofFrom(meta);
        const r = await ctx.modulesListReset(chain, proof || null);
        if (!r || r.ok !== true) {
          const why = String((r && r.why) || "refused");
          throw refuse(WHY[why] || `the module list was not reset: ${why === "wrong_payload" || why === "wrong_proof" ? "that approval was not for this" : why}`, why === "owner_only" ? "denied" : why === "no_signed_list" || why === "no_presence_verifier" ? "unavailable" : "needs_presence");
        }
        return { reset: true };
      },
    });
    return { async stop() {} };
  },
};
