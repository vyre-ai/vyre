// @ts-check
// Tags as saved views on the Records list: each tag the rows carry is a chip, and picking it filters by that tag.
import { tagChip, tagOfChip, tally } from "../../ui/tags/model.js";

/** @param {{ data?: Record<string, unknown> }[]} rows @returns {{ tag: string, label: string, chip: { field: string, op: string, operand: string } }[]} */
export function tagViews(rows) {
  return tally(rows).map(({ tag }) => ({ tag, label: `#${tag}`, chip: tagChip(tag) }));
}

/** Pick a tag on, or off when it is already the filter. Other chips stay. @param {{ field: string, op: string, operand?: unknown }[]} chips @param {string} tag */
export function toggleTag(chips, tag) {
  const on = chips.some((c) => tagOfChip(c) === tag);
  const rest = chips.filter((c) => tagOfChip(c) !== tag);
  return on ? rest : [...rest, tagChip(tag)];
}
