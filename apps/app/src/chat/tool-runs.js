// @ts-check
// Tool steps as collapsed runs (CHAT-PARITY, rc.2): three or more steps in a row with nothing between them are one line, "Ran 4 steps", that opens to the steps. A step a teammate took (it has `via`, nested under a
// hand-off) is never folded: it belongs to its hand-off. A run grows as steps arrive; its key is its first step's, so it holds still. Pure.

/** @typedef {{ type: "item", key: string, kind: string, keys?: string[] }} Row */

/**
 * @param {readonly Row[]} rows @param {(key: string) => any} itemOf the item behind a row key @param {number} [min] the fewest steps that fold
 * @returns {Row[]}
 */
export function groupToolRuns(rows, itemOf, min = 3) {
  /** @type {Row[]} */ const out = [];
  /** @type {Row[]} */ let run = [];
  const flush = () => {
    if (run.length >= min) out.push({ type: "item", key: `r:${run[0].key}`, kind: "toolrun", keys: run.map((r) => r.key) });
    else out.push(...run);
    run = [];
  };
  for (const r of rows) {
    const it = r.kind === "tool" ? itemOf(r.key) : null;
    if (r.kind === "tool" && it && !it.via) { run.push(r); continue; }
    flush();
    out.push(r);
  }
  flush();
  return out;
}

/**
 * The words on a run's line. Done: "Ran 4 steps" (and ", 1 failed"); while a step is running: what it is doing and how many steps so far.
 * @param {any[]} items the run's steps, in order
 * @returns {{ title: string, running: boolean, failed: number }}
 */
export function runWords(items) {
  const n = items.length;
  const failed = items.filter((i) => i.status === "failed").length;
  const live = [...items].reverse().find((i) => i.status === "running");
  const steps = `${n} step${n === 1 ? "" : "s"}`;
  if (live) return { title: `${String(live.summary || "").trim() || "Working"} · ${steps} so far`, running: true, failed };
  return { title: `Ran ${steps}${failed ? `, ${failed} failed` : ""}`, running: false, failed };
}
