// Writing a playbook as a list, pure (no React, no calls): the blank one, what each key does on a task line, the checklist beside it, the stage sets to start from and the words of the save state and the publish
// sheet. Tested by compose.test.js. Every change to the body goes through edit.ts.
import * as E from "./edit.ts";
import { pluralOf } from "./edit.ts";
import type { Body, Stage } from "./model.ts";

export const DEFAULT_NAME = "Untitled playbook";
/** What a blank playbook starts as: one stage to fill and the end. */
export const starterBody = (): Body => ({ name: DEFAULT_NAME, stages: [{ name: "Stage 1" }, { name: "Done" }] });

/** What a firm calls one project of a playbook, to pick from. */
export const NOUN_SUGGESTIONS = ["Matter", "Client", "Case", "Engagement", "Project"];

/** Common stage sets, one click each. */
const DEFAULT_DOER = "role:owner";
export const STAGE_SETS: { id: string; stages: string[] }[] = [
  { id: "intake", stages: ["Intake", "Review", "Signing", "Closing"] },
  { id: "estate", stages: ["Opening", "Administration", "Inventory", "Closing"] },
  { id: "lead", stages: ["Lead", "Consult", "Engaged"] },
];
export const setLabel = (stages: string[]): string => stages.join(" › ");

export type KitOutline = { id: string; name: string; stages: number; tasks: number; outline?: { name: string; tasks: string[] }[] };
/** The Kit whose stage names are this set's, in order (any case), or null. */
export function kitFor(id: string, lib: KitOutline[]): KitOutline | null {
  const set = STAGE_SETS.find((s) => s.id === id);
  if (!set) return null;
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x.trim().toLowerCase() === b[i].trim().toLowerCase());
  return lib.find((k) => k.outline && same(k.outline.map((o) => o.name), set.stages)) || null;
}

/** The stage titles become the set's; the tasks already written stay in the stage at the same place; a matching Kit fills the stages that have none with its tasks (titles only, given to the owner until someone chooses). */
export function applyStageSet(b: Body, id: string, kit: KitOutline | null = null): Body {
  const set = STAGE_SETS.find((s) => s.id === id);
  if (!set) return b;
  return { ...b, stages: set.stages.map((name, i): Stage => {
    const { name: _n, ...rest } = b.stages[i] || ({} as Stage);
    const have = (rest.tasks || []).length > 0;
    const from = !have && kit?.outline ? kit.outline[i]?.tasks || [] : [];
    return { ...rest, name, ...(from.length ? { tasks: from.map((title) => ({ title, doer: DEFAULT_DOER, output: { kind: "note" } })) } : {}) } as Stage;
  }) };
}

export type At = { si: number; ti: number };
export type KeyResult = { body: Body; focus: At; /** the line is emptied for the next task */ clear?: boolean; /** text to put into the line (a task taken back to edit) */ fill?: string };

const freeStageName = (b: Body, from: number): string => { const have = new Set(b.stages.map((s) => s.name)); let n = from; while (have.has(`Stage ${n}`)) n++; return `Stage ${n}`; };
const lenOf = (b: Body, si: number): number => (b.stages[si]?.tasks || []).length;

/**
 * What a key does on the line at the end of a stage (`at.ti` is the number of tasks it already has). Enter adds the typed task and opens the next line; Tab on an empty line starts a stage after this one;
 * Shift+Tab goes back to the stage before; Backspace on an empty line takes the last task back into the line, or removes an empty stage (never the first).
 */
export function typeKey(b: Body, at: At, text: string, key: string): KeyResult {
  const empty = text.trim() === "";
  const stay: KeyResult = { body: b, focus: at };
  if (key === "Enter") {
    if (empty) return stay;
    const len = lenOf(b, at.si);
    const added = E.setTask(E.addTask(b, at.si), at.si, len, { title: text.trim() });
    return { body: added, focus: { si: at.si, ti: len + 1 }, clear: true };
  }
  if (key === "Tab") {
    if (!empty) return stay;
    const stages = [...b.stages];
    stages.splice(at.si + 1, 0, { name: freeStageName(b, at.si + 2) });
    return { body: { ...b, stages }, focus: { si: at.si + 1, ti: 0 } };
  }
  if (key === "Shift+Tab") return at.si === 0 ? stay : { body: b, focus: { si: at.si - 1, ti: lenOf(b, at.si - 1) } };
  if (key === "Backspace" && empty) {
    const len = lenOf(b, at.si);
    if (len > 0) { const last = (b.stages[at.si].tasks || [])[len - 1]; return { body: E.removeTask(b, at.si, len - 1), focus: { si: at.si, ti: len - 1 }, fill: last.title }; }
    if (at.si > 0 && b.stages.length > 2) return { body: E.removeStage(b, at.si), focus: { si: at.si - 1, ti: lenOf(b, at.si - 1) } };
  }
  return stay;
}

const renamed = (b: Body): boolean => b.stages.some((s) => !/^Stage \d+$/.test(s.name) && s.name !== "Done");
const hasTask = (b: Body): boolean => b.stages.some((s) => (s.tasks || []).some((t) => t.title.trim()));

/** Whether it can be published, and what is missing in words. */
export function canPublish(b: Body): { ok: boolean; why: string } {
  if (!b.name.trim() || b.name.trim() === DEFAULT_NAME) return { ok: false, why: "Give the playbook a name." };
  if (b.stages.length < 2) return { ok: false, why: "A playbook needs a stage to start in and one to end in." };
  if (!hasTask(b)) return { ok: false, why: "Add at least one task." };
  const miss = E.missing(b);
  return miss.length ? { ok: false, why: miss[0] } : { ok: true, why: "" };
}

/** The light checklist beside a draft: each item ticks itself; the optional ones can be ignored. */
export function checklist(b: Body): { id: string; label: string; done: boolean; optional: boolean }[] {
  const tasks = b.stages.flatMap((s) => s.tasks || []);
  return [
    { id: "name", label: "Name it", done: Boolean(b.name.trim()) && b.name.trim() !== DEFAULT_NAME, optional: false },
    { id: "stages", label: "Stages", done: renamed(b), optional: false },
    { id: "tasks", label: "Tasks", done: hasTask(b), optional: false },
    { id: "who", label: "Who does them", done: tasks.some((t) => t.doer !== DEFAULT_DOER), optional: true },
    { id: "done", label: "When a stage is done", done: b.stages.some((s) => s.done_when !== undefined), optional: true },
    { id: "publish", label: "Publish", done: false, optional: false },
  ];
}

/** The draft's save state, next to the version bar. */
export const saveState = ({ dirty, saving, error }: { dirty: boolean; saving: boolean; error: string }): string => (error ? `Draft · not saved: ${error}` : saving ? "Draft · saving" : dirty ? "Draft · unsaved" : "Draft · saved");

/** What publishing changes, in plain words. */
export function publishWords({ name, noun, live }: { name: string; noun?: { one: string; many: string }; stages: Stage[]; live: number | null }): string {
  const many = (noun?.many || pluralOf(noun?.one || "project")).toLowerCase();
  return live === null
    ? `This is the first version of ${name}. Once it is published, new ${many} can start from it.`
    : `Publishing makes version ${live + 1} the one new ${many} start from. ${cap(many)} already running keep the version they started with.`;
}
const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);
