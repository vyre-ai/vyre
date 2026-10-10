// Outside agents from outside.list (core/outside; team/contracts/ext-agents.md): the rows as drawn, the words for each state, and the lines to paste into the agent. Pure: no calls.

export type Gives = { id: string; kind: string; types?: string[]; write?: boolean; projects?: string[] };
export type Agent = { id: string; name: string; note: string; reach: string; gives: Gives[]; expires: number; lastUsed: number | null; uses: number; status: "active" | "expired" | "revoked" };
export type Registered = { id: string; name: string; token: string; url: string; lines: { claude: string; codex: string } };
export type RecordType = { name: string; label: string };

const DAY = 86_400_000;

/** outside.list's rows, reduced to what is drawn. */
export function agentsOf(d: any): Agent[] {
  return (Array.isArray(d?.agents) ? d.agents : [])
    .filter((a: any) => a && typeof a.id === "string" && typeof a.name === "string")
    .map((a: any): Agent => ({
      id: a.id, name: a.name, note: typeof a.note === "string" ? a.note : "", reach: typeof a.reach === "string" ? a.reach : "",
      gives: (Array.isArray(a.gives) ? a.gives : []).filter((g: any) => g && typeof g.id === "string").map((g: any): Gives => ({ id: g.id, kind: String(g.kind), ...(Array.isArray(g.types) ? { types: g.types.map(String) } : {}), ...(g.write ? { write: true } : {}), ...(Array.isArray(g.projects) ? { projects: g.projects.map(String) } : {}) })),
      expires: Number(a.expires) || 0, lastUsed: typeof a.lastUsed === "number" ? a.lastUsed : null, uses: Number(a.uses) || 0,
      status: a.status === "revoked" || a.status === "expired" ? a.status : "active",
    }));
}

/** The record types a person can give, from records.types: the kernel's own bookkeeping types are already left out by the box. */
export function typesOf(d: any): RecordType[] {
  return (Array.isArray(d?.types) ? d.types : []).filter((t: any) => t && typeof t.name === "string" && !t.system).map((t: any): RecordType => ({ name: t.name, label: String(t.label || t.name) }));
}

/** How long a token has left, in words. */
export function endsLine(a: Agent, now: number): string {
  if (a.status === "revoked") return "Ended";
  if (a.expires <= now) return "Expired. Make a new token to use it again.";
  const days = Math.ceil((a.expires - now) / DAY);
  return days <= 1 ? "Ends today" : `Ends in ${days} days`;
}

/** When it last asked, in words; never used says so. */
export function usedLine(a: Agent, now: number): string {
  if (a.lastUsed === null) return "Has not connected yet";
  const mins = Math.max(0, Math.round((now - a.lastUsed) / 60_000));
  if (mins < 2) return "Connected just now";
  if (mins < 120) return `Last connected ${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `Last connected ${hours} hours ago` : `Last connected ${Math.round(hours / 24)} days ago`;
}

/** What a give row says: "Clients and Matters, and may ask to change them", "the files of Harlow". */
export function givesLine(g: Gives): string {
  if (g.kind === "records") return `${(g.types || []).join(" and ") || "Records"}${g.write ? ", and may ask to change them" : ""}`;
  if (g.kind === "memory") return `The memory of ${(g.projects || []).join(" and ") || "a project"}`;
  if (g.kind === "files") return `The files of ${(g.projects || []).join(" and ") || "a project"}`;
  return g.kind;
}

/** The three things a person can tick when giving record access: which types, and whether the agent may ask to change them. */
export function recordsGrant(picked: string[], write: boolean) {
  const types = [...new Set(picked)].filter(Boolean);
  return types.length ? { kind: "records" as const, types, ...(write ? { write: true } : {}) } : null;
}
