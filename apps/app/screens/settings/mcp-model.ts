// The person's AI keys (core/mcpconn): the keys as drawn, what each says, and the recent changes it made. Pure: no calls.

export type Connection = { id: string; name: string; where: string; hosted: boolean; created: number; lastUsed: number | null; revoked: boolean };
export type Change = { at: number; name: string; tool: string; ok: boolean; says: string };
export type Made = { id: string; name: string; key: string; local: boolean; url?: string; snippets: { claude: string; codex: string; json: string } };

/** mcpconn.list's rows, reduced to what is drawn; ended ones stay in the list, labelled. */
export function connectionsOf(d: any): Connection[] {
  return (Array.isArray(d) ? d : [])
    .filter((c: any) => c && typeof c.id === "string" && typeof c.name === "string")
    .map((c: any): Connection => ({ id: c.id, name: c.name, where: typeof c.where === "string" ? c.where : "", hosted: c.hosted === true, created: Number(c.created) || 0, lastUsed: typeof c.lastUsed === "number" ? c.lastUsed : null, revoked: c.revoked === true }));
}

/** mcpconn.activity's rows, reduced to what is drawn. */
export function changesOf(d: any): Change[] {
  return (Array.isArray(d) ? d : [])
    .filter((c: any) => c && typeof c.tool === "string" && typeof c.at === "number")
    .map((c: any): Change => ({ at: c.at, name: typeof c.name === "string" ? c.name : "", tool: c.tool, ok: c.ok !== false, says: typeof c.says === "string" && c.says ? c.says : `via ${typeof c.name === "string" ? c.name : "your AI"}` }));
}

/** When a connection last asked, in words. */
export function usedLine(c: Connection, now: number): string {
  if (c.revoked) return "Ended";
  if (c.lastUsed === null) return "Not used yet";
  const mins = Math.max(0, Math.round((now - c.lastUsed) / 60_000));
  if (mins < 2) return "Used just now";
  if (mins < 120) return `Last used ${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `Last used ${hours} hours ago` : `Last used ${Math.round(hours / 24)} days ago`;
}

/** One recent change in a sentence: the tool in plain words, when, and whether it worked. */
export function changeLine(c: Change, now: number): string {
  const mins = Math.max(0, Math.round((now - c.at) / 60_000));
  const when = mins < 2 ? "just now" : mins < 120 ? `${mins} minutes ago` : mins < 2880 ? `${Math.round(mins / 60)} hours ago` : `${Math.round(mins / 1440)} days ago`;
  return `${c.tool.replace(/\./g, " ")} ${c.ok ? "" : "(refused) "}${c.says}, ${when}`.replace(/\s+/g, " ");
}
