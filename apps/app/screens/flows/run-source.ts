// Starting a Flow and retrying a run on the real vyred, over an injected `call` (the app's box connection, or a fake box in a test).
// flows.start is the person's own run (kernel/flows runner.start, checked against their chain); flows.retry and flows.cancel are a person's own calls too.
export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

export function runSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown>): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    /** Start now. `key` makes a repeat tap the same run, not two. */
    startReal: (id: string, key: string, input: Record<string, unknown> = {}) => ask<{ id?: string; run?: string }>("flows.start", { id, input, key }),
    /** Retry from the stopped step. `version: "latest"` runs the rest on the Flow's active version (the owner's choice; flows.retry takes it over MCP too). */
    retryReal: (run: string, opts: { version?: "latest" } = {}) => ask<{ ok: boolean }>("flows.retry", { run, ...opts }),
    /** Retry from one step: it and every step after it run again; the steps before keep what they made. The engine refuses it when something already went out. */
    retryFromReal: (run: string, from: string) => ask<{ ok: boolean }>("flows.retry", { run, from }),
    /** Stop a run that is paused, failed, waiting or held: it is kept, marked stopped, and what it waits on is withdrawn. */
    cancelReal: (run: string) => ask<{ ok: boolean; state?: string | null }>("flows.cancel", { run }),
  };
}
