// Starting a Flow and retrying a run on the real vyred, over an injected `call` (the app's box connection, or a fake box in a test).
// flows.start is the person's own run (kernel/flows runner.start, checked against their chain); flows.retry is a person's own call too.
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
    retryReal: (run: string) => ask<{ ok: boolean }>("flows.retry", { run }),
  };
}
