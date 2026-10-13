// The person's connected AI (core/mcpconn): the connections as drawn, what each says, and the recent changes it made. Pure: no calls.

export type Connection = { id: string; client: string; device: string; created: number; lastUsed: number | null; revoked: boolean };
export type Change = { at: number; client: string; tool: string; ok: boolean; says: string };
export type Made = { id: string; client: string; device: string; lines: { claude: string; codex: string } };

/** The lines that register `vyre mcp` with each client; the same words the box returns from mcpconn.connect. */
export const LINES = Object.freeze({ claude: "claude mcp add -s user vyre -- vyre mcp", codex: "codex mcp add vyre -- vyre mcp" });

/** mcpconn.list's rows, reduced to what is drawn; ended ones stay in the list, labelled. */
export function connectionsOf(d: any): Connection[] {
  return (Array.isArray(d) ? d : [])
    .filter((c: any) => c && typeof c.id === "string" && typeof c.client === "string")
    .map((c: any): Connection => ({ id: c.id, client: c.client, device: typeof c.device === "string" ? c.device : "", created: Number(c.created) || 0, lastUsed: typeof c.lastUsed === "number" ? c.lastUsed : null, revoked: c.revoked === true }));
}

/** mcpconn.activity's rows, reduced to what is drawn. */
export function changesOf(d: any): Change[] {
  return (Array.isArray(d) ? d : [])
    .filter((c: any) => c && typeof c.tool === "string" && typeof c.at === "number")
    .map((c: any): Change => ({ at: c.at, client: typeof c.client === "string" ? c.client : "", tool: c.tool, ok: c.ok !== false, says: typeof c.says === "string" ? c.says : "via your Claude Code" }));
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
