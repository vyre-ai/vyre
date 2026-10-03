// @ts-check
// deck/ui/card-model: what a task is, to a person, as a card (pure, no DOM, so it is tested in node). task-card.js draws it.
import { actorOf, cardTitle, howSentence, needsReason, STATE_LABEL } from "./tasks.js";

/** @typedef {import("./contracts.js").Task} Task */
/** @typedef {import("./contracts.js").Actor} Actor */
/** @typedef {import("./contracts.js").RecordRow} RecordRow */
/** @typedef {import("./contracts.js").Space} Space */

/**
 * What a task is, to a person, as a card: the line it says, the sentence under it, the tags and the buttons. No DOM.
 * @param {{ task: Task, record?: RecordRow|null, recordTitle?: string, actors: Actor[], me: string, space?: Space, showSpace?: boolean, templateName?: string,
 *   fieldDef?: (key: string) => { label?: string, kind?: string }|undefined }} i
 * @returns {{ reason: "check"|"do"|"stuck"|null, title: string, why: string, lead: string, tags: { text: string, tone?: string, kind?: "record"|"space" }[],
 *   actions: { id: string, label: string, kind: "primary"|"secondary", icon?: string }[], inline?: { key: string, label: string, fieldKind: string } }}
 */
export function cardModel(i) {
  const { task, actors } = i;
  const reason = needsReason(task, i.me, actors);
  const title = cardTitle(task, reason, actors);
  const rec = i.recordTitle || "";
  const note = /** @type {any} */ (task).note;
  const madeBy = actorOf(task.madeBy, actors);
  const draft = /** @type {any} */ (task).result?.draft;
  const flow = typeof note === "string" && /^Flow:/.test(note);
  const pay = /payment/i.test(task.output?.target || "");
  /** @type {ReturnType<typeof cardModel>["actions"]} */
  let actions = [];
  let why = "";
  /** @type {ReturnType<typeof cardModel>["inline"]} */
  let inline;
  let lead = task.doer;

  if (reason === "check") {
    if (task.output.kind === "sent") {
      why = draft ? howSentence(task, { actors, templateName: i.templateName, usedNotesOf: task.how === "tailor" && /** @type {any} */ (i.record)?.values?.research ? "Research" : undefined }) : "Needs your approval to send.";
      actions = [{ id: "send", label: pay ? "Pay with Face ID" : "Send with Face ID", kind: "primary", icon: "shield" }, ...(draft ? [{ id: "edit", label: "Edit", kind: /** @type {const} */ ("secondary") }] : [{ id: "open", label: "Open", kind: /** @type {const} */ ("secondary") }])];
    } else {
      why = "Needs your check.";
      actions = [{ id: "approve", label: "Approve with Face ID", kind: "primary", icon: "shield" }, { id: "open", label: "Open", kind: "secondary" }];
    }
  } else if (reason === "stuck") {
    const s = task.stuck;
    why = [s?.reason, s?.suggestedFix].filter(Boolean).join(" ");
    actions = [{ id: "fix", label: "Fix", kind: "primary" }, { id: "reassign", label: "Reassign", kind: "secondary" }];
  } else if (reason === "do") {
    lead = madeBy && madeBy.id !== i.me ? madeBy.id : task.doer;
    const one = task.output.kind === "fields" && (task.output.fields || []).length === 1 ? task.output.fields?.[0] : null;
    const def = one ? i.fieldDef?.(one) : null;
    if (one) {
      why = `It is needed on ${rec}.`;
      inline = { key: one, label: def?.label || task.output.target || one, fieldKind: def?.kind === "date" || /date/i.test(task.output.target || "") ? "date" : "text" };
      actions = [{ id: "save", label: "Save", kind: "primary" }];
    } else if (task.output.kind === "decision" && flow) {
      why = `From the ${String(note).replace(/^Flow:\s*/, "Flow ")}. It needs your approval to send.`;
      actions = [{ id: "yes", label: "Approve with Face ID", kind: "primary", icon: "shield" }, { id: "no", label: "Decline", kind: "secondary" }];
    } else if (task.output.kind === "file") {
      why = `Needed to continue ${rec}.`;
      actions = [{ id: "file", label: "Add the file", kind: "primary" }];
    } else {
      why = `${madeBy && madeBy.id !== i.me && madeBy.kind === "person" ? `${madeBy.name} assigned this to you. ` : ""}Due with ${i.record?.stage || rec}.`;
      actions = [{ id: "done", label: "Mark done", kind: "primary" }, { id: "open", label: "Open", kind: "secondary" }];
    }
  } else {
    why = STATE_LABEL[task.state] + ".";
    actions = [{ id: "open", label: "Open", kind: "secondary" }];
  }
  /** @type {ReturnType<typeof cardModel>["tags"]} */
  const tags = [{ text: typeof note === "string" && note && !/^is /.test(note) ? note : "Stage task" }];
  if (rec) tags.push({ text: rec, kind: "record" });
  if (i.showSpace && i.space) tags.push({ text: i.space.name, kind: "space" });
  if (reason === "stuck") tags.push({ text: "Stuck", tone: "warn" });
  return { reason, title, why, lead, tags, actions, inline };
}

