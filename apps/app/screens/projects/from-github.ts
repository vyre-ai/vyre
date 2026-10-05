// "New project from a GitHub repo": github.project clones the repo fresh (never into an existing folder) and makes the project; its short name comes back so the app can open it.
// Over an injected `call` (the app's box connection, or a fake box in a test).

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;
export type Made = { project: string; home: string; full_name: string };

/** The github.project input for a picked repo: its full name, and the account only when one was chosen. */
export const projectInput = (full: string, account: string): Record<string, unknown> => ({ repo: full, ...(account ? { account } : {}) });

export function githubProjectSource(call: Call) {
  return {
    /** Make the project. Throws the box's own code and words (a clone that failed names where it was left). */
    async create(full: string, account: string): Promise<Made> {
      const r = await call<{ project?: string; home?: string; full_name?: string }>("github.project", projectInput(full, account));
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      const project = typeof r.data?.project === "string" ? r.data.project : "";
      return { project, home: String(r.data?.home ?? ""), full_name: String(r.data?.full_name ?? full) };
    },
  };
}

/** The record id of the project with this short name, from the project rows (a row's `data.slug`), or null while the record is not there yet. */
export function findProjectId(rows: { id?: unknown; data?: { slug?: unknown } }[], slug: string): string | null {
  if (!slug) return null;
  const hit = rows.find((r) => r && r.data && r.data.slug === slug && typeof r.id === "string");
  return hit ? String(hit.id) : null;
}

/** What the person reads when it did not work. */
export function creationRefusal(e: { code?: string; message?: string } | null | undefined, full: string): string {
  if (e?.code === "no_such_tool") return "This server cannot make a project from GitHub yet.";
  if (e?.code === "config") return "This server has no projects folder to clone into yet.";
  return `Could not make a project from ${full}: ${e?.message || e?.code || "it did not work"}`;
}
export const startedLine = (full: string): string => `Cloning ${full} and making the project.`;
export const madeLine = (full: string): string => `Made a project from ${full}.`;
