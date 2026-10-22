// @ts-check
// A record's History: one list of what happened to it and who did it, a person or an agent, with a row of filters and an Undo on what can be undone. The list is records.history; this is the pure half.

/** @typedef {{ id: string, kind: string, actor: { kind: string, id: string, name: string }, text: string, at: number, file?: string, undo?: boolean }} Item */

export const HISTORY_FILTERS = /** @type {[string, string][]} */ ([["all", "All"], ["chat", "Chats"], ["email", "Emails"], ["task", "Tasks"], ["flow", "Flow runs"], ["file", "Files"], ["notes", "Notes and calls"], ["agent", "Agent actions"]]);

/** The items one filter keeps, newest first. "Notes and calls" is notes, calls and meetings; "Agent actions" is whatever an agent did, of any kind. @param {Item[]} items @param {string} key */
export function filterHistory(items, key) {
  const keep = (/** @type {Item} */ i) => key === "all" || (key === "agent" ? i.actor?.kind === "agent" : key === "notes" ? ["note", "call", "meeting"].includes(i.kind) : i.kind === key);
  return (Array.isArray(items) ? items : []).filter(keep).sort((a, b) => b.at - a.at);
}

/** Who did it, as the row says it: "You", or the name; an agent keeps its name and is tagged by the screen. @param {Item["actor"]} actor @param {string | undefined} me */
export const actorWords = (actor, me) => (actor && me && actor.id === me ? "You" : actor?.name || "Someone");

/** The quick actions a record offers under its name, in order. The button says the short word; the sheet keeps the longer title. */
export const QUICK = /** @type {{ key: "call" | "meeting" | "note", label: string, ask: string, sheet: string, icon: "phone" | "cal" | "edit" }[]} */ ([
  { key: "call", label: "Call", ask: "What was said?", sheet: "Log a call", icon: "phone" },
  { key: "meeting", label: "Meeting", ask: "What came out of it?", sheet: "Log a meeting", icon: "cal" },
  { key: "note", label: "Note", ask: "Write the note", sheet: "Add a note", icon: "edit" },
]);

/** The filters worth showing for these items: All, and each kind that has something. Agent actions and Notes and calls show only when there is one. Tasks, Flow runs and Files are not in records.history, so they show only if a box ever sends them. @param {Item[]} items */
export function filtersFor(items) {
  const list = Array.isArray(items) ? items : [];
  return HISTORY_FILTERS.filter(([k]) => k === "all" || list.some((i) => (k === "agent" ? i.actor?.kind === "agent" : k === "notes" ? ["note", "call", "meeting"].includes(i.kind) : i.kind === k)));
}
