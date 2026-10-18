// @ts-check
// Who reads a note. A note is the planner's Note type, private to the person who wrote it until they share it: with the record it is about (everyone who may read that record) or with the Space (every member).
// The planner applies this wherever it lists or opens a note for a person; the raw Records route to the type stays the owner's, an admin's and the planner's own.

export const NOTE_VISIBILITY = ["private", "record", "space"];

/** A visibility value, cleaned; anything else is private. @param {any} v */
export const visibilityOf = (v) => (NOTE_VISIBILITY.includes(v) ? v : "private");

/** The address of the record a note is about, or null when it is not one. @param {any} v */
export function aboutOf(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return /^vyre:\/\/[^/\s]+\/(?!note\/)[a-z][a-z0-9-]*\/[0-9a-f-]{36}$/.test(s) ? s : null;   // a note is about a record, not another note
}

/**
 * May this person read this note. `mayReadRecord` answers whether they can read the record it is about (the kernel decides, on their own chain). A person with no identity (an internal call) reads all.
 * @param {{ kind?: string, by?: string | null, visibility?: string, record?: string | null }} note @param {string | null} person @param {(urn: string) => Promise<boolean>} mayReadRecord
 */
export async function seesNote(note, person, mayReadRecord) {
  // a note with no writer on it (carried over from the old planner) is not judged here: the planner shows it as it always did
  if (note.kind !== "note" || !person || !note.by || note.by === person) return true;
  const v = visibilityOf(note.visibility);
  if (v === "space") return true;
  if (v === "record") { const about = aboutOf(note.record); return Boolean(about) && await mayReadRecord(/** @type {string} */ (about)); }
  return false;
}
