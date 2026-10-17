// Skills library calls on a real vyred (skills.browse, skills.draft, skills.approve, skills.versions, skills.get).

export type SkillRow = { id: string; name: string; level: string; scope?: string; description?: string; tokens?: number; kind?: string; harnesses?: string[]; declares?: { hooks?: unknown[]; mcp?: unknown[] }; ack?: string };
export type SkillVersion = { name: string; level: string; scope?: string; version: number; state: string; kind?: string; proposer?: string; hash?: string; ack?: string; declares?: { hooks?: unknown[]; mcp?: unknown[] } };
export type BrowsePack = { skills: SkillRow[]; drafts?: SkillVersion[]; identityPersonal?: boolean; role?: string; can?: { draft?: Record<string, boolean>; approve?: Record<string, boolean>; plugin?: Record<string, boolean> }; levels?: Record<string, { view: boolean; draft: boolean; approve: boolean; plugin: boolean }> };

type Call = (tool: string, input?: Record<string, unknown>) => Promise<unknown>;

const dataOf = (r: unknown) => (r && typeof r === "object" && "data" in (r as object) ? (r as { data: unknown }).data : r);

export function skillsSource(call: Call) {
  const ask = async (tool: string, input: Record<string, unknown> = {}) => dataOf(await call(tool, input));
  return {
    browse: (level?: string) => ask("skills.browse", level ? { level } : {}) as Promise<BrowsePack>,
    versions: (name: string, level: string, scope = "") => ask("skills.versions", { name, level, ...(scope ? { scope } : {}) }) as Promise<{ versions: SkillVersion[] }>,
    get: (id: string) => ask("skills.get", { id }) as Promise<{ id: string; text: string; description?: string }>,
    draft: (body: { name: string; level: string; scope?: string; kind?: string; body: string; note?: string }) => ask("skills.draft", body),
    approve: (body: { name: string; level: string; scope?: string; version: number; ack?: string }) => ask("skills.approve", body),
    rollback: (body: { name: string; level: string; scope?: string; to: number; ack?: string }) => ask("skills.rollback", body),
    decline: (body: { name: string; level: string; scope?: string; version: number }) => ask("skills.decline", body),
  };
}
