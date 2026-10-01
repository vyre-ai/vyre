// reach "anyone" must be written on purpose. A tool that declares it is open to every caller kind a registry
// admits, models included, so the manifest alone says nothing about what stops a misuse. This fails on an
// "anyone" with no reason in test/reach-anyone.json, on a reason that does not name a guard when the tool's
// name carries a mutating verb ("read-only" does not count for those), and on a stale line. A PENDING reason
// is tracked for the owner to replace. It reads files only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const reasons = JSON.parse(fs.readFileSync(path.join(root, "test", "reach-anyone.json"), "utf8")).tools;
const MUTATING = /\.(set|write|delete|remove|revoke|grant|create|update|point|release|claim|reveal|send|exec|run|open|start|stop|kill|take|reset|wipe|export|import|add|move|archive|rename|pair|unpair|enroll|sign|signin|signout|post|apply|fill|edit|answer|approve|reject|forget|accept|retire|merge|connect|disconnect)(\.|$)/;
const GUARD = /(callers|gate|held|presence|proof|scope|owner|guard|check|refuse|internal|modules only|assistant|person)/i;
function* manifests(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "testing"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* manifests(p);
    else if (e.name === "module.json") yield p;
  }
}
const anyone = new Map();
for (const top of ["core", "local", "modules", "apps"]) {
  const dir = path.join(root, top);
  if (!fs.existsSync(dir)) continue;
  for (const f of manifests(dir)) {
    let m; try { m = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
    for (const t of (m && m.does && m.does.tools) || []) if (t && typeof t === "object" && t.reach === "anyone") anyone.set(t.name, m.name);
  }
}

test("every tool that declares reach anyone says why", () => {
  const none = [...anyone].filter(([name]) => !reasons[name] || !String(reasons[name].reason || "").trim()).map(([n, m]) => `${m}: ${n}`).sort();
  assert.deepEqual(none, [], "add a reason to test/reach-anyone.json: the guard it relies on, or read-only");
  const weak = [...anyone].filter(([name]) => {
    const r = String((reasons[name] || {}).reason || "");
    return MUTATING.test(name) && !r.startsWith("PENDING") && (/^read-only/i.test(r) || !GUARD.test(r));
  }).map(([n, m]) => `${m}: ${n}: ${(reasons[n] || {}).reason}`).sort();
  assert.deepEqual(weak, [], "a tool with a mutating verb needs a reason that names a guard (callers list, presence proof, own-scope check, Gate), not read-only");
});

test("the anyone reasons only name tools that still declare anyone", () => {
  const stale = Object.keys(reasons).filter(n => !anyone.has(n)).sort();
  assert.deepEqual(stale, [], "delete these lines from test/reach-anyone.json");
});
