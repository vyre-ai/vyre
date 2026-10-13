// The template studio's visual editor, pure (no React, no calls): every change a person makes to a template is a function from one body to the next, so the screen only binds fields to these and a test
// can say what each one does. Nothing here talks to the box; the box checks the saved draft again (work.template.define).
import type { Body, Group, Noun, Stage, Task } from "./model.ts";

export const PAGES: [string, string][] = [["", "The usual (stages)"], ["stages", "Stages"], ["chats", "Chats"], ["files", "Files"], ["memory", "Memory"], ["timeline", "Timeline"], ["team", "Team"]];
export const OUTPUTS: [string, string][] = [["note", "A note"], ["decision", "A yes or no"], ["file", "A file"], ["record", "A record"]];

const move = <T,>(list: T[], i: number, by: -1 | 1): T[] => {
  const j = i + by;
  if (j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
};
const at = <T,>(list: T[], i: number, f: (x: T) => T): T[] => list.map((x, n) => (n === i ? f(x) : x));
const dropEmpty = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v !== undefined)) as T;

/** A template to start from: a name, a first and a last stage, one task. */
export const blank = (): Body => ({ name: "", stages: [{ name: "Start", tasks: [{ title: "", doer: "role:owner", output: { kind: "note" } }] }, { name: "Done" }] });

export const setName = (b: Body, name: string): Body => ({ ...b, name });
/** The plural of a word a person names their projects: "Matter" to "Matters", "Policy" to "Policies", "Branch" to "Branches". */
export const pluralOf = (one: string): string => (/[^aeiou]y$/i.test(one) ? `${one.slice(0, -1)}ies` : /(s|x|z|ch|sh)$/i.test(one) ? `${one}es` : `${one}s`);
/** What this template's projects are called ("Matter", "Matters"). The plural follows the singular unless it was given by hand; an empty singular takes the name away. */
export const setNoun = (b: Body, one: string, many?: string): Body => {
  const { noun: old, ...rest } = b;
  if (!one.trim()) return rest as Body;
  const kept = old && old.many !== pluralOf(old.one) ? old.many : undefined; // a plural set by hand stays
  return { ...rest, noun: { one: one.trim(), many: (many ?? kept ?? pluralOf(one.trim())).trim() } } as Body;
};
/** The words a screen uses for one of this template's projects; "Project" when the template does not say. */
export const nounOf = (b: Body | null | undefined): Noun => b?.noun?.one ? b.noun : { one: "Project", many: "Projects" };
export const setDescription = (b: Body, description: string): Body => dropEmpty({ ...b, description });
/** The page a project of this template opens on; "" is the usual one. */
export const setOpensOn = (b: Body, page: string): Body => { const { opens_on: _o, ...rest } = b as Body & { opens_on?: string }; return (page ? { ...rest, opens_on: page } : rest) as Body; };

export const addStage = (b: Body): Body => ({ ...b, stages: [...b.stages, { name: `Stage ${b.stages.length + 1}` }] });
export const renameStage = (b: Body, i: number, name: string): Body => { const old = b.stages[i]?.name; const next = { ...b, stages: at(b.stages, i, (s) => ({ ...s, name })), ...(b.automations ? { automations: b.automations.map((a) => (a.when === old ? { ...a, when: name } : a)) } : {}) }; return next as Body; };
export const moveStage = (b: Body, i: number, by: -1 | 1): Body => ({ ...b, stages: move(b.stages, i, by) });
export const removeStage = (b: Body, i: number): Body => tidyAutomations({ ...b, stages: b.stages.filter((_, n) => n !== i) });
/** Who may move a project out of the stage early ("" for no one in particular). */
export const setStageOwner = (b: Body, i: number, owner: string): Body => ({ ...b, stages: at(b.stages, i, (s) => { const { owner: _o, ...rest } = s; return (owner ? { ...rest, owner } : rest) as Stage; }) });
export const setMovesOn = (b: Body, i: number, text: string): Body => ({ ...b, stages: at(b.stages, i, (s) => { const { moves_on_when: _m, ...rest } = s; return (text.trim() ? { ...rest, moves_on_when: text.trim() } : rest) as Stage; }) });

