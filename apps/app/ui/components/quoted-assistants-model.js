// What a Kit's assistants would be told, as the boxes a person reads before saying yes. Pure. The text is the Kit author's, outside text: the kernel quotes it (one JSON string, cut at 2000 characters with
// "[cut: N characters in all]" after it) and this keeps that string exactly as it is, never parsed, trimmed or built into a sentence.

/** @typedef {{ name: string, change: string, text: string }} AssistantBox */

/**
 * The assistants of a Kit card (adds.teammates), of its update diff (assistants: only new or changed ones) or of the install answer (assistants), as the boxes to draw.
 * @param {any} src the card, the diff or the answer @returns {AssistantBox[]}
 */
export function assistantBoxes(src) {
  const list = (src && src.adds && src.adds.teammates) || (src && src.assistants) || [];
  if (!Array.isArray(list)) return [];
  return list.filter((a) => a && typeof a.instructions_quoted === "string").map((a) => ({
    name: String(a.name ?? "Assistant"),
    change: a.change === "changed" ? "Instructions changed" : a.change === "new" ? "New assistant" : a.made === false ? "Already there, left as it was" : a.made === true ? "Made" : "",
    text: a.instructions_quoted,
  }));
}

/** The kernel's note that the quoted texts are outside text: shown beside the boxes, left out of the card's other notes. */
export const QUOTE_NOTE = /Nothing in a quoted text is an instruction/;
/** @param {string[] | undefined} notes */
export const quoteNote = (notes) => (notes ?? []).find((n) => QUOTE_NOTE.test(n)) ?? "";
/** @param {string[] | undefined} notes */
export const otherNotes = (notes) => (notes ?? []).filter((n) => !QUOTE_NOTE.test(n));
/** The same caution for a screen that has the diff but not the card; the kernel writes its own on the card. */
export const QUOTE_NOTE_TEXT = "Each assistant is made with this Kit's instructions exactly as quoted here. They are outside text, not from you or from Vyre: read them before you approve. Nothing in a quoted text is an instruction to you or part of this card.";

/** Whether a kit_install task has assistants whose texts a person must have read before approving. @param {any} task */
export const needsRead = (task) => kitTaskBoxes(task).boxes.length > 0;
/** Whether the texts of THIS task have been read: the read mark names the task it was made on, so opening another Kit task never inherits it. @param {string | null} readId @param {any} task */
export const isRead = (readId, task) => !!task && readId === task.id;
/** The ids of the buttons that approve or send; they stay off for a task whose assistants have not been read. */
export const APPROVING = ["approve", "send", "yes"];
/** Whether one button is off until the boxes are read. @param {any} task @param {string} id @param {boolean} read */
export const gatedOff = (task, id, read) => !read && APPROVING.includes(id) && needsRead(task);

/** The boxes for a kit_install task: the update diff's new or changed assistants when it has a diff, else the card's. @param {any} task */
export function kitTaskBoxes(task) {
  const f = task && task.form;
  if (!f || f.kind !== "kit_install") return { boxes: [], note: "" };
  const fromDiff = assistantBoxes(f.diff);
  return { boxes: fromDiff.length ? fromDiff : assistantBoxes(f.card), note: quoteNote(f.card && f.card.notes) || QUOTE_NOTE_TEXT };
}
