// Teammates (the Deck's project-team.js, ported): the rows team.list answers, one word per state, the role rule, and the one Assign to list.
// Pure: no react, no box. Every value from the box is drawn as text.

export type Teammate = { agent: string; project: string; role: string; brief: string; filler: string | null; state: string; queued: number; current: string | null; last: { state: string; result: string } | null };
export type Duty = { id: string; title: string; instruction: string; trigger: string; act: boolean | null; enabled: boolean; started: boolean; watcher: string };
export type Pane = { notes: string | null; charter: string | null; duties: Duty[]; status: { state: string; position: number | null } | null; errors: number };
export type Assignee = { id: string; name: string; family: string; role?: string };

/** A role is one lowercase word, like design or backend. */
export const ROLE = /^[a-z][a-z0-9-]{0,30}$/;

const STATE_WORDS: Record<string, string> = { idle: "Idle", working: "Working", running: "Working", waiting: "Waiting", queued: "Queued", failed: "Failed", done: "Done" };
/** A teammate's state as a word; an unknown one is shown as sent. */
export const stateWord = (s: unknown) => STATE_WORDS[String(s)] || String(s || "Idle");

/** The first line of a result, clipped: a row shows it, the pane shows it whole. */
export function clip(t: unknown, n = 160): string {
  const s = String(t ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function errWords(e: unknown): string {
  const x = e as { code?: string; message?: string } | null;
  if (x?.code === "not_found" || x?.code === "unknown_tool" || /not available|no such tool/i.test(x?.message || "")) return "Teammates are not available on your server yet.";
  return String(x?.message || e || "That did not go through.");
}

/** team.list's answer: only rows with an agent and a role are kept. */
export function teammatesOf(d: unknown): Teammate[] {
  const list = Array.isArray(d) ? d : Array.isArray((d as any)?.teammates) ? (d as any).teammates : [];
  return list
    .filter((t: any) => t && typeof t.agent === "string" && typeof t.role === "string")
    .map((t: any): Teammate => ({
      agent: String(t.agent), project: t.project ? String(t.project) : "", role: String(t.role), brief: t.brief ? String(t.brief) : "",
      filler: t.filler?.kind === "agent" ? String(t.filler.agent) : null, state: String(t.state || "idle"), queued: Number(t.queued) || 0,
      current: t.current_request ? String(t.current_request) : null,
      last: t.last_result && typeof t.last_result === "object" ? { state: String(t.last_result.state || ""), result: String(t.last_result.result ?? "") } : null,
    }));
}

export function dutiesOf(d: unknown): Duty[] {
  const list = Array.isArray((d as any)?.duties) ? (d as any).duties : [];
  return list.filter((x: any) => x && x.id != null).map((x: any): Duty => ({
    id: String(x.id), title: x.title ? String(x.title) : "", instruction: String(x.instruction || x.id), trigger: x.trigger ? String(x.trigger) : "",
    act: x.act === true ? true : x.act === false ? false : null, enabled: x.enabled === true, started: x.started === true, watcher: x.watcher ? String(x.watcher) : "",
  }));
}

/** What a duty row says under its text: the trigger, and whether it acts. */
export const dutyLine = (d: Duty) => [d.trigger, d.act === true ? "Can make changes" : d.act === false ? "Only looks and tells you" : ""].filter(Boolean).join(" · ");

/** The line under a teammate's name: who fills the role, and its queue. */
export const fillLine = (t: Teammate) => [t.filler ? `${t.filler} fills it` : "The project's helper", t.queued ? `${t.queued} queued` : ""].filter(Boolean).join(" · ");

/** The one line for a row: what it last delivered, or what it is doing now. */
export function rowLine(t: Teammate): string {
  if (t.last) return (t.last.state === "failed" ? "Failed: " : "Last: ") + clip(t.last.result);
  return t.brief ? clip(t.brief, 200) : "";
}

/** The Assign to list: people and agents together, the project's teammates first, then everyone, each group people before agents then by name. A service is never assignable. */
export function assignGroups(actors: Assignee[], onProject: string[] = [], exclude: string[] = []): { title: string; rows: Assignee[] }[] {
  const on = new Set(onProject);
  const out = new Set(exclude);
  const order = (a: Assignee, b: Assignee) => Number(b.family === "person") - Number(a.family === "person") || a.name.localeCompare(b.name);
  const pool = actors.filter((a) => a.family !== "service" && !out.has(a.id));
  const first = pool.filter((a) => on.has(a.id)).sort(order);
  const rest = pool.filter((a) => !on.has(a.id)).sort(order);
  return [first.length ? { title: "On this project", rows: first } : null, rest.length ? { title: first.length ? "Everyone" : "People and assistants", rows: rest } : null].filter(Boolean) as { title: string; rows: Assignee[] }[];
}

/** Narrow the groups by what was typed (name or role, any case). */
export function searchGroups(groups: { title: string; rows: Assignee[] }[], q: string) {
  const s = q.trim().toLowerCase();
  if (!s) return groups;
  return groups.map((g) => ({ ...g, rows: g.rows.filter((a) => a.name.toLowerCase().includes(s) || String(a.role || "").toLowerCase().includes(s)) })).filter((g) => g.rows.length);
}

/** Teammates grouped by project for the Assistants page, projects by name; a teammate with no project goes under "Everywhere". */
export function byProject(rows: Teammate[]): { project: string; rows: Teammate[] }[] {
  const m = new Map<string, Teammate[]>();
  for (const t of rows) { const k = t.project || ""; (m.get(k) || m.set(k, []).get(k)!).push(t); }
  return [...m.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b))).map(([project, r]) => ({ project, rows: r.sort((a, b) => a.role.localeCompare(b.role)) }));
}

/** What every team.* tool takes for `project`: the Project record's id (a vyre:// address works too). A short name is refused by the box, and a slug is display only, so a project with no slug has a team all the same. */
export function projectId(row: { id?: unknown } | null | undefined): string {
  return typeof row?.id === "string" ? row.id.trim() : "";
}

/** A project's name for the Assistants page: the box's answer for its id, else a plain word, never the raw id. */
export const projectTitle = (id: string, names: Record<string, string>) => (id ? names[id] || "A project" : "Everywhere");

export type Member = { agent: string; role: string };

/** work.project.members' answer: rows with an agent. */
export function membersOf(d: unknown): Member[] {
  const list = Array.isArray((d as any)?.members) ? (d as any).members : [];
  return list.filter((m: any) => m && typeof m.agent === "string" && m.agent).map((m: any): Member => ({ agent: String(m.agent), role: String(m.role || "") }));
}

/** Who is on the project's team but is not one of its teammates (a project started from a template names its roles and the assistants that fill them): shown beside the teammates so a project is never "No teammates yet" over a team its timeline names. */
export function rosterOnly(teammates: Teammate[], members: Member[]): Member[] {
  const known = new Set(teammates.flatMap((t) => [t.agent, t.filler || ""]).filter(Boolean));
  return members.filter((m) => !known.has(m.agent));
}
