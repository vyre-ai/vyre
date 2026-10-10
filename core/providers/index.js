// @ts-check
// providers: the one public providers.list, assembled from whichever module(s) actually run
// sessions. Today that is only core/sessions (Claude, Codex, Grok, ADR 0030); this module holds
// no state of its own and never will unless a second source of providers exists to merge.

export default {
  async start(ctx) {
    ctx.tool("providers.list", {
      description: "Every session provider on this machine with its accounts and the models it offers; pickers build themselves from it.",
      input: { type: "object", properties: {} },
      run: async () => {
        const r = await ctx.call("sessions.providers.snapshot", {});
        return r.error ? [] : r.data;
      },
    });
    return { async stop() {} };
  },
};
