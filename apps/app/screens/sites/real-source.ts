// Sites' calls on the real box (publish.*), over an injected `call` (the app's box connection, or a fake box in a test). Held acts (approve, publish, rollback, a real secret)
// take two calls: the first answers { held, task, plan }, then the person decides with publish.decide, which carries presence.
import type { Dep, Held, Status } from "./real-model";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

export function sitesSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    list: async (): Promise<Dep[]> => (await ask<{ deployments?: Dep[] }>("publish.list")).deployments ?? [],
    status: (deployment: string) => ask<Status>("publish.status", { deployment }),
    create: (input: Record<string, unknown>) => ask<{ deployment: Dep }>("publish.create", input),
    preview: (deployment: string) => ask<{ deployment: Dep; logs: string }>("publish.preview", { deployment }),
    /** approve, publish or rollback: either the new deployment, or the hold to show the person. */
    act: (tool: "approve" | "publish" | "rollback", deployment: string) => ask<Held | { deployment: Dep }>(`publish.${tool}`, { deployment }),
    decide: (input: { task: string; approve: boolean; plan_hash?: string }) => ask<{ outcome: string; deployment?: Dep }>("publish.decide", input),
    retire: (deployment: string) => ask<{ deployment: Dep }>("publish.retire", { deployment }),
    domainAdd: (host: string, deployment: string) => ask<{ domain: { host: string; status: string }; challenge: unknown }>("publish.domain.add", { host, deployment }),
    domainVerify: (host: string) => ask<{ verified: boolean; reason?: string; challenge?: unknown }>("publish.domain.verify", { host }),
    domainRemove: (host: string) => ask<unknown>("publish.domain.remove", { host }),
    secretGrant: (deployment: string, ref: string, name: string, use: ("build" | "runtime")[]) => ask<Held | { deployment: Dep }>("publish.secret.grant", { deployment, ref, name, use }),
    secretRevoke: (deployment: string, name: string) => ask<{ deployment: Dep }>("publish.secret.revoke", { deployment, name }),
    /** The vault's items a secret can come from: names and field names, never a value. */
    vaultItems: async (): Promise<{ name: string; kind: string; fields: string[] }[]> => (await ask<{ items?: { name: string; kind: string; fields: string[] }[] }>("vault.list")).items ?? [],
  };
}
