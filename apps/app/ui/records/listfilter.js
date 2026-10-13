// @ts-check
// The pure half of the list header (Records): the fields a person can filter by, a filter chip in words and as a test, search, date presets, and a chip as a saved-view filter.
// A chip is { field, op, operand }: the op and operand are the field kind's own (ui/fields/logic.js KIND_LOGIC), so a new kind of field filters with no change here.
import { KIND_LOGIC, actorIdOf, fmtMoney, isEmpty, isSealedValue, isoDay, matches, normalizeKind, plain, toDate } from "../fields/logic.js";
import { sectionsOf } from "../components/groups.js";
import { isTagsField, tagWords } from "../tags/model.js";

/** @typedef {{ field: string, op: string, operand?: any }} Chip */

/** Every record has a time it was made, which is not a field of the type: it filters like a datetime. */
export const CREATED = Object.freeze({ name: "__created", label: "Created", kind: "datetime" });

const hiddenField = (/** @type {any} */ f) => f.kind === "sealed" || f.seal || f.hidden === true || f.kind === "rich_text";

/** The fields the filter menu offers, in the type's groups (the default section first), and Created with the ungrouped ones. @param {any} def @returns {{ group: string, fields: any[] }[]} */
export function filterableFields(def) {
  const fs = (def.fields || []).filter((/** @type {any} */ f) => !hiddenField(f));
  /** @type {{ group: string, fields: any[] }[]} */
  const secs = sectionsOf(def.groups || [], fs).map((s) => ({ group: s.name, fields: s.items }));
  const first = secs.find((s) => s.group === "");
  if (first) first.fields = [...first.fields, CREATED]; else secs.unshift({ group: "", fields: [CREATED] });
  return secs.filter((s) => s.fields.length);
}

const fieldOf = (/** @type {any} */ def, /** @type {string} */ name) => (name === CREATED.name ? CREATED : (def.fields || []).find((/** @type {any} */ f) => f.name === name));
const opOf = (/** @type {any} */ f, /** @type {string} */ id) => (KIND_LOGIC[normalizeKind(f.kind)] || KIND_LOGIC.text).ops.find((o) => o.id === id);

/** A chip in words: "Stage is Intake", "Owner is you". @param {any} def @param {Chip} chip @param {{ me?: string, actors?: { id: string, name: string }[], links?: Record<string, { title: string }> }} [ctx] */
export function chipWords(def, chip, ctx = {}) {
  const f = fieldOf(def, chip.field) || { label: chip.field, kind: "text" };
  if (isTagsField(f)) { const w = tagWords(chip); if (w) return w; }
  const o = opOf(f, chip.op);
  const label = o?.label ?? chip.op;
  const a = chip.operand;
  const kind = normalizeKind(f.kind);
  let say = "";
  if (o?.operand === "two") say = ` ${a?.[0]} and ${a?.[1]}`;
  else if (o?.operand === "none") say = "";
  else if (kind === "actor") say = ctx.me && actorIdOf(a) === ctx.me ? " you" : ` ${ctx.actors?.find((x) => x.id === actorIdOf(a))?.name ?? "someone"}`;
  else if (kind === "link" || kind === "ref") say = ` ${ctx.links?.[typeof a === "object" ? a?.urn : a]?.title ?? "that record"}`;
  else if (kind === "money") say = ` ${a}`;
  else say = ` ${a}`;
  return `${f.label} ${label}${say}`.trim();
}

/** Does the record hold for the chip? @param {any} def @param {Chip} chip @param {any} rec @param {any} [ctx] */
export function chipHolds(def, chip, rec, ctx = {}) {
  const f = fieldOf(def, chip.field);
  if (!f) return true;
  const v = chip.field === CREATED.name ? rec.created_at : rec.data?.[chip.field];
  const kind = normalizeKind(f.kind);
  // A range of days runs to the end of the last day.
  if ((kind === "date" || kind === "datetime") && chip.op === "between" && Array.isArray(chip.operand)) {
    const t = toDate(v)?.getTime();
    const a = toDate(chip.operand[0])?.getTime(), b = toDate(chip.operand[1])?.getTime();
    return t !== undefined && a !== undefined && b !== undefined && t >= a && t < b + 86_400_000;
  }
  return matches(f.kind, chip.op, chip.operand, v, { ...ctx, def: f });
}

/** Every word of the search is somewhere in the record's readable fields. A sealed value reads as nothing. @param {any} def @param {any} rec @param {string} q @param {any} [ctx] */
export function searchHolds(def, rec, q, ctx = {}) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = (def.fields || []).filter((/** @type {any} */ f) => !hiddenField(f)).map((/** @type {any} */ f) => {
    const v = rec.data?.[f.name];
    if (isSealedValue(v) || isEmpty(v)) return "";
    const k = normalizeKind(f.kind);
    if ((k === "link" || k === "ref") && v?.urn) return ctx.links?.[v.urn]?.title ?? "";
    if (k === "actor") return ctx.actors?.find((/** @type {any} */ x) => x.id === actorIdOf(v))?.name ?? "";
    if (k === "money") return fmtMoney(v);
    return plain(v);
  }).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The rows that hold for every chip and the search, in their order; the same array when there is nothing to narrow by. @param {any} def @param {any[]} rows @param {Chip[]} chips @param {string} q @param {any} [ctx] */
export function listRows(def, rows, chips, q, ctx = {}) {
  if (!chips.length && !q.trim()) return rows;
  return rows.filter((r) => chips.every((c) => chipHolds(def, c, r, ctx)) && searchHolds(def, r, q, ctx));
}

/** A named range of days as [first, last] ISO days: today, week (Monday to Sunday), month, last7. @param {string} id @param {number} now */
export function datePreset(id, now) {
  const d = new Date(now);
  const at = (/** @type {number} */ n) => isoDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
  if (id === "today") return [at(0), at(0)];
  if (id === "last7") return [at(-6), at(0)];
  if (id === "week") { const back = (d.getDay() + 6) % 7; return [at(-back), at(6 - back)]; }
  if (id === "month") return [isoDay(new Date(d.getFullYear(), d.getMonth(), 1)), isoDay(new Date(d.getFullYear(), d.getMonth() + 1, 0))];
  return [at(0), at(0)];
}
export const DATE_PRESETS = /** @type {[string, string][]} */ ([["today", "Today"], ["week", "This week"], ["month", "This month"], ["last7", "Last 7 days"]]);

const VIEW_OPS = /** @type {Record<string, string>} */ ({ is: "is", isnot: "isnt", gte: "atleast", lte: "atmost", before: "before", after: "after", has: "filled", hasnot: "empty", set: "filled", unset: "empty" });

/** The chips a saved view can hold, as the New view sheet's filters; `skipped` counts those it cannot (contains, between, is me, Created). @param {Chip[]} chips @param {any} [def] */
export function chipsToFilters(chips, def) {
  /** @type {{ field: string, op: string, value: string }[]} */ const filters = [];
  let skipped = 0;
  for (const c of chips) {
    const op = VIEW_OPS[c.op];
    const f = def ? fieldOf(def, c.field) : undefined;
    const kind = f ? normalizeKind(f.kind) : "";
    if (!op || c.field === CREATED.name || kind === "actor" || kind === "link" || Array.isArray(c.operand) || typeof c.operand === "object") { skipped++; continue; }
    filters.push({ field: c.field, op, value: ["filled", "empty"].includes(op) ? "" : String(c.operand ?? "") });
  }
  return { filters, skipped };
}
