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
const roleList = JSON.parse(fs.readFileSync(path.join(root, "test", "reach-roles.json"), "utf8")).tools;
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

/** One boot for every test here. */
let dumped = null;
function dump() {
  if (dumped) return dumped;
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "reach-dump.mjs")], { encoding: "utf8", timeout: 240_000, maxBuffer: 64 << 20, env: { PATH: process.env.PATH, VYRE_NO_DIALOGS: "1" } });
  assert.equal(r.status, 0, `reach-dump failed: ${String(r.stderr).slice(-400)}`);
  dumped = JSON.parse(r.stdout);
  return dumped;
}

const MODEL = ["mcp", "harness"];
/** 0 internal or hook, 1 callers without a model, 2 callers naming a model, 3 open. */
const risk = r => (r.internal || r.hook ? 0 : !r.callers ? 3 : r.callers.some(k => MODEL.includes(k)) ? 2 : 1);
const LABEL = ["internal or hook in code", "limited by callers in code", "callers admit a model", "open to any caller"];
const worst = t => Math.max(...Object.values(t.roles).map(risk));

test("every HUMAN_ONLY tool still requires a presence proof, whatever reach it declares", () => {
  // A mutating tool may be reach "anyone" because the proof is the stronger gate (and module callers need
  // it). Declaring a reach must never quietly drop the proof, so the booted registry's own presence floor is
  // asked about every tool on the list.
  const tools = new Map(dump().map(t => [t.tool, t]));
  const missing = [], noproof = [];
  for (const name of HUMAN_ONLY) {
    const t = tools.get(name);
    if (!t) { missing.push(name); continue; }
    if (!Object.values(t.roles).every(r => r.proof === true)) noproof.push(`${t.module}: ${name} (reach ${t.reach})`);
  }
  assert.deepEqual(noproof.sort(), [], "a HUMAN_ONLY tool no longer requires a proof");
  assert.ok(missing.length <= 3, `HUMAN_ONLY names no module registers: ${missing.join(", ")}`);
});

test("every tool is declared by a reach, or is on the allowlist with the label the registry gives it", () => {
  const tools = dump();
  assert.ok(tools.length > 500, `the registry booted with ${tools.length} tools`);
  const open = [], mislabelled = [], stale = [];
  for (const t of tools) {
    const line = allow[t.tool];
    if (explicit.has(t.tool)) { if (line) stale.push(`${t.module}: ${t.tool}`); continue; }
    if (!line) { open.push(`${t.module}: ${t.tool} (${LABEL[worst(t)]})`); continue; }
    if (line.default !== LABEL[worst(t)]) mislabelled.push(`${t.module}: ${t.tool} is listed "${line.default}" but is "${LABEL[worst(t)]}"`);
  }
  assert.deepEqual(open.sort(), [], "no reach declared: write { name, reach } in module.json (a callers list that admits mcp or harness is not a limit)");
  assert.deepEqual(stale.sort(), [], "listed, but the manifest declares a reach now: delete the line");
  assert.deepEqual(mislabelled.sort(), [], "relabel these lines in test/reach-allowlist.json (or fix the code)");
});

test("a tool a box and a local registry define differently is reviewed", () => {
  const diverge = dump().filter(t => Object.keys(t.roles).length > 1 && new Set(Object.values(t.roles).map(risk)).size > 1).map(t => t.tool);
  assert.deepEqual(diverge.filter(t => !roleList[t]).sort(), [], "a tool differs between box and local: add it to test/reach-roles.json with the reason");
  assert.deepEqual(Object.keys(roleList).filter(t => !diverge.includes(t)).sort(), [], "delete these lines from test/reach-roles.json");
});
