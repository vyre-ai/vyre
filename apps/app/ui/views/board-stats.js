// @ts-check
// A board's totals from records.stats, so a column says how many and how much it holds across every record, not only the ones the screen has loaded. Same words as columnNote and forecastLine in logic.js, which stay
// the answer for a box without the tool.

import { fmtMoney, isoDay } from "../fields/logic.js";
import { stageField } from "./logic.js";

/** The number field a board adds up, as records.stats can sum it: amount (or value, total, fee). @param {any} def */
export const sumName = (def) => ((def.fields || []).find((/** @type {any} */ f) => f.kind === "number" && ["amount", "value", "total", "fee"].includes(f.name)) || {}).name;

const OPEN = (/** @type {unknown} */ k) => !["won", "lost"].includes(String(k ?? "").toLowerCase());

/** What a column wears beside its name from a stats group: "3 · $31,000". @param {any} def @param {{ count?: number } & Record<string, any> | undefined} group */
export function noteFromStats(def, group) {
  if (!group) return undefined;
  const n = String(group.count ?? 0);
  const m = sumName(def);
  const sum = m ? Number(group[m] || 0) : 0;
  return sum ? `${n} · ${fmtMoney(sum)}` : n;
}

/** The first and last day (ISO, the last one exclusive) of the month `now` is in. @param {number} now */
export function monthWindow(now) {
  const d = new Date(now), y = d.getFullYear(), m = d.getMonth();
  return { from: isoDay(new Date(y, m, 1)), to: isoDay(new Date(y, m + 1, 1)) };
}

/** The records.list filter for deals closing in the month of `now`. @param {number} now */
export function closingFilter(now) {
  const w = monthWindow(now);
  return { and: [{ field: "close_date", op: "gte", value: w.from }, { field: "close_date", op: "lt", value: w.to }] };
}

/** "$X weighted · $Y closing this month" from two stats answers (all deals, and those closing this month); "" for a type without the fields. @param {any} def @param {{ groups?: any[] } | undefined} all @param {{ groups?: any[] } | undefined} closing */
export function forecastFromStats(def, all, closing) {
  const has = (/** @type {string} */ n) => (def.fields || []).some((/** @type {any} */ f) => f.name === n);
  const m = sumName(def);
  if (!m || !stageField(def) || !has("weighted_value") || !has("close_date") || !all || !closing) return "";
  const open = (/** @type {any} */ s) => (s.groups || []).filter((/** @type {any} */ g) => OPEN(g.key));
  const weighted = open(all).reduce((/** @type {number} */ a, /** @type {any} */ g) => a + Number(g.weighted_value || 0), 0);
  const closes = open(closing).reduce((/** @type {number} */ a, /** @type {any} */ g) => a + Number(g[m] || 0), 0);
  return `${fmtMoney(weighted)} weighted · ${fmtMoney(closes)} closing this month`;
}
