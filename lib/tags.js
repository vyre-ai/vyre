// @ts-check
// Free tags on records, chats, projects and agents (R031-02). A tag is a short lower-case word; a record keeps its tags in one text field, `tags`, holding a JSON list (the Task type did this first).
// This is the one place that reads, writes and filters that text, so no module parses it its own way. Pure.
//
//   parse(text)            the tags in a stored value (a bad or empty value is none)
//   write(tags)            the stored text for a list, or "" when it is empty
//   normalize(tag)         the tag's one spelling, or null when it is not a tag
//   change(text, {add, remove})   the stored text after adding and removing
//   filter(tag)            the records filter that finds a record with the tag
//   href(tag)              the app route of the tag's page (a pinned tag filter is a sidebar view entry with this href)

export const TAG_LIMITS = Object.freeze({ tags: 20, length: 40 });
const TAG = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** @param {unknown} tag @returns {string | null} */
export function normalize(tag) {
  if (typeof tag !== "string") return null;
  const t = tag.trim().replace(/^#/, "").toLowerCase().replace(/\s+/g, "-");
  return TAG.test(t) ? t : null;
}

/** @param {unknown} text @returns {string[]} */
export function parse(text) {
  if (Array.isArray(text)) return [...new Set(text.map(normalize).filter(/** @returns {t is string} */ t => t !== null))].slice(0, TAG_LIMITS.tags);
  if (typeof text !== "string" || !text) return [];
  try { return parse(JSON.parse(text)); } catch { return []; }
}

/** @param {string[]} tags */
export const write = tags => { const l = parse(tags); return l.length ? JSON.stringify(l) : ""; };

/** @param {unknown} text @param {{ add?: string[], remove?: string[] }} change */
export function change(text, { add = [], remove = [] }) {
  const bad = [...add, ...remove].filter(t => normalize(t) === null);
  if (bad.length) throw Object.assign(new Error(`a tag is lower-case letters, numbers, dashes and underscores, up to ${TAG_LIMITS.length} characters: ${bad.join(", ")}`), { code: "bad_input" });
  const drop = new Set(remove.map(t => /** @type {string} */ (normalize(t))));
  const next = [...parse(text), ...add.map(t => /** @type {string} */ (normalize(t)))].filter(t => !drop.has(t));
  if (new Set(next).size > TAG_LIMITS.tags) throw Object.assign(new Error(`at most ${TAG_LIMITS.tags} tags on one thing`), { code: "bad_input" });
  return write(next);
}

/** The records filter for a tag. @param {string} tag */
export function filter(tag) {
  const t = normalize(tag);
  if (t === null) throw Object.assign(new Error("that is not a tag"), { code: "bad_input" });
  return { field: "tags", op: "contains", value: JSON.stringify(t) };
}

/** @param {string} tag */
export const href = tag => `/u/tags/${normalize(tag) || ""}`;
