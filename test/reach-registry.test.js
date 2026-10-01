// The registry's own view of reach: a tool counts as declared when its manifest entry says `reach` or
// its code limits `callers` to an explicit list or marks it internal or hook (each refuses every other kind,
// so it is not open). Anything else is open to any caller by default and must be on test/reach-allowlist.json, which
// each owner shrinks. This boots a registry (box and local) in a child process with HOME and the XDG
// folders in a temp dir, so it runs on a runner or the test box, never on a person's machine. It fails on:
// an open tool that is not listed; a listed "callers" tool whose code no longer limits callers; a listed
// "open" tool that now has a callers list (delete the line).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HUMAN_ONLY } from "../core/presence/index.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const allow = JSON.parse(fs.readFileSync(path.join(root, "test", "reach-allowlist.json"), "utf8")).tools;
function* manifests(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "testing"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* manifests(p);
    else if (e.name === "module.json") yield p;
  }
}
const explicit = new Set();
for (const top of ["core", "local", "modules", "apps"]) {
  const dir = path.join(root, top);
  if (!fs.existsSync(dir)) continue;
  for (const f of manifests(dir)) {
    let m; try { m = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
    for (const t of (m && m.does && m.does.tools) || []) if (t && typeof t === "object" && typeof t.reach === "string" && t.reach) explicit.add(t.name);
  }
}

/** One boot for both tests. */
let dumped = null;
function dump() {
  if (dumped) return dumped;
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "reach-dump.mjs")], { encoding: "utf8", timeout: 240_000, maxBuffer: 64 << 20, env: { PATH: process.env.PATH, VYRE_NO_DIALOGS: "1" } });
  assert.equal(r.status, 0, `reach-dump failed: ${String(r.stderr).slice(-400)}`);
  dumped = JSON.parse(r.stdout);
  return dumped;
}

test("every HUMAN_ONLY tool still requires a presence proof, whatever reach it declares", () => {
  // The lead's ruling: a mutating tool may be reach "anyone" because the proof is the stronger gate (and
  // module callers need it). Declaring a reach must never quietly drop the proof, so the booted registry's
  // own presence floor is asked about every tool on the list.
  const tools = new Map(dump().map(t => [t.tool, t]));
  const missing = [], noproof = [];
  for (const name of HUMAN_ONLY) {
    const t = tools.get(name);
    if (!t) { missing.push(name); continue; }
    if (t.proof !== true) noproof.push(`${t.module}: ${name} (reach ${t.reach})`);
  }
  assert.deepEqual(noproof.sort(), [], "a HUMAN_ONLY tool no longer requires a proof");
  assert.ok(missing.length <= 3, `HUMAN_ONLY names no module registers: ${missing.join(", ")}`);
});

test("every tool is declared by a reach or an explicit callers list, or is on the allowlist", () => {
  const tools = dump();
  assert.ok(tools.length > 500, `the registry booted with ${tools.length} tools`);
  const open = [], dropped = [], stale = [];
  for (const t of tools) {
    const declared = explicit.has(t.tool) || Boolean(t.callers) || t.internal || t.hook;
    const line = allow[t.tool];
    if (!declared && !line) open.push(`${t.module}: ${t.tool}`);
    if (line && !explicit.has(t.tool)) {
      if (/callers/.test(line.default) && !t.callers && !t.internal && !t.hook) dropped.push(`${t.module}: ${t.tool}`);
      if (/internal/.test(line.default) && !t.internal && !t.hook && !t.callers) dropped.push(`${t.module}: ${t.tool}`);
      if (/open/.test(line.default) && (t.callers || t.internal || t.hook)) stale.push(`${t.module}: ${t.tool}`);
    }
  }
  assert.deepEqual(open.sort(), [], "open to any caller by default: write { name, reach } in module.json or limit callers in code");
  assert.deepEqual(dropped.sort(), [], "listed as limited by callers in code, but the code no longer limits them");
  assert.deepEqual(stale.sort(), [], "listed as open, but the code now limits callers (or the tool is internal): delete the line");
});
