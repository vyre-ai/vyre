// @ts-check
// Free tags in the app (R031-02): the pure half. The engine keeps a record's tags in one text field named `tags` (lib/tags.js reads and writes it); everything here is a decision about that
// text: which fields are tag fields, the tags a set of rows carries, what to suggest, the list filter for a tag and what a filter chip means. Pure.
import { change, filter, normalize, parse, write } from "../../../../lib/tags.js";

/** Is this field the free-tags field of a type? @param {{ name?: string, kind?: string } | null | undefined} f */
export const isTagsField = (f) => !!f && f.name === "tags" && (f.kind === "text" || f.kind === undefined || f.kind === "tags");

/** The tags in a stored value. @param {unknown} v */
export const tagsOf = (v) => parse(v);

/** The stored text after adding one tag (a bad word throws the engine's own sentence). @param {unknown} text @param {string} tag */
export const withTag = (text, tag) => change(text, { add: [tag] });

/** The stored text after taking one tag off. @param {unknown} text @param {string} tag */
export const withoutTag = (text, tag) => change(text, { remove: [tag] });

/** The stored text for a list of tags. @param {string[]} tags */
export const stored = (tags) => write(tags);

/** Every tag the rows carry with how many things have it, the most used first, then by name. @param {{ data?: Record<string, unknown> }[]} rows @returns {{ tag: string, count: number }[]} */
export function tally(rows) {
  /** @type {Map<string, number>} */
  const n = new Map();
  for (const r of rows) for (const t of tagsOf(r?.data?.tags)) n.set(t, (n.get(t) ?? 0) + 1);
  return [...n].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Tags worth offering while one is typed: the Space's tags not already on this thing, those starting with the typed word first, at most `max`. @param {string[]} known @param {string[]} have @param {string} typed @param {number} [max] */
export function suggest(known, have, typed, max = 8) {
  const w = (normalize(typed) ?? typed.trim().toLowerCase().replace(/^#/, "")).toLowerCase();
  const pool = known.filter((t) => !have.includes(t) && (!w || t.includes(w)));
  return [...pool.filter((t) => t.startsWith(w)), ...pool.filter((t) => !t.startsWith(w))].slice(0, max);
}

/** The list-filter chip for a tag: the engine's own filter (a whole tag, never a part of one). @param {string} tag @returns {{ field: string, op: string, operand: string }} */
export function tagChip(tag) {
  const f = filter(tag);
  return { field: f.field, op: f.op, operand: f.value };
}

/** The tag a filter chip stands for, or null when it is some other filter. @param {{ field: string, op: string, operand?: unknown }} c @returns {string | null} */
export function tagOfChip(c) {
  if (c.field !== "tags" || c.op !== "contains" || typeof c.operand !== "string") return null;
  try { const t = JSON.parse(c.operand); return typeof t === "string" ? normalize(t) : null; } catch { return null; }
}

/** A filter chip in words: tags read "Tagged #trust", never the quotes of the engine's filter. @param {{ field: string, op: string, operand?: unknown }} c */
export function tagWords(c) {
  const t = tagOfChip(c);
  return t ? `Tagged #${t}` : null;
}
