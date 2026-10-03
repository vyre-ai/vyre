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
export function record({ gates = false, generated = false } = {}) {
  const r = spawnSync(process.execPath, [path.join(here, "dump.mjs"), ...(gates ? ["--gates"] : []), ...(generated ? ["--generated"] : [])], { encoding: "utf8", timeout: 480_000, maxBuffer: 256 << 20, env: { PATH: process.env.PATH, VYRE_NO_DIALOGS: "1" } });
  if (r.status !== 0) throw new Error(`golden dump failed: ${String(r.stderr).slice(-400)}`);
  return JSON.parse(r.stdout);
}

export const load = () => JSON.parse(fs.readFileSync(GOLDEN_FILE, "utf8"));

/**
 * Cell-level differences between two golden sets: [{ role, tool, caller, world, was, now }]. A tool that is new in `b` is not a difference (new
 * tools are recorded, not judged; `added(a, b)` lists them); a tool that vanished, or any existing cell that changed, is.
 */
export function diff(a, b) {
  const out = [];
  for (const role of Object.keys(a.roles)) {
    const ra = a.roles[role].rows, rb = (b.roles[role] || { rows: {} }).rows;
    for (const tool of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
      const x = ra[tool], y = rb[tool];
      if (x === y) continue;
      if (!x && y) continue;
      if (!x || !y) { out.push({ role, tool, caller: "*", world: "*", was: x ? "present" : "absent", now: y ? "present" : "absent" }); continue; }
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) {
        out.push({ role, tool, caller: a.callers[Math.floor(i / a.worlds.length)], world: a.worlds[i % a.worlds.length], was: a.legend[x[i]] || x[i], now: (b.legend[y[i]] || y[i]) });
      }
    }
    for (const tool of Object.keys(a.roles[role].emptyBad)) if (a.roles[role].emptyBad[tool] !== (b.roles[role] || { emptyBad: {} }).emptyBad[tool]) out.push({ role, tool, caller: "*", world: "empty-input", was: a.roles[role].emptyBad[tool], now: (b.roles[role].emptyBad || {})[tool] });
  }
  return out;
}

export const ALLOW_FILE = path.join(here, "allow.json");
const RUNS = new Set(["would run", "ran:object"]);

/**
 * Changes a refresh must not make silently: an EXISTING cell that moved from refused to run (deny to allow). A tool that was absent (`no_such_tool`) and now has a
 * decision is an addition, not a weakening. A change is allowed only when `allow` names it: `[{ tool, role?, caller?, reason }]`, committed with the refresh.
 * @param {any} a @param {any} b @param {{ tool: string, role?: string, caller?: string, reason: string }[]} [allow]
 */
export function weakened(a, b, allow = []) {
  return diff(a, b).filter(d => RUNS.has(d.now) && !RUNS.has(d.was) && d.was !== "no_such_tool" && d.was !== "absent"
    && !allow.some(x => x && typeof x.reason === "string" && x.reason && x.tool === d.tool && (!x.role || x.role === d.role) && (!x.caller || x.caller === d.caller)));
}

/** A caller that is a model, a guest or an MCP client: the ones a tool must not newly open to without a named reason. */
export const risky = (/** @type {string} */ id) => /agent/.test(id) || id.startsWith("tailnet-guest") || id.startsWith("mcp") || id.startsWith("harness");

/**
 * For every tool ADDED by a refresh (present in `b`, absent from `a`, or recorded there as `no_such_tool` for every cell), the callers it would run for:
 * `[{ role, tool, callers, risky }]`, where `risky` are the model, guest and MCP callers among them. A new tool that runs for any of those is how `runner.start` first came in
 * open; the refresh prints them and refuses unless `allow` names the tool with a reason.
 * @param {any} a @param {any} b @param {{ tool: string, role?: string, caller?: string, reason: string }[]} [allow]
 */
export function addedRuns(a, b, allow = []) {
  /** @type {{ role: string, tool: string, callers: string[], risky: string[] }[]} */ const out = [];
  for (const role of Object.keys(b.roles)) {
    const have = (a.roles[role] || { rows: {} }).rows;
    for (const tool of Object.keys(b.roles[role].rows)) {
      const was = have[tool], now = b.roles[role].rows[tool];
      const wasAbsent = !was || [...was].every(c => (a.legend[c] || c) === "no_such_tool");
      if (!wasAbsent) continue;
      const callers = new Set();
      for (let i = 0; i < now.length; i++) if (RUNS.has(b.legend[now[i]] || now[i])) callers.add(b.callers[Math.floor(i / b.worlds.length)]);
      if (!callers.size) continue;
      const list = [...callers];
      out.push({ role, tool, callers: list, risky: list.filter(risky).filter(c => !allow.some(x => x && typeof x.reason === "string" && x.reason && x.tool === tool && (!x.role || x.role === role) && (!x.caller || x.caller === c))) });
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--write") {
  const next = record();
  let allow = [];
  try { allow = JSON.parse(fs.readFileSync(ALLOW_FILE, "utf8")); } catch { /* none */ }
  const bad = weakened(load(), next, allow);
  if (bad.length) {
    console.error(`refusing to refresh: ${bad.length} cell(s) moved from refused to run (deny to allow). Name each in kernel/golden/allow.json with a reason, commit it with the refresh, and run again:`);
    for (const d of bad.slice(0, 30)) console.error(`  ${d.role} ${d.tool} ${d.caller}/${d.world}: ${d.was} -> ${d.now}`);
    process.exit(1);
  }
  const addedAll = addedRuns(load(), next, allow);
  for (const d of addedAll) console.log(`added ${d.role} ${d.tool}: runs for ${d.callers.join(", ")}`);
  const open = addedAll.filter(d => d.risky.length);
  if (open.length) {
    console.error(`refusing to refresh: ${open.length} added tool(s) run for a model, guest or MCP caller. Name each in kernel/golden/allow.json with a reason, commit it with the refresh, and run again:`);
    for (const d of open.slice(0, 30)) console.error(`  ${d.role} ${d.tool}: ${d.risky.join(", ")}`);
    process.exit(1);
  }
  fs.writeFileSync(GOLDEN_FILE, JSON.stringify(next) + "\n");
  console.log("wrote", GOLDEN_FILE);
}

/** Tools present in `b` and not in `a`, per role: what a refresh of the stored golden set would add. */
export function added(a, b) {
  const out = {};
  for (const role of Object.keys(b.roles)) { const have = (a.roles[role] || { rows: {} }).rows; out[role] = Object.keys(b.roles[role].rows).filter(t => !(t in have)).sort(); }
  return out;
}
