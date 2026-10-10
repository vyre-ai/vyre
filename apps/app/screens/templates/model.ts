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

/** A task's doer or checker in words a person says: "the attorney", "Research", "a person", never `role:attorney`. */
export function whoWords(ref: string): string {
  const [kind, ...rest] = String(ref).split(":");
  const name = rest.join(":");
  return kind === "role" ? `the ${name}` : kind === "teammate" ? name.charAt(0).toUpperCase() + name.slice(1) : kind === "person" ? "a person" : kind === "pool" ? `anyone in ${name}` : String(ref);
}
const first = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The tree of a version as lines a screen indents: the stage, its owner and condition, then each task with its doer. Empty stages say so. */
export function treeOf(b: Body): { depth: 0 | 1; text: string; note?: string }[] {
  const out: { depth: 0 | 1; text: string; note?: string }[] = [];
  b.stages.forEach((s, i) => {
    const bits = [s.owner ? `${first(whoWords(s.owner))} may move it early` : "", i > 0 && b.stages[i - 1].moves_on_when ? `entered when ${b.stages[i - 1].moves_on_when}` : ""].filter(Boolean);
    out.push({ depth: 0, text: `${i + 1}. ${s.name}`, ...(bits.length ? { note: bits.join("; ") } : {}) });
    if (!(s.tasks || []).length) out.push({ depth: 1, text: i === b.stages.length - 1 ? "The last stage: the project ends here." : "No tasks: a person moves it on." });
    for (const t of s.tasks || []) out.push({ depth: 1, text: t.title, note: `${first(whoWords(t.doer))}${t.checker ? `, checked by ${whoWords(t.checker)}` : ""}${t.required === false ? ", optional" : ""}` });
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

/** The name a project is started under, or why it cannot be: a name is what the person calls the project ("Rivera Family Trust"). */
export function startName(text: string): { ok: true; name: string } | { ok: false; why: string } {
  const name = text.trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, why: "Give the project a name, such as the client's." };
  if (name.length > 120) return { ok: false, why: "A project name is at most 120 characters." };
  return { ok: true, name };
}

/** The id a project page opens by, from the address the box answers with. */
export const projectIdOf = (urn: string): string => String(urn).split("/").pop() || "";

/**
 * What the toast says after Start project: where the first tasks are, or which could not be made and why (an assistant that is not in this space yet), so "its first tasks are in Now" is never said of tasks
 * that do not exist.
 */
export function startWords(name: string, r: { tasks_made?: number; tasks_skipped?: { task: string; why: string }[] }): string {
  const skipped = Array.isArray(r.tasks_skipped) ? r.tasks_skipped : [];
  if (!skipped.length) return `${name} is started. Its first tasks are in Now.`;
  const made = Number(r.tasks_made) || 0;
  const why = [...new Set(skipped.map((x) => x.why))].slice(0, 2).join("; ");
  return `${name} is started, but ${skipped.length} of its first ${made + skipped.length === 1 ? "task" : "tasks"} could not be made: ${why}. ${made ? "The others are in Now." : "Add the assistant in Settings, Assistants, and start again."}`;
}
