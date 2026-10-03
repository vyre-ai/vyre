// K0 loader: records the golden decisions in a child process (a throwaway home, never a real one) and
// compares a decision function against the stored set. `golden.json` is today's registry's answers; K2's
// retrofit must reproduce it cell for cell.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN_FILE = path.join(here, "golden.json");

/** Boot today's registry and record every decision. Throws with the child's stderr tail on failure. */
export function record() {
  const r = spawnSync(process.execPath, [path.join(here, "dump.mjs")], { encoding: "utf8", timeout: 480_000, maxBuffer: 256 << 20, env: { PATH: process.env.PATH, VYRE_NO_DIALOGS: "1" } });
  if (r.status !== 0) throw new Error(`golden dump failed: ${String(r.stderr).slice(-400)}`);
  return JSON.parse(r.stdout);
}

export const load = () => JSON.parse(fs.readFileSync(GOLDEN_FILE, "utf8"));

/** Cell-level differences between two golden sets: [{ role, tool, caller, world, was, now }]. */
export function diff(a, b) {
  const out = [];
  for (const role of Object.keys(a.roles)) {
    const ra = a.roles[role].rows, rb = (b.roles[role] || { rows: {} }).rows;
    for (const tool of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
      const x = ra[tool], y = rb[tool];
      if (x === y) continue;
      if (!x || !y) { out.push({ role, tool, caller: "*", world: "*", was: x ? "present" : "absent", now: y ? "present" : "absent" }); continue; }
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) {
        out.push({ role, tool, caller: a.callers[Math.floor(i / a.worlds.length)], world: a.worlds[i % a.worlds.length], was: a.legend[x[i]] || x[i], now: (b.legend[y[i]] || y[i]) });
      }
    }
    for (const tool of Object.keys(a.roles[role].emptyBad)) if (a.roles[role].emptyBad[tool] !== (b.roles[role] || { emptyBad: {} }).emptyBad[tool]) out.push({ role, tool, caller: "*", world: "empty-input", was: a.roles[role].emptyBad[tool], now: (b.roles[role].emptyBad || {})[tool] });
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--write") {
  fs.writeFileSync(GOLDEN_FILE, JSON.stringify(record()) + "\n");
  console.log("wrote", GOLDEN_FILE);
}
