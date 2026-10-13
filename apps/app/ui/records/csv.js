// @ts-check
// CSV in, record values out (Records import): parse a CSV, say which fields an import can fill, turn a row into values, and add the rows one by one.
import { parseDay, parseNum } from "../fields/logic.js";

/** A CSV as headers and rows (objects by header). Quotes, doubled quotes, commas and line breaks inside quotes, CRLF, a byte order mark and blank lines are read; nothing else is guessed. @param {string} text */
export function parseCsv(text) {
  const s = String(text ?? "").replace(/^﻿/, "");
  /** @type {string[][]} */ const grid = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((x) => x.trim() !== "")) grid.push(row); row = []; }
    else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) grid.push(row);
  const headers = (grid[0] ?? []).map((h) => h.trim());
  return { headers, rows: grid.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))) };
}

const KINDS = new Set(["text", "url", "number", "money", "boolean", "date", "datetime", "choice", "rating", "rich_text"]);
/** The fields an import can fill: the plain kinds, never a stage, a link, a file, a sealed value, a computed or hidden field. @param {any[]} fields */
export const importableFields = (fields) => fields.filter((f) => KINDS.has(f.kind) && !f.hidden && !f.computed && !f.owned_by && !f.seal);

/** One row as the values of the fields it is matched to. Empty cells leave a field out; what does not fit is named and left out. @param {any[]} fields @param {Record<string, string>} mapping @param {Record<string, string>} row */
export function coerceRow(fields, mapping, row) {
  /** @type {Record<string, any>} */ const data = {};
  /** @type {{ field: string, problem: string }[]} */ const problems = [];
  for (const [col, name] of Object.entries(mapping)) {
    const f = fields.find((x) => x.name === name);
    const raw = String(row[col] ?? "").trim();
    if (!f || !raw) continue;
    const bad = (/** @type {string} */ problem) => problems.push({ field: name, problem });
    if (f.kind === "number" || f.kind === "rating") { const n = parseNum(raw.replace(/[$\s]/g, "")); if (n === null) bad("not a number"); else data[name] = n; }
    else if (f.kind === "money") { const n = parseNum(raw.replace(/[$\s]/g, "")); if (n === null) bad("not a number"); else data[name] = { amount: n, currency: "USD" }; }
    else if (f.kind === "boolean") { const t = raw.toLowerCase(); if (["yes", "y", "true", "1"].includes(t)) data[name] = true; else if (["no", "n", "false", "0"].includes(t)) data[name] = false; else bad("not yes or no"); }
    else if (f.kind === "date" || f.kind === "datetime") { const d = parseDay(raw) ?? (Number.isNaN(Date.parse(raw)) ? null : new Date(raw).toISOString().slice(0, 10)); if (!d) bad("not a date"); else data[name] = d; }
    else if (f.kind === "choice") { const o = (f.options ?? []).find((/** @type {string} */ x) => x.toLowerCase() === raw.toLowerCase()); if (!o) bad("not one of the options"); else data[name] = o; }
    else data[name] = raw;
  }
  return { data, problems };
}

/**
 * Add the rows one at a time through `create`. A row the preview flagged (`skip`, 1-based) is left alone; a row the box refuses is counted with its words and the import goes on. `onProgress(done, total)`
 * is told after each row so a screen can show how far it is. @param {{ rows: Record<string, string>[], mapping: Record<string, string>, fields: any[], skip: Set<number>, type: string, create: (type: string, data: Record<string, any>) => Promise<unknown>, onProgress?: (done: number, total: number) => void, skipRepeats?: boolean }} o
 */
export async function runImport(o) {
  const todo = o.rows.map((r, i) => ({ r, n: i + 1 })).filter((x) => !o.skip.has(x.n));
  let created = 0, refused = 0, repeats = 0;
  /** @type {{ row: number, why: string }[]} */ const failures = [];
  let done = 0;
  for (const { r, n } of todo) {
    const { data, problems } = coerceRow(o.fields, o.mapping, r);
    try {
      if (problems.length) throw new Error(problems.map((p) => `${p.field} ${p.problem}`).join(", "));
      await o.create(o.type, data); created++;
    } catch (e) {
      // a value that is already there (unique) is a repeat, which the person chose to skip
      if (o.skipRepeats && /** @type {any} */ (e)?.code === "unique_violation") repeats++;
      else { refused++; failures.push({ row: n, why: e instanceof Error ? e.message : "refused" }); }
    }
    o.onProgress?.(++done, todo.length);
  }
  return { created, refused, skipped: o.rows.length - todo.length + repeats, failures };
}
