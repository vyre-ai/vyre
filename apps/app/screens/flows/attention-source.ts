// Runs that need a person, over an injected `call`: flows.attention to read, flows.settle to answer (a person's own act).
export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;
export type AttentionRow = { run: string; flow: string; label: string; kind: string; step: string; step_label: string; message: string; since: number; loud: boolean; gate?: boolean };
export type Outcome = { refresh: boolean; message?: string };

export const attentionSource = (call: Call) => ({
  /** The rows, newest first; none when the list cannot be read. */
  list: async (): Promise<AttentionRow[]> => { const r = await call<{ runs?: AttentionRow[] }>("flows.attention", {}); return r.error ? [] : (r.data?.runs ?? []); },
  /** Answer one run. A refusal gives its own words and changes nothing on the page. */
  settle: async (run: string, action: "retry" | "skip" | "stop" | "advance", reason?: string): Promise<Outcome> => {
    const r = await call("flows.settle", { run, action, ...(reason && reason.trim() ? { reason: reason.trim() } : {}) });
    return r.error ? { refresh: false, message: r.error.message } : { refresh: true };
  },
});