/** A stage's task groups, in order. */
export const groupsOf = (s: Stage): Group[] => s.groups || [];
/** What GroupedList hands back after an add, rename, move or delete: the stage's groups and its tasks (a rename or a delete has already moved the tasks). A task never names a group the stage does not have. */
export function setStageGroups(b: Body, si: number, next: { groups: Group[]; items: Task[] }): Body {
  const have = new Set(next.groups.map((g) => g.name));
  return { ...b, stages: at(b.stages, si, (s) => {
    const { groups: _g, tasks: _t, ...rest } = s;
    const tasks = next.items.map((t) => { if (!t.group || have.has(t.group)) return t; const { group: _x, ...r } = t; return r as Task; });
    return { ...rest, ...(next.groups.length ? { groups: next.groups } : {}), ...(tasks.length ? { tasks } : {}) } as Stage;
  }) };
}
export const addTask = (b: Body, si: number): Body => ({ ...b, stages: at(b.stages, si, (s) => ({ ...s, tasks: [...(s.tasks || []), { title: "", doer: firstDoer(b), output: { kind: "note" } }] })) });
export const setTask = (b: Body, si: number, ti: number, patch: Partial<Task> & { output_kind?: string }): Body => ({
  ...b,
  stages: at(b.stages, si, (s) => ({ ...s, tasks: at(s.tasks || [], ti, (t) => {
    const { output_kind, ...rest } = patch;
    const next: Task = { ...t, ...rest, ...(output_kind ? { output: { ...t.output, kind: output_kind } } : {}) };
    if (rest.doer !== undefined && !String(rest.doer).startsWith("teammate:")) delete next.needs_yes; // a yes is asked of an assistant's work, not a person's
    return dropEmpty(next) as Task;
  }) })),
});
export const moveTask = (b: Body, si: number, ti: number, by: -1 | 1): Body => ({ ...b, stages: at(b.stages, si, (s) => ({ ...s, tasks: move(s.tasks || [], ti, by) })) });
export const removeTask = (b: Body, si: number, ti: number): Body => ({ ...b, stages: at(b.stages, si, (s) => { const tasks = (s.tasks || []).filter((_, n) => n !== ti); const { tasks: _t, ...rest } = s; return (tasks.length ? { ...rest, tasks } : rest) as Stage; }) });

/** A role a task can be given to; a role no task names is still kept. */
export const addRole = (b: Body, role: string): Body => (role && !(b.roles || []).some((r) => r.role === role) ? { ...b, roles: [...(b.roles || []), { role }] } : b);
export const setRoleAgent = (b: Body, role: string, agent: string): Body => ({ ...b, roles: (b.roles || []).map((r) => (r.role === role ? dropEmpty({ ...r, agent }) : r)) });
export const setRoleLead = (b: Body, role: string, lead: boolean): Body => ({ ...b, roles: (b.roles || []).map((r) => ({ ...r, lead: lead && r.role === role ? true : undefined })).map((r) => dropEmpty(r)) });
/** Removing a role also takes it off the tasks and stages that name it, so the template never points at a role that is gone. */
export function removeRole(b: Body, role: string): Body {
  const ref = `role:${role}`;
  const fix = (s: Stage): Stage => {
    const { owner, ...rest } = s;
    return { ...rest, ...(owner && owner !== ref ? { owner } : {}), ...(s.tasks ? { tasks: s.tasks.map((t) => dropEmpty({ ...t, doer: t.doer === ref ? "" : t.doer, checker: t.checker === ref ? "" : t.checker }) as Task) } : {}) };
  };
  const roles = (b.roles || []).filter((r) => r.role !== role);
  return { ...b, ...(roles.length ? { roles } : { roles: undefined }), stages: b.stages.map(fix) } as Body;
}

