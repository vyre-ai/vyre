// @ts-check
// A record's ID (the `ref` field: PER-0001) is made by Vyre when the record is made and never changes (core/records-tools/ref.js mints it; records.create refuses one given and
// records.update refuses a change). The record page shows it once, in the header, faint and monospace, with a copy control. No create form, inline editor, import or field editor offers it as an input.
// A field the owner added and called "ID" or "Case number" is an ordinary field: only `ref` is the record's identity.

/** The name of the ID field on every type that has one. */
export const ID_FIELD = "ref";

/** True for the field that is the record's ID. @param {{ name?: unknown } | null | undefined} f */
export const isRecordIdField = (f) => Boolean(f && f.name === ID_FIELD);

/**
 * True for a field Vyre keeps and a person never edits by hand: the record's ID, a read-only field, a computed one, one the kernel owns (a task's status), and a deal's weighted value
 * (worked out from amount and probability, also where an older definition lost its read-only mark). @param {any} f
 */
export const isKeptField = (f) => Boolean(f && (isRecordIdField(f) || f.read_only === true || f.computed !== undefined || f.owned_by || f.name === "weighted_value"));

/** What a kept field's line says, the ID's own words for the ID. @param {any} f */
export const keptNote = (f) => (isRecordIdField(f) ? ID_NOTE : "Worked out by Vyre. It cannot be changed by hand.");

/** What the ID row in a type's fields says. The record page shows the ID in the header and does not repeat this. */
export const ID_NOTE = "Made by Vyre with each record. It cannot be changed.";

/** The record's ID as text to show and copy, or "" before it has one. @param {{ data?: Record<string, unknown> } | null | undefined} rec */
export const recordIdOf = (rec) => {
  const v = rec && rec.data ? rec.data[ID_FIELD] : undefined;
  return typeof v === "string" ? v.trim() : "";
};
