// Sites' calls on the real box (publish.*), over an injected `call` (the app's box connection, or a fake box in a test). Held acts (approve, publish, rollback, a real secret)
// take two calls: the first answers { held, task, plan }, then the person decides with publish.decide, which carries presence.
import type { Dep, Held, JobRun, Status } from "./real-model";

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
    /** A live job: run it now, its last runs (newest first), and the live jobs whose last run failed (what Now shows). */
    jobRun: (deployment: string) => ask<JobRun>("publish.job.run", { deployment }),
    jobRuns: async (deployment: string, limit = 10): Promise<JobRun[]> => (await ask<{ runs?: JobRun[] }>("publish.job.runs", { deployment, limit })).runs ?? [],
    jobAttention: async (): Promise<{ deployment: string; name: string; at: number; message: string }[]> => (await ask<{ jobs?: { deployment: string; name: string; at: number; message: string }[] }>("publish.job.attention")).jobs ?? [],
    /** The edge: start it (builds its Caddy image, brings the project up) or stop it. A box without a way to start containers answers not_available with what to run by hand. */
    edgeUp: () => ask<{ project?: string }>("publish.edge.up"),
    edgeDown: () => ask<unknown>("publish.edge.down"),
    /** The vault's items a secret can come from: names and field names, never a value. */
    vaultItems: async (): Promise<{ name: string; kind: string; fields: string[] }[]> => (await ask<{ items?: { name: string; kind: string; fields: string[] }[] }>("vault.list")).items ?? [],
  };
}
