// Writing a Flow in text on the real box: flows.compile-text (check, store nothing) and flows.define (store a new version, run nothing), over an injected `call`.
import type { Checked, Defined } from "./engineer-model";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

export function engineerSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown>): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    check: (text: string) => ask<Checked>("flows.compile-text", { text }),
    /** Save as a draft version. `id` makes it a new version of an existing Flow. */
    save: (text: string, id?: string) => ask<Defined>("flows.define", { text, ...(id ? { id } : {}) }),
  };
}
