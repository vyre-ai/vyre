// The pure half of Assistants and AI accounts on the real box: agents.list, agents.usage and providers.list rows as the lines the screens show.

export type Agent = { name: string; kind: "assistant" | "agent" | string; projects: unknown; model?: string | null; effort?: string | null; computer?: boolean; auth?: string; status?: string; doing?: string; thread?: string | null };
export type Usage = { agent: string | null; kind: string | null; turns: number; threads: number; cost_usd: number; api_cost_usd: number; budget_usd: number | null; spent_usd: number; left_usd: number | null; auth: string; limit?: unknown };
export type Provider = { id: string; label: string; accounts: { id: string; label: string; kind: string; plan: string | null; signed_in: boolean; default?: boolean }[]; models: { id: string; label: string }[] };

/** Where an agent works: every project, a count, or none. */
export function worksLine(projects: unknown): string {
  if (projects === "*") return "Every project";
  const n = Array.isArray(projects) ? projects.length : 0;
  if (n === 1 || n === 2) return `Works on ${(projects as unknown[]).map(String).join(" and ")}`;
  return n ? `${n} ${n === 1 ? "project" : "projects"}` : "No projects yet";
}
/** "Your assistant" for the one assistant, else "Agent". */
export const roleOf = (a: Agent): string => (a.kind === "assistant" ? "Your assistant" : "Agent");
/** The line under a name: its job now, model and how it signs in. */
export function agentLine(a: Agent): string {
  const auth = a.auth === "subscription" ? "your subscription" : a.auth === "api-key" ? "an API key" : "the account on your home";
  return [a.doing ?? "not started", a.model || "default model", `uses ${auth}`, worksLine(a.projects)].join(", ");
}
/** Paused is a stopped thread: agents.stop stops every running thread and agents.resume starts the latest again. */
export const isStopped = (a: Agent): boolean => a.status === "stopped";

const usd = (n: number) => (n >= 10 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);
export const money = usd;
/** "$12 of $50 this period", or what was spent when no budget is set. */
export function budgetLine(u: Usage): string {
  return u.budget_usd == null ? `${usd(u.spent_usd)} spent. No budget set.` : `${usd(u.spent_usd)} of ${usd(u.budget_usd)}.${u.left_usd === 0 ? " At the limit: the agent stops and asks you." : ""}`;
}
export const usedShare = (u: Usage): number => (u.budget_usd ? Math.min(1, u.spent_usd / u.budget_usd) : 0);

/** One row per provider: its signed-in accounts, or "Not connected". */
export function providerRows(ps: Provider[]): { id: string; name: string; on: boolean; line: string; accounts: string[] }[] {
  return ps.map((p) => {
    const on = p.accounts.filter((a) => a.signed_in);
    return { id: p.id, name: p.label, on: on.length > 0, line: on.length ? on.map((a) => `${a.label}${a.plan ? `, ${a.plan}` : ""}`).join("; ") : "Not connected", accounts: on.map((a) => a.id) };
  }).sort((a, b) => Number(b.on) - Number(a.on));
}

/** What the agents together have spent, for the top of AI accounts. */
export const totalSpent = (us: Usage[]): number => us.reduce((n, u) => n + (u.spent_usd || 0), 0);

/** The assistants as rows of a list block: the face, what it does, a Paused chip, and Pause or Resume when it has a thread. */
export const assistantRows = (list: Agent[]) => list.map((a) => ({
  id: a.name, title: a.name, subtitle: `${roleOf(a)}. ${agentLine(a)}`, faces: [{ kind: a.kind === "assistant" ? "assistant" : "teammate", name: a.name }],
  ...(isStopped(a) ? { accessories: [{ label: "Paused", tone: "warn" }] } : {}), ...(a.thread ? { actions: [{ id: "flip", title: isStopped(a) ? "Resume" : "Pause" }] } : {}),
}));
