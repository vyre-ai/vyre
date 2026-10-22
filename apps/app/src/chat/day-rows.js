// @ts-check
// Day separators in the transcript. A centred caption appears only when the next message is on a later day than the one before it. A row with no time sits where it is and does not start a day. Pure.

/** @typedef {{ type?: string, key: string, kind: string, text?: string, keys?: string[] }} DayRow */

/**
 * @param {readonly DayRow[]} rows
 * @param {(row: DayRow) => number | undefined} atOf time of the row, in ms, or undefined when it has none
 * @param {(ms: number) => string} labelOf the caption for that day
 * @param {(a: number, b: number) => boolean} same true when both times fall on one day
 * @returns {DayRow[]}
 */
export function withDayRows(rows, atOf, labelOf, same) {
  /** @type {DayRow[]} */ const out = [];
  /** @type {number | undefined} */ let last;
  for (const r of rows) {
    const at = atOf(r);
    if (typeof at === "number" && at > 0) {
      if (last !== undefined && !same(last, at)) out.push({ type: "item", key: `d:${r.key}`, kind: "day", text: labelOf(at) });
      last = at;
    }
    out.push(r);
  }
  return out;
}
