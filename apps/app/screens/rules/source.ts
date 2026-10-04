// Rules' calls on the real box, over an injected `call` (the app's box connection, or a fake box in a test). Names follow the kernel's rule actions
// (kernel/grants): rules.list, rules.set, rules.propose, rules.accept, rules.dismiss, rules.remove. set, accept, dismiss and remove are an owner's own act:
// the box asks for presence and the app's person session answers it.
import type { Listing, Rule } from "./model";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

export function rulesSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    listReal: async (space?: string): Promise<Listing> => {
      const r = await ask<Partial<Listing>>("rules.list", space ? { space } : {});
      return { rules: r.rules ?? [], proposals: r.proposals ?? [] };
    },
    /** The person's role in the first space (spaces.list), which decides whether the form sets a rule (owner) or proposes one. */
    roleReal: async (): Promise<string> => (await ask<{ role?: string }[]>("spaces.list"))?.[0]?.role ?? "member",
    setReal: (rule: unknown, space?: string) => ask<Rule>("rules.set", { ...(space ? { space } : {}), rule }),
    proposeReal: (rule: unknown, space?: string) => ask<Rule>("rules.propose", { ...(space ? { space } : {}), rule }),
    acceptReal: (id: string) => ask<Rule>("rules.accept", { id }),
    dismissReal: (id: string) => ask<{ dismissed: string }>("rules.dismiss", { id }),
    removeReal: (id: string) => ask<{ removed: string }>("rules.remove", { id }),
  };
}
