// @ts-check
// One note as the sheet shows it, from what planner.get answers ({ item } or the item itself): its words, who may read it, and whether the person may change it. A note is changed only by its writer; a note that
// was shared with the person is read-only for them (the box refuses, and this does not offer it).

/** @param {any} answer */
export function noteOf(answer) {
  const n = answer && typeof answer === "object" ? (answer.item && typeof answer.item === "object" ? answer.item : answer) : null;
  if (!n || !n.id) return null;
  return { id: String(n.id), title: String(n.title ?? ""), body: String(n.body ?? ""), visibility: String(n.visibility ?? "private"), record: typeof n.record === "string" ? n.record : n.record && n.record.urn ? String(n.record.urn) : undefined, owner: n.owner ? String(n.owner) : undefined };
}

/** Whether this person wrote the note: its owner is "person:<id>" and `me` is the id, with or without the prefix. @param {{ owner?: string }} note @param {string | undefined} me */
export const isMine = (note, me) => !!me && !!note.owner && note.owner.replace(/^person:/, "") === String(me).replace(/^person:/, "");

/** The planner.update input for an edit: only what changed, or null when nothing did. @param {{ id: string, title: string, body: string }} was @param {{ title: string, body: string }} now */
export function editInput(was, now) {
  const out = /** @type {Record<string, any>} */ ({ item: was.id });
  if (now.title !== was.title) out.title = now.title;
  if (now.body !== was.body) out.body = now.body;
  return Object.keys(out).length > 1 ? out : null;
}
