// A Flow's saved test cases over an injected `call` (the app's box connection, or a fake box in a test): flows.test.list, run, save (from a run) and remove.
// Each act says whether the page should read again and what to tell the person; a refused call tells them its own words and changes nothing on the page.
export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;
export type Case = { name: string; event?: unknown; input?: unknown };
export type Result = { ok?: boolean; summary?: string; lines?: string[] };
export type Outcome = { refresh: boolean; message?: string; result?: Result | null };

/** What a case starts from, in a few words. */
export const caseWords = (c: Case): string => (c.event ? "Starts from an event" : "Starts from a form or a button");

export function testsSource(call: Call) {
  const done = (r: { error?: { message: string } }, message?: string, result?: Result | null): Outcome => (r.error ? { refresh: false, message: r.error.message } : { refresh: true, ...(message ? { message } : {}), ...(result !== undefined ? { result } : {}) });
  return {
    /** The saved cases; none when the list cannot be read. */
    list: async (id: string): Promise<Case[]> => { const r = await call<{ cases?: Case[] }>("flows.test.list", { id }); return r.error ? [] : (r.data?.cases ?? []); },
    /** Run every saved case against the Flow's version. */
    run: async (id: string): Promise<Outcome> => { const r = await call<Result>("flows.test.run", { id }); return done(r, undefined, r.data ?? null); },
    /** Keep a run as a case; the name is optional. */
    keep: async (id: string, run: string, name?: string): Promise<Outcome> => done(await call("flows.test.save", { id, from_run: run, ...(name && name.trim() ? { name: name.trim() } : {}) }), "Kept as a test."),
    /** Remove a case by its name (a person's own act). */
    remove: async (id: string, name: string): Promise<Outcome> => done(await call("flows.test.remove", { id, name }), "Removed."),
  };
}
