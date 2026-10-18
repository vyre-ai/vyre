// The Space's limits for Flows and where a Flow's Connections stand, over an injected `call`: flows.budget and flows.budget.set (owner or admin), flows.control, flows.connections.
export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;
export type Budget = { tokens_per_day: number; used_today: number; context_tokens: number };
export type Control = { mode: string; reason?: string; held: number; dropped: number };
export type ConnectionUse = { connection: string; flows: { id: string; label: string; active: boolean; level?: string; line?: string }[] };

export const limitsSource = (call: Call) => ({
  budget: async (): Promise<Budget | null> => { const r = await call<Budget>("flows.budget", {}); return r.error ? null : (r.data ?? null); },
  control: async (): Promise<Control | null> => { const r = await call<Control>("flows.control", {}); return r.error ? null : (r.data ?? null); },
  /** The Connections this Flow uses, with their state; none when unreadable. */
  connectionsOf: async (flow: string): Promise<ConnectionUse[]> => {
    const r = await call<{ connections?: ConnectionUse[] }>("flows.connections", {});
    return r.error ? [] : (r.data?.connections ?? []).filter((c) => c.flows.some((f) => f.id === flow));
  },
  /** Set the daily allowance; a refusal (not an owner or admin) gives its own words. */
  setBudget: async (tokensPerDay: number): Promise<{ ok: boolean; message?: string }> => {
    const r = await call("flows.budget.set", { tokens_per_day: tokensPerDay });
    return r.error ? { ok: false, message: r.error.message } : { ok: true };
  },
});