/** The doers a task can be given: this template's roles, then "a person" for work only a person does. */
export const doerChoices = (b: Body): [string, string][] => [...(b.roles || []).map((r): [string, string] => [`role:${r.role}`, `The ${r.role}`]), ["role:owner", "The owner"]];
/** Who a task can be given to, in the order a person looks: this template's roles, the project's lead, the people of the Space, then its assistants. */
export const assigneeChoices = (b: Body, people: { id: string; name: string }[] = [], agents: { id: string; name: string }[] = []): [string, string][] => [
  ...(b.roles || []).map((r): [string, string] => [`role:${r.role}`, `The ${r.role}`]),
  ["lead", "The project lead"],
  ...people.map((p): [string, string] => [`person:${p.id}`, p.name]),
  ...agents.map((a): [string, string] => [`teammate:${a.id}`, `${a.name} (assistant)`]),
];
export const kindOfDoer = (d: string): "role" | "lead" | "person" | "agent" => (d === "lead" ? "lead" : d.startsWith("person:") ? "person" : d.startsWith("teammate:") ? "agent" : "role");
/** The doer in words, even when the person or assistant is not in the lists. */
export function assigneeWords(d: string, people: { id: string; name: string }[] = [], agents: { id: string; name: string }[] = []): string {
  const hit = assigneeChoices({ name: "", stages: [] }, people, agents).find(([v]) => v === d);
  if (hit) return hit[1];
  return d === "lead" ? "The project lead" : d.startsWith("role:") ? `The ${d.slice(5)}` : d.startsWith("person:") ? "A person" : d.startsWith("teammate:") ? `${d.slice(9).charAt(0).toUpperCase()}${d.slice(10)} (assistant)` : d;
}
const DAY = 86_400_000;
/** A task's due, in whole days after the project enters the stage; "" for none. */
export const dueDays = (t: Task & { due_offset_ms?: number }): string => (t.due_offset_ms ? String(Math.round(t.due_offset_ms / DAY)) : "");
/** Set it from what a person typed: a number of days, or nothing/0 to take it away; anything else changes nothing. */
export function setDueDays(b: Body, si: number, ti: number, text: string): Body {
  const t = text.trim();
  if (t !== "" && !/^\d{1,4}$/.test(t)) return b;
  const n = t === "" ? 0 : Number(t);
  return { ...b, stages: at(b.stages, si, (s) => ({ ...s, tasks: at(s.tasks || [], ti, (k) => { const { due_offset_ms: _d, ...rest } = k as Task & { due_offset_ms?: number }; return (n > 0 ? { ...rest, due_offset_ms: n * DAY } : rest) as Task; }) })) };
}
/** What waits for a person's yes before an assistant does this task (one line), or "". */
export const approvalOf = (t: Task): string => (t.needs_yes || [])[0] || "";
export function setApproval(b: Body, si: number, ti: number, text: string): Body {
  const v = text.trim();
  return { ...b, stages: at(b.stages, si, (s) => ({ ...s, tasks: at(s.tasks || [], ti, (k) => { const { needs_yes: _n, ...rest } = k; return (v ? { ...rest, needs_yes: [v] } : rest) as Task; }) })) };
}
export const firstDoer = (b: Body): string => doerChoices(b)[0][0];
export const ownerChoices = (b: Body): [string, string][] => [["", "No one in particular"], ...(b.roles || []).map((r): [string, string] => [`role:${r.role}`, `The ${r.role}`])];

/** What is missing before it can be saved, in words a person reads; the box checks the rest. */
export function missing(b: Body): string[] {
  const out: string[] = [];
  if (!b.name.trim()) out.push("Give the template a name.");
  if (b.noun && !b.noun.many.trim()) out.push(`Say what several ${b.noun.one.toLowerCase()} projects are called, such as "${pluralOf(b.noun.one)}".`);
  if (b.stages.length < 2) out.push("A template has at least two stages: where it starts and where it ends.");
  b.stages.forEach((s, i) => {
    if (!s.name.trim()) out.push(`Stage ${i + 1} needs a name.`);
    (s.tasks || []).forEach((t, n) => {
      if (!t.title.trim()) out.push(`Task ${n + 1} of ${s.name || `stage ${i + 1}`} needs a title.`);
      if (!t.doer) out.push(`${t.title || `Task ${n + 1}`} in ${s.name || `stage ${i + 1}`} needs someone to do it.`);
    });
  });
  return out;
}

/** The points an automation can sit at: when a project starts, or when it enters one of the template's stages. */
export const whenChoices = (b: Body): [string, string][] => [["start", "When a project starts"], ...b.stages.filter((s) => s.name.trim()).map((s): [string, string] => [s.name, `When a project enters ${s.name}`])];
/** Attach a Flow at a point; the same Flow at the same point once. */
export const addAutomation = (b: Body, flow: string, when = "start"): Body => ((b.automations || []).some((a) => a.when === when && a.flow === flow) ? b : { ...b, automations: [...(b.automations || []), { when, flow }] });
export const setAutomationWhen = (b: Body, i: number, when: string): Body => ({ ...b, automations: (b.automations || []).map((a, n) => (n === i ? { ...a, when } : a)) });
export const removeAutomation = (b: Body, i: number): Body => { const automations = (b.automations || []).filter((_, n) => n !== i); const { automations: _a, ...rest } = b; return (automations.length ? { ...rest, automations } : rest) as Body; };
/** A stage renamed or removed takes its automations with it, so the template never points at a stage that is gone. */
export const tidyAutomations = (b: Body): Body => { const ok = new Set(["start", ...b.stages.map((s) => s.name)]); const keep = (b.automations || []).filter((a) => ok.has(a.when)); const { automations: _a, ...rest } = b; return (keep.length ? { ...rest, automations: keep } : rest) as Body; };
