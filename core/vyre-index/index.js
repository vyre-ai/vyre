// @ts-check
// vyre: one read tool, vyre.core, a live index of Vyre's modules for an agent that has only the small always-loaded tool core (harness/mcp/core-tools.js).
//
//   vyre.core { query?, module? }    { modules: [{ name, group, folder, runs_on, does, state, version }], total }
//
// Each row joins two sources that already exist: the architecture map's generated module table (docs/architecture/map.md, written from every module.json by
// scripts/gen-architecture-map.mjs and kept true by test/architecture-map.test.js) and the daemon's own module list (ctx.modules.status(): whether the module is running here now). A module the
// daemon runs that the map does not know is still listed, with state only. Ask tools_find for the tools of one module; read docs.read architecture/map.md for how they fit together.

import fs from "node:fs";
import path from "node:path";
import { PKG_ROOT } from "../../kernel/devbuild.js";

/** The rows of the map's module table, with the heading each sits under. @param {string} page */
export function parseMap(page) {
  const block = page.split("<!-- map:modules:start -->")[1];
  const text = block ? block.split("<!-- map:modules:end -->")[0] : "";
  /** @type {{ name: string, group: string, folder: string, runs_on: string, does: string }[]} */ const rows = [];
  let group = "";
  for (const line of text.split("\n")) {
    const h = line.match(/^###\s+(.+)$/);
    if (h) { group = h[1].trim(); continue; }
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*$/);
    if (m) rows.push({ name: m[1], group, folder: m[2], runs_on: m[3], does: m[4] });
  }
  return rows;
}

/** Test seam: the Vyre package root per home. @type {Map<string, { pkg: string }>} */
export const seams = new Map();

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const home = String((ctx.paths && ctx.paths.root) || "");
    const pkg = (seams.get(home) || { pkg: PKG_ROOT }).pkg;
    ctx.tool("vyre.core", {
      effect: "read",
      description: "Vyre's modules, live, each with name, group, folder, runs_on, does and state (running, stopped, failed). For a module's tools ask tools_find.",
      input: { type: "object", properties: { query: { type: "string", maxLength: 100, description: "Keeps the modules whose name or purpose has these words." }, module: { type: "string", maxLength: 64, description: "Returns just this module." } } },
      run: async (/** @type {any} */ input) => {
        let mapped = [];
        try { mapped = parseMap(fs.readFileSync(path.join(pkg, "docs", "architecture", "map.md"), "utf8")); } catch { /* no map in this build: the live list alone */ }
        const live = new Map(ctx.modules.status().filter((/** @type {any} */ m) => typeof m.name === "string").map((/** @type {any} */ m) => [m.name, m]));
        const by = new Map(mapped.map((r) => [r.name, r]));
        const names = [...new Set([...mapped.map((r) => r.name), ...live.keys()])];
        let rows = names.map((n) => {
          const r = by.get(n), l = /** @type {any} */ (live.get(n));
          return { name: n, ...(r ? { group: r.group, folder: r.folder, runs_on: r.runs_on, does: r.does } : {}), state: l ? l.state : "not here", ...(l && l.version ? { version: l.version } : {}) };
        });
        if (input.module) rows = rows.filter((r) => r.name === input.module);
        if (input.query) {
          const want = String(input.query).toLowerCase().split(/\s+/).filter(Boolean);
          rows = rows.filter((r) => want.every((w) => `${r.name} ${/** @type {any} */ (r).does || ""}`.toLowerCase().includes(w)));
        }
        return { modules: rows, total: rows.length };
      },
    });
    return { async stop() {} };
  },
};
