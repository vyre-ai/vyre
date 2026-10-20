// @ts-check
// The ID a record is given when it is made: a short readable counter with a prefix for its type (PER-0001, ORG-0001, TSK-0001), shown as the type's first field, never changed afterwards. Pure helpers; the tool that
// makes a record (records.create) mints it for a type that has a `ref` field and refuses a change to it (records.update).

/** The prefix of each starting type; any other type uses its first three letters. */
export const REF_PREFIX = Object.freeze({ contact: "PER", organization: "ORG", task: "TSK", note: "NOT" });

/** @param {string} type */
export const refPrefix = (type) => /** @type {Record<string, string>} */ (REF_PREFIX)[type] || (String(type).replace(/[^a-z0-9]/gi, "").slice(0, 3).toUpperCase() || "REC");

/** The number inside an ID of this prefix, or 0. @param {string} prefix @param {unknown} value */
export const refNumber = (prefix, value) => { const m = new RegExp(`^${prefix}-(\\d+)$`).exec(String(value ?? "")); return m ? Number(m[1]) : 0; };

/** @param {string} prefix @param {number} n */
export const formatRef = (prefix, n) => `${prefix}-${String(n).padStart(4, "0")}`;

/** The next ID after the highest one among the values given (any order, any junk). @param {string} type @param {unknown[]} values */
export function nextRef(type, values) {
  const prefix = refPrefix(type);
  return formatRef(prefix, values.reduce((/** @type {number} */ m, v) => Math.max(m, refNumber(prefix, v)), 0) + 1);
}

/** Whether a failed write is the ID already being taken: the store's own unique-violation code, on the ID field (or on none named). Never judged by its words, and its text is never shown to anyone. @param {unknown} e */
export const isClash = (e) => Boolean(e) && /** @type {any} */ (e).code === "unique_violation" && (/** @type {any} */ (e).field === undefined || /** @type {any} */ (e).field === "ref");

/**
 * How far to move on after a clash, so a caller who cannot see the records that hold the higher IDs still finds a free one: one at a time at first, then ten, then a hundred, then a thousand. IDs need to be unique, not dense.
 * @param {number} attempt 1 for the first clash
 */
export const clashStep = (attempt) => (attempt <= 3 ? 1 : attempt <= 6 ? 10 : attempt <= 9 ? 100 : 1000);

/** How many tries a create gets before it says so, in words that name no record. */
export const MAX_MINT_TRIES = 10;

/**
 * Make a record with the first free ID from `start` on: `create` is given an ID and either makes the record or fails; a failure that is the ID being taken moves on (clashStep), any other failure is passed up as it is.
 * The words of a clash are never kept or shown. Returns what `create` returned and the number used.
 * @template T @param {{ type: string, start: number, create: (ref: string) => Promise<T> }} o @returns {Promise<{ made: T, n: number }>}
 */
export async function mintRef({ type, start, create }) {
  const prefix = refPrefix(type);
  let n = start;
  for (let tries = 1; tries <= MAX_MINT_TRIES; tries++) {
    try { return { made: await create(formatRef(prefix, n)), n }; }
    catch (e) { if (!isClash(e)) throw e; n += clashStep(tries); }
  }
  throw Object.assign(new Error("This record could not be given its ID just now. Try again."), { code: "unavailable" });
}

/** What a caller is told when a create names the record's ID: Vyre makes it. */
export const ID_GIVEN = "A record's ID is made by Vyre when the record is made. Leave the ID out and the record gets the next one.";
/** What a caller is told when a change names the record's ID. */
export const ID_CHANGED = "A record's ID is made when the record is made and never changes.";

const blank = (/** @type {unknown} */ v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
const names = (/** @type {any} */ o, /** @type {string} */ k) => Boolean(o) && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
/** The keys that are a record's identity: the store's own id and address on every type, and the ID field on a type that has one. @param {boolean} hasRefField */
const identity = (hasRefField) => ["id", "urn", ...(hasRefField ? ["ref"] : [])];

/**
 * The words a create is refused with when its data names the record's identity, or null. The store's id (`id`, `urn`) is never the caller's on any type; the ID field (`ref`) is not
 * the caller's on a type that has one. An empty value counts as left out, so a form that sends every field, blanks included, still makes the record.
 * @param {any} data @param {boolean} hasRefField
 */
export function idOnCreate(data, hasRefField) {
  for (const k of identity(hasRefField)) if (names(data, k) && !blank(data[k])) return ID_GIVEN;
  return null;
}

/** The data with the identity keys a create left empty taken out, so the store never sees them. @param {any} data @param {boolean} hasRefField */
export function withoutBlankIds(data, hasRefField) {
  if (!data || typeof data !== "object") return data;
  const out = { ...data };
  for (const k of identity(hasRefField)) if (names(out, k) && blank(out[k])) delete out[k];
  return out;
}

/**
 * The words a change is refused with when it sets a field Vyre keeps (a read-only field such as a deal's weighted value, which the tools work out from amount and probability), or
 * null. The kernel itself refuses a computed field and one it owns; a read-only field is refused here. @param {any[]} fields @param {any} patch
 */
export function keptOnUpdate(fields, patch) {
  if (!patch || typeof patch !== "object") return null;
  for (const f of fields || []) {
    if (!f || f.name === "ref" || !names(patch, f.name)) continue;
    if (f.read_only === true || f.name === "weighted_value") return `${f.label || f.name} is worked out by Vyre, so it cannot be changed by hand. Change the fields it comes from instead.`;
  }
  return null;
}

/** The words a change is refused with when it names the record's identity (any value, an empty one too: clearing the ID is changing it), or null. @param {any} patch @param {boolean} hasRefField */
export function idOnUpdate(patch, hasRefField) {
  for (const k of identity(hasRefField)) if (names(patch, k)) return ID_CHANGED;
  return null;
}
