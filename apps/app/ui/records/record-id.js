// @ts-check
// A record's ID (the `ref` field: PER-0001) is made by Vyre when the record is made and never changes (core/records-tools/ref.js mints it; records.create refuses one given and
// records.update refuses a change). This names that field, so no create form, inline editor, import or field editor offers it as an input: it shows as a quiet line that can be copied.
// A field the owner added and called "ID" or "Case number" is an ordinary field: only `ref` is the record's identity.

/** The name of the ID field on every type that has one. */
export const ID_FIELD = "ref";

/** True for the field that is the record's ID. @param {{ name?: unknown } | null | undefined} f */
export const isRecordIdField = (f) => Boolean(f && f.name === ID_FIELD);

/** What the ID line and the ID row in a type's fields say. */
export const ID_NOTE = "Made by Vyre with each record. It cannot be changed.";

/** The record's ID as text to show and copy, or "" before it has one. @param {{ data?: Record<string, unknown> } | null | undefined} rec */
export const recordIdOf = (rec) => {
  const v = rec && rec.data ? rec.data[ID_FIELD] : undefined;
  return typeof v === "string" ? v.trim() : "";
};
