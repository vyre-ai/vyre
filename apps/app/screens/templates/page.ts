// A playbook's page and list rows, pure (no React, no calls): the headline sentence, the stage cards, the meta line. Tested by page.test.js. The words are the ones the approved Flow page uses.
import { approverOf, assigneeWords, lateWords, stageModeOf } from "./edit.ts";
import type { Body } from "./model.ts";

type Who = { id: string; name: string };
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export const PAGE_TABS: ["stages" | "projects" | "test" | "versions", string][] = [["stages", "Stages"], ["projects", "Projects"], ["test", "Test"], ["versions", "Versions"]];

const todosIn = (b: Body): number => b.stages.reduce((k, s) => k + (s.tasks || []).length, 0);
const flowsIn = (b: Body): number => new Set((b.automations || []).map((a) => a.flow)).size;
const article = (word: string): string => (/^[aeiou]/i.test(word) ? "An" : "A");
const join = (names: string[]): string => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "");

/** "A launch goes Brief, Draft and Review, with 14 to-dos and 2 Flows." `short` leaves the counts off (a list row has them on its second line). */
export function sentenceOf(b: Body, short = false): string {
  const name = b.name.trim().toLowerCase() || "project", todos = todosIn(b), flows = flowsIn(b);
  const counts = [...(todos ? [plural(todos, "to-do")] : []), ...(flows ? [plural(flows, "Flow")] : [])].join(" and ");
  if (stageModeOf(b) === "none" || !b.stages.length) return `${article(name)} ${name} is a list of ${counts || "no to-dos yet"}.`;
  return `${article(name)} ${name} goes ${join(b.stages.map((s) => s.name))}${!short && counts ? `, with ${counts}` : ""}.`;
}

export type StageTodo = { title: string; doer: string; reviewer: string; approver: string; brief: string; optional: boolean; late: string };
export type StageFlow = { flow: string; label: string; when: string; note: string };
export type StageCard = { index: number; name: string; summary: string; todos: StageTodo[]; flows: StageFlow[] };

/** The first line of a brief, cut at 140 characters. */
const firstLine = (text: string | undefined): string => { const l = String(text || "").split("\n").map((x) => x.trim()).find(Boolean) || ""; return l.length > 140 ? `${l.slice(0, 137)}...` : l; };

/** One card per stage: its to-dos (doer, checker, the first line of the brief), the Flows that turn on there (start Flows in the first stage), and the line the closed card shows. */
export function stageCards(b: Body, people: Who[] = [], agents: Who[] = []): StageCard[] {
  return b.stages.map((s, i) => {
    const todos = (s.tasks || []).map((t): StageTodo => ({ title: t.title, doer: assigneeWords(t.doer, people, agents), reviewer: t.reviewer ? assigneeWords(t.reviewer.who, people, agents) : "", approver: approverOf(t) ? assigneeWords(approverOf(t)!.who, people, agents) : "", late: lateWords(t, people, agents), brief: firstLine(t.brief), optional: t.required === false }));
    const flows = (b.automations || []).filter((a) => (i === 0 && a.when === "start") || a.when === s.name).map((a): StageFlow => ({ flow: a.flow, label: a.flow.replace(/_/g, " "), when: a.when, note: a.note || "" }));
    const summary = todos.length || flows.length ? [...(todos.length ? [plural(todos.length, "to-do")] : []), ...(flows.length ? [plural(flows.length, "Flow")] : [])].join(" · ") : "No to-dos";
    return { index: i, name: s.name, summary, todos, flows };
  });
}

/** The meta line under the headline, as parts the page joins with a dot: the name, the version, who made it, then Live or Draft. */
/** Who made it, in words a person reads: "you", the person's name, or "a teammate" when the name is only an id or a placeholder (an auto name like "Member zagy5e"). */
export function ownerWords(owner: string | null, members: { id: string; name: string }[], selfId: string | null = null): string | null {
  if (!owner) return null;
  if (selfId && owner === selfId) return "you";
  const name = members.find((m) => m.id === owner)?.name?.trim() ?? "";
  if (!name || name === owner || /^member [a-z0-9]{4,}$/i.test(name) || /^per_/i.test(name)) return "a teammate";
  return name;
}

export function metaParts(o: { name: string; version: number; by: string | null; live: boolean }): string[] {
  return [o.name, `v${o.version}`, ...(o.by ? [`made by ${o.by}`] : []), o.live ? "Live" : "Draft"];
}

/** The second line of a list row. */
export function rowLine(o: { stages: number; todos: number; flows: number; usedBy: string }): string {
  return [plural(o.stages, "stage"), plural(o.todos, "to-do"), ...(o.flows ? [plural(o.flows, "Flow")] : []), o.usedBy].join(" · ");
}

/** Whether a version of this playbook is waiting for someone's yes: an approvals.pending card that names the template, or says in its words that a version of it goes live. */
export function waitingForYes(answer: unknown, template: string, name: string): boolean {
  const cards = Array.isArray((answer as { approvals?: unknown[] } | null)?.approvals) ? ((answer as { approvals: any[] }).approvals) : [];
  const word = name.trim().toLowerCase();
  return cards.some((c) => c && (c.fields?.template === template || (word && `${c.title ?? ""} ${c.body ?? ""}`.toLowerCase().includes(word) && /playbook|template|goes live|go live/i.test(`${c.title ?? ""} ${c.body ?? ""}`))));
}
