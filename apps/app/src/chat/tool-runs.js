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
 * A tool's line in a person's words: the tool's own name ("mcp__vyre-chrome__chrome_screenshot", "work.chat.list") never shows. A screenshot reads "Screenshot of <page>" when the call names a page, else "Screenshot".
 * @param {unknown} text the step's summary, or its tool name when it has no summary @param {unknown} [tool] the tool's name
 */
export function plainToolWords(text, tool) {
  const t = String(text ?? "").trim() || String(tool ?? "").trim();
  const m = /^mcp__(.+?)__([A-Za-z0-9_]+)(?:\s+\w+:\s*(.*))?$/.exec(t) || /^(work|records|tasks|flows|comms|mail|calendar|projects|stream|threads|agents|artifacts|files|vault)[._]([a-z0-9_.-]+)(?:\s+\w+:\s*(.*))?$/.exec(t);
  if (!m) return t || "Working";
  const name = String(m[2]).replace(/^[a-z]+_(?=screenshot)/, "").replace(/[_.-]+/g, " ").trim();
  const arg = m[3] ? String(m[3]).trim() : "";
  if (/screenshot|screen ?capture/i.test(name)) { let page = ""; if (arg) { try { page = new URL(arg).host; } catch { page = arg.slice(0, 60); } } return page ? `Screenshot of ${page}` : "Screenshot"; }
  const words = name ? name[0].toUpperCase() + name.slice(1) : "Working";
  return arg ? `${words}: ${arg.slice(0, 60)}` : words;
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
  if (live) return { title: `${live.summary || live.tool ? plainToolWords(live.summary, live.tool) : "Working"} · ${steps} so far`, running: true, failed };
  return { title: `Ran ${steps}${failed ? `, ${failed} failed` : ""}`, running: false, failed };
}
