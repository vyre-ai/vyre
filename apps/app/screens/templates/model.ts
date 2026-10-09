// The template studio's words and shapes, pure (no React, no calls): what a list of templates, one version's tree, a test run and the editor's text say. Tested by templates.test.js.
export type Version = { template: string; version: number; name: string; state: "draft" | "live" | "retired"; owner: string | null; kit?: string; note?: string; tags: string[]; body?: Body };
export type Task = { title: string; doer: string; checker?: string; output: { kind: string }; required?: boolean; depends_on?: string[]; brief?: string; checklist?: { say: string }[]; credentials?: string[]; needs_yes?: string[]; ask?: string; context?: string[] };
export type Stage = { name: string; owner?: string; moves_on_when?: string; tasks?: Task[] };
export type Body = { name: string; description?: string; tags?: string[]; roles?: { role: string; agent?: string; lead?: boolean }[]; stages: Stage[] };
export type Row = { template: string; name: string; live: number | null; latest: number; versions: number; owner: string | null; tags: string[] };

export const STATE: Record<string, string> = { draft: "Draft", live: "Live", retired: "Retired" };
export const stateWord = (s: string): string => STATE[s] || s;
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The list line of one template: its versions and which is live. */
export function rowLine(r: Row): string {
  return `${plural(r.versions, "version")}, ${r.live === null ? `none live (version ${r.latest} is the newest)` : `version ${r.live} is live`}`;
}

/** The tree of a version as lines a screen indents: the stage, its owner and condition, then each task with its doer. Empty stages say so. */
export function treeOf(b: Body): { depth: 0 | 1; text: string; note?: string }[] {
  const out: { depth: 0 | 1; text: string; note?: string }[] = [];
  b.stages.forEach((s, i) => {
    const bits = [s.owner ? `${s.owner} may move it early` : "", i > 0 && b.stages[i - 1].moves_on_when ? `entered when ${b.stages[i - 1].moves_on_when}` : ""].filter(Boolean);
    out.push({ depth: 0, text: `${i + 1}. ${s.name}`, ...(bits.length ? { note: bits.join("; ") } : {}) });
    if (!(s.tasks || []).length) out.push({ depth: 1, text: i === b.stages.length - 1 ? "The last stage: the project ends here." : "No tasks: a person moves it on." });
    for (const t of s.tasks || []) out.push({ depth: 1, text: t.title, note: `${t.doer}${t.checker ? `, checked by ${t.checker}` : ""}${t.required === false ? ", optional" : ""}` });
  });
  return out;
}

/** The roles a template fills, as one line each. */
export const roleLines = (b: Body): string[] => (b.roles || []).map((r) => `${r.role}${r.agent ? ` is ${r.agent}` : " is a person with that role"}${r.lead ? " (the project lead)" : ""}`);

/** The editor starts from the version's body as formatted JSON; what it saves is parsed here, with a plain word when it is not JSON. */
export const bodyText = (b: Body): string => JSON.stringify(b, null, 2);
export function parseBody(text: string): { ok: true; body: Body } | { ok: false; why: string } {
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, why: "A template is an object with a name and stages." };
    return { ok: true, body: v as Body };
  } catch (e) { return { ok: false, why: `That is not valid JSON: ${(e as Error).message}` }; }
}

/** The words under a refused or failed call: the box says what and why. */
export const errWords = (e: unknown): string => (e instanceof Error && e.message ? e.message : "That did not work.");
