// @ts-check
// tool-names: the rename table (lib/tool-names-table.json, made by scripts/names-table.mjs from the grammar in team/contracts/nomenclature.md) as a lookup. A tool has ONE canonical name, the one
// its module registered; a proposed `<area>.<object>.<verb>` name is an alias that the registry resolves to it BEFORE any gate, list or permission looks at the call, so every rule that names a
// tool (reach, one-yes, the golden sets) judges the same tool whichever spelling arrived. Nothing here ever makes a name that is already a tool's own point somewhere else.
import { readFileSync } from "node:fs";

/** @type {{ byNew: Map<string, string>, byOld: Map<string, string> } | null} */ let table = null;

function load() {
  if (table) return table;
  const byNew = new Map(), byOld = new Map();
  try {
    const rows = JSON.parse(readFileSync(new URL("./tool-names-table.json", import.meta.url), "utf8")).rows || [];
    for (const r of rows) if (r && typeof r.old === "string" && typeof r.name === "string" && r.old !== r.name) { byNew.set(r.name, r.old); byOld.set(r.old, r.name); }
  } catch { /* no table: no aliases */ }
  return (table = { byNew, byOld });
}

/** The tool a proposed name stands for, or null. @param {string} name */
export const aliasOf = (name) => load().byNew.get(String(name)) || null;
/** The proposed name of a tool, or null. @param {string} oldName */
export const proposedNameOf = (oldName) => load().byOld.get(String(oldName)) || null;
