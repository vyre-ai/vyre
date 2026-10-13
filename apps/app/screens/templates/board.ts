// The template board's words and shapes, pure (no React, no calls): the columns of a pipeline, the card of a task, the rule of a stage, the version bar and how many things differ from the live version. Tested by board.test.js.
import { assigneeWords, doneWhenOf, kindOfDoer, stageModeOf, dueDays } from "./edit.ts";
import { whoWords, type Body, type Stage, type Task } from "./model.ts";

type Who = { id: string; name: string };

/** What this screen is called, in one place (the owner is choosing the name). */
export const TEMPLATES_LABEL = "Templates";

const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

/** A stage's rule in words: when it counts as done. */
export function doneRule(s: Stage, _b?: Body): string {
  const w = doneWhenOf(s);
  if (w === "all") return "Every task is done";
  if (w === "sign_off") return s.sign_off ? `${cap(whoWords(s.sign_off))} signs it off` : "Someone signs it off";
  return "The tasks needed to finish are done";
}

export type Person = { label: string; kind: "role" | "lead" | "person" | "agent" };
export type Card = { index: number; title: string; assignee: Person; approver: Person | null; followers: Person[]; due: string; needsYes: string; group: string; optional: boolean };
export type Column = { index: number; name: string; rule: string; last: boolean; groups: string[]; tasks: Card[] };

/** One task as a card. */
export function taskCard(t: Task, b: Body, people: Who[] = [], agents: Who[] = [], index = 0): Card {
  const p = (d: string): Person => ({ label: assigneeWords(d, people, agents), kind: kindOfDoer(d) });
  const days = dueDays(t);
  return {
    index, title: t.title, assignee: p(t.doer), approver: t.checker ? p(t.checker) : null, followers: (t.followers || []).map(p),
    due: days ? `${days} ${days === "1" ? "day" : "days"}` : "", needsYes: (t.needs_yes || [])[0] || "", group: t.group || "", optional: t.required === false,
  };
}

/** The pipeline: one column per stage (a single "Tasks" column when projects have no stages). */
export function boardColumns(b: Body, people: Who[] = [], agents: Who[] = []): Column[] {
  const stages = stageModeOf(b) === "none" ? b.stages.slice(0, 1) : b.stages;
  return stages.map((s, i) => ({
    index: i, name: stageModeOf(b) === "none" ? "Tasks" : s.name, rule: stageModeOf(b) === "none" ? "" : doneRule(s, b), last: i === stages.length - 1,
    groups: (s.groups || []).map((g) => g.name), tasks: (s.tasks || []).map((t, ti) => taskCard(t, b, people, agents, ti)),
  }));
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** How many things differ from the live version: a template setting, a stage's own settings, and each task added, removed or changed count once (by position, so a rename is one change). */
export function changeCount(live: Body | null, cur: Body): number {
  if (!live) return 0;
  const { stages: ls, ...lrest } = live, { stages: cs, ...crest } = cur;
  let n = same(lrest, crest) ? 0 : Object.keys({ ...lrest, ...crest }).filter((k) => !same((lrest as any)[k], (crest as any)[k])).length;
  // by position: a rename or an edit is one change, an added or removed stage or task is one
  for (let i = 0; i < Math.max(ls.length, cs.length); i++) {
    const a = ls[i], c = cs[i];
    if (!a || !c) { n++; continue; }
    const { tasks: at, ...arest } = a, { tasks: ct, ...crest2 } = c;
    if (!same(arest, crest2)) n++;
    for (let k = 0; k < Math.max((at || []).length, (ct || []).length); k++) if (!same((at || [])[k], (ct || [])[k])) n++;
  }
  return n;
}

/** The bar over the board: what is live, what changed, and whether there is something to publish. */
export function versionBar({ live, changes }: { live: number | null; changes: number }): { line: string; canPublish: boolean } {
  if (live === null) return { line: changes ? `Not live yet · Draft changes: ${changes}` : "Not live yet", canPublish: true };
  return { line: changes ? `Live: v${live} · Draft changes: ${changes}` : `Live: v${live} · No changes`, canPublish: changes > 0 };
}

/** Letters for an avatar: "Alex Rivera" is AR, "The paralegal" is P, "Research (assistant)" is R. */
export function initialsOf(label: string): string {
  const words = label.replace(/\(.*?\)/g, " ").replace(/^the\s+/i, "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0][0]).toUpperCase();
}
