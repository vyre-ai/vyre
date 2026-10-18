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

/** The quick actions a record offers under its name, in order. */
export const QUICK = /** @type {{ key: "call" | "meeting" | "note", label: string, ask: string }[]} */ ([
  { key: "call", label: "Log a call", ask: "What was said?" },
  { key: "meeting", label: "Log a meeting", ask: "What came out of it?" },
  { key: "note", label: "Add a note", ask: "Write the note" },
]);
