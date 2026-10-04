import "../scripts/mac-test-guard.mjs";
// Lead's ruling on MH-1: `mcp` and `harness` in any form are model callers and never the person. A tool body that lets a model label through as "the person" (a list holding a surface and "mcp" asked
// with includes(callerKind(...)), or an is-the-person regex naming mcp) hands a model's shell the person's authority, because asTaken labels every model shell `mcp`. This scan fails on a new one.
// A callers list that ADMITS a model is not this (the registry's default and each body's own checks decide what an admitted model may do).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Exceptions by file with the number of lines each may hold; only shrinks. The standalone Chrome runtime has no daemon and no other model: it says so with meta.standalone. */
const FROZEN = {};
const PERSON_WITH_MCP = [
  /\[[^\]]*"(?:cli|local|deck|capsule)"[^\]]*"mcp"[^\]]*\]\s*\.includes\(\s*callerKind/,
  /\[\s*\.\.\.[A-Z_]*PEOPLE[A-Z_]*\s*,\s*"mcp"\s*\]\s*\.includes\(/,
  /\(\s*cli\s*\|\s*local\s*\|[^)]*\bmcp\b[^)]*\)/,
];
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "image") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.m?js$/.test(e.name) && !/\.test\.m?js$/.test(e.name)) out.push(p);
  }
}
test("no tool body decides a model label is the person", () => {
  const files = [];
  for (const top of ["core", "local", "modules", "lib", "kernel"]) { const d = path.join(ROOT, top); if (fs.existsSync(d)) walk(d, files); }
  const found = {};
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (/^\s*(\/\/|\*)/.test(line)) continue;
      if (PERSON_WITH_MCP.some(re => re.test(line))) found[rel] = (found[rel] || 0) + 1;
    }
  }
  const over = Object.entries(found).filter(([f, n]) => n > (FROZEN[f] || 0)).map(([f, n]) => `${f}: ${n}`);
  assert.deepEqual(over, [], "a model label is not the person: key it as its own caller with no grant, or admit it by a callers list and let the body scope it");
});
