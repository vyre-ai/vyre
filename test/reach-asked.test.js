// A tool with reach "asked" is for an agent only when the person's own words asked for exactly that
// act, matched against a said intent a recorder wrote (lib/said). Today recorders exist for pull
// request, teammate and setting acts; on any other tool "asked" refuses every agent and module for good,
// even when the person did ask. This fails when a manifest declares "asked" for a tool that
// test/asked-recorders.json does not tie to a recorder file that exists. It reads files only.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
function* manifests(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "testing"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* manifests(p);
    else if (e.name === "module.json") yield p;
  }
}
const recorders = JSON.parse(fs.readFileSync(path.join(root, "test", "asked-recorders.json"), "utf8")).tools;

test("every tool with reach asked has a said-intent recorder", () => {
  const bad = [];
  for (const top of ["core", "local", "modules", "apps"]) {
    const dir = path.join(root, top);
    if (!fs.existsSync(dir)) continue;
    for (const f of manifests(dir)) {
      let m; try { m = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
      for (const t of (m && m.does && m.does.tools) || []) {
        if (!t || typeof t !== "object" || t.reach !== "asked") continue;
        const rec = recorders[t.name];
        if (typeof rec === "string" && rec.startsWith("PENDING")) continue; // tracked: the owner shrinks this
        if (!rec) bad.push(`${m.name}: ${t.name} has no recorder in test/asked-recorders.json`);
        else if (!fs.existsSync(path.join(root, rec))) bad.push(`${m.name}: ${t.name} names ${rec}, which does not exist`);
      }
    }
  }
  assert.deepEqual(bad.sort(), [], "reach asked needs a said-intent recorder: add one with the assistant team (lib/said) or pick another reach");
});
