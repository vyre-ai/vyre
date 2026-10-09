#!/usr/bin/env node
// Regenerates every generated file the team never commits by hand (team/FOUNDATION.md, rule G1):
// the architecture map, the docs reference and index, the agent docs, and the golden allow and
// presence lists. The merge queue runs it after every merge; nobody else needs to.
//   node scripts/team/regen.mjs [--check]   --check exits 1 when a generated file is stale
import { execFileSync } from "node:child_process";

export const GENERATORS = [
  ["scripts/gen-architecture-map.mjs"],
  ["scripts/gen-docs-reference"],
  ["scripts/gen-agent-docs.mjs"],
  ["scripts/gen-allow.mjs"],
];

export const GENERATED = [
  /^docs\/index\.json$/,
  /^docs\/reference\//,
  /^docs\/agents\//,
  /^docs\/architecture\/map\.md$/,
  /^kernel\/golden\/allow\.json$/,
  /^kernel\/golden\/presence\.json$/,
];

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const g of GENERATORS) execFileSync(process.execPath, g, { stdio: ["ignore", "ignore", "inherit"] });
  if (process.argv.includes("--check")) {
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" })
      .split("\n").map(l => l.slice(3)).filter(f => f && GENERATED.some(re => re.test(f)));
    if (dirty.length) { console.error("stale generated files:\n  " + dirty.join("\n  ")); process.exit(1); }
  }
  console.log("regen: done");
}
