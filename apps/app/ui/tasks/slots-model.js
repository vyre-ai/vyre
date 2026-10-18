// A task's three slots (Assigned, Reviewer, Approver), its states, and what its review said, in plain words (slots-model.test.js). Pure; the shapes are acct6's tasks v2
// (team/0.6/DESIGN-tasks-v2.md): task.doer, task.reviewer, task.checker (the approver), task.review, task.review_note, task.review_skipped.
import { STATE_LABEL } from "../../src/store-core/tasks.js";

/** The states in the order a task moves through them, for the strip on its card. Declined and Changes requested take the place of the step they stop. @param {string} state */
export function stateStrip(state) {
  const base = ["ready", "working", "in_review", "needs_check", "done"];
  if (state === "changes_requested") return base.map((s) => (s === "in_review" ? "changes_requested" : s));
  if (state === "declined") return base.map((s) => (s === "done" ? "declined" : s));
  return base;
}

const WORDS = /** @type {Record<string, string>} */ ({ ready: "To do", working: "Doing", in_review: "In review", changes_requested: "Changes requested", needs_check: "Awaiting approval", declined: "Declined", done: "Done", stuck: "Stuck", skipped: "Skipped" });
/** The word for a state. Unknown states fall back to the older table. @param {string} state */
export const stateWord = (state) => WORDS[state] ?? /** @type {any} */ (STATE_LABEL)[state] ?? state;

/** Who holds a slot: a person or agent by name, a group or role as "the Admins". @param {any} holder @param {(kind: string, id: string) => string} nameOf */
export function holderWords(holder, nameOf) {
  if (!holder) return "";
  if (typeof holder.role === "string" && !holder.id) return `the ${holder.role}`;
  const id = String(holder.id ?? "");
  if (holder.kind === "group" || holder.kind === "role") return `the ${nameOf(holder.kind, id)}`;
  return nameOf(holder.kind, id);
}

/** The slots a task has, in order: Assigned always; Reviewer and Approver only when set (an unset one is not a step). @param {any} task @param {(kind: string, id: string) => string} nameOf @returns {{ key: "doer" | "reviewer" | "approver", label: string, who: string, kind: string }[]} */
export function slotsOf(task, nameOf) {
  const slots = [{ key: /** @type {const} */ ("doer"), label: "Assigned", holder: task.doer }, { key: /** @type {const} */ ("reviewer"), label: "Reviewer", holder: task.reviewer }, { key: /** @type {const} */ ("approver"), label: "Approver", holder: task.approver ?? task.checker }];
  return slots.filter((s) => s.key === "doer" || s.holder).map((s) => ({ key: s.key, label: s.label, who: holderWords(s.holder, nameOf), kind: s.holder && s.holder.kind ? String(s.holder.kind) : s.holder && s.holder.role ? "role" : "person" }));
}

/** What a review said: how many items hold, who checked (marked when an agent did), the note, and whether a failed item blocks. @param {any} task @param {(kind: string, id: string) => string} nameOf */
export function reviewWords(task, nameOf) {
  if (task.review_skipped) return { skipped: String(task.review_skipped.why || "No one else to check this"), items: [], line: "", note: "" };
  const r = task.review;
  if (!r) return { skipped: "", items: [], line: "", note: "" };
  const list = Array.isArray(r.checklist) ? r.checklist : [];
  const ok = list.filter((x) => x.ok === true).length;
  const by = nameOf(r.by && r.by.kind, r.by && r.by.id);
  const made = r.type === "agent" ? " (ticked by an agent)" : "";
  const line = list.length ? `${by} checked it: ${ok} of ${list.length} items hold${made}` : `${by} ${r.result === "pass" ? "passed" : "asked for changes"}${made}`;
  return { skipped: "", items: list.map((x) => ({ item: String(x.item), ok: x.ok === true, skill: String(x.skill ?? "") })), line, note: String(task.review_note ?? ""), result: r.result };
}

/** The line Now shows for a task waiting on the person: what is ready and who did what. @param {any} task @param {(kind: string, id: string) => string} nameOf @param {string} me */
export function nowLine(task, nameOf, me) {
  const doer = holderWords(task.doer, nameOf);
  const rv = task.review;
  const reviewed = rv ? `${nameOf(rv.by && rv.by.kind, rv.by && rv.by.id)} ${rv.type === "agent" ? "checked it against the checklist" : "reviewed it"}` : "";
  const who = task.state === "needs_check" ? "ready for your approval" : task.state === "in_review" ? "waiting for your review" : task.state === "changes_requested" ? "sent back with changes" : stateWord(task.state).toLowerCase();
  const done = `${doer} ${task.output && task.output.kind === "draft" ? "drafted" : "did"} it`;
  return { title: `${task.title} is ${who}`, sub: [done + (reviewed ? `, ${reviewed}` : ""), me ? "" : ""].filter(Boolean).join("") + "." };
}

/** The checklist the reviewer ticks: the items of the reviewer slot's skills, pinned on the task, as [{ skill, item }]. Empty when the slot has no skills (then a pass needs no ticks). @param {any} task */
export function checklistOf(task) {
  const raw = (task.slots && task.slots.reviewer && task.slots.reviewer.checklist) || task.reviewer_checklist || [];
  return (Array.isArray(raw) ? raw : []).filter((x) => x && typeof x.item === "string").map((x) => ({ skill: String(x.skill ?? ""), item: String(x.item) }));
}

const keyOf = (/** @type {{ skill: string, item: string }} */ x) => `${x.skill}:${x.item}`;

/**
 * What Pass and Request changes may do right now, from the ticks the reviewer made. A pass needs every item answered, and every item ticked unless the note says why a missed one is acceptable;
 * a request for changes needs a note (DESIGN-tasks-v2.md, tasks.review).
 * @param {{ skill: string, item: string }[]} list @param {Record<string, boolean | undefined>} ticks @param {string} note
 * @returns {{ pass: boolean, changes: boolean, why: string }}
 */
export function reviewGate(list, ticks, note) {
  const text = String(note || "").trim();
  const open = list.filter((x) => ticks[keyOf(x)] === undefined).length;
  const missed = list.filter((x) => ticks[keyOf(x)] === false).length;
  const changes = text.length > 0;
  if (open) return { pass: false, changes, why: `${open} item${open === 1 ? "" : "s"} still to answer.` };
  if (missed && !text) return { pass: false, changes, why: "Say why a missed item is acceptable, or ask for changes." };
  return { pass: true, changes, why: changes ? "" : "" };
}

/** The input of tasks.review for a result. @param {"pass" | "changes"} result @param {{ skill: string, item: string }[]} list @param {Record<string, boolean | undefined>} ticks @param {string} note */
export function reviewInput(result, list, ticks, note) {
  const text = String(note || "").trim();
  return { result, ...(list.length ? { checklist: list.map((x) => ({ skill: x.skill, item: x.item, ok: ticks[keyOf(x)] === true })) } : {}), ...(text ? { note: text } : {}) };
}

export { keyOf as checkKey };
