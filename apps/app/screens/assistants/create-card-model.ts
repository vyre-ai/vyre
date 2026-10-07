// "Create your assistant": the card on Now for a person who has no assistant yet. Pure, so Node tests it.

export type AgentRow = { name?: string; kind?: string };

/** The people who may make an assistant: the owner and admins of the space. Without a role the card stays away. */
const MAKERS = new Set(["owner", "admin"]);

/** True when the list is known, none of it is an assistant, and this person may make one. */
export function shouldShow(agents: readonly AgentRow[] | null | undefined, role?: string | null): boolean {
  if (!Array.isArray(agents)) return false;
  if (agents.some((a) => a && a.kind === "assistant")) return false;
  return MAKERS.has(String(role || ""));
}

/** agents.list answers an array or { agents }. */
export function agentsOf(data: unknown): AgentRow[] | null {
  if (Array.isArray(data)) return data as AgentRow[];
  const a = (data as { agents?: unknown } | null)?.agents;
  return Array.isArray(a) ? (a as AgentRow[]) : null;
}

export const CREATE_ASSISTANT = { title: "Create your assistant", body: "It reads your mail and calendar, drafts, and works while you do something else. Give it a name and a job.", action: "Create", href: "/u/settings/assistants/new" };
