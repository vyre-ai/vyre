// @ts-check
// tool-map: the compact map of Vyre's tools for a session's system prompt, generated from the grammar and the areas (scripts/names-table.mjs), the same text for every model: how a tool is named, the
// sixteen areas with one line each and how many tools they hold, the verbs, and how to ask for one. About 350 tokens. Nothing here is hand-written per model.
import { AREAS, VERBS } from "../scripts/names-table.mjs";
import { readFileSync } from "node:fs";

/** @param {{ rows?: { area: string }[] }} [table] */
export function toolMap(table) {
  const rows = (table || JSON.parse(readFileSync(new URL("./tool-names-table.json", import.meta.url), "utf8"))).rows || [];
  /** @type {Record<string, number>} */ const n = {};
  for (const r of rows) n[r.area] = (n[r.area] || 0) + 1;
  const areas = Object.entries(AREAS).filter(([a]) => a !== "site").map(([a, line]) => `${a} (${n[a] || 0}): ${line}`).join("; ");
  return [
    "Vyre's tools are named <area>.<object>.<verb>.",
    `Areas: ${areas}; site.<host>.<object>.<verb>: operations learned on outside websites.`,
    `Verbs: ${VERBS.join(", ")}.`,
    "Ask tools_find with what you want done, and it answers with the best tools and a ready call; or name a tool you can guess and call it with tools_call: a near miss answers with the nearest names.",
  ].join("\n");
}
