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
        if (r.error) return [];
        // The picker lists what the registry has seen LIVE (core/models: each provider's own list, asked through the inference door, and the lists sessions report); a provider the registry knows nothing
        // of yet keeps the models its sessions reported, as before (0.3.3 G13).
        const m = await ctx.call("models.list", { available: true, limit: 500 }).catch(() => null);
        const live = m && !m.error && m.data && Array.isArray(m.data.models) ? m.data.models : [];
        return r.data.map((/** @type {any} */ p) => {
          const mine = live.filter((/** @type {any} */ x) => x.provider === p.id).map((/** @type {any} */ x) => ({ id: x.id, label: x.label || x.id }));
          return mine.length ? { ...p, models: mine } : p;
        });
      },
    });
    return { async stop() {} };
  },
};
