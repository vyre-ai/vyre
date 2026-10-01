// PERSON_ONLY (core/presence) is enforced by the daemon's socket-peer check and the harness floor, not
// by the registry. The two must agree: a tool the floor treats as the person's own must also say
// reach "person", so a caller kind the floor does not see (a module, an agent on a surface) is
// refused by the registry too. test/reach-person-only.json lists the tools that do not yet; each owner
// sets reach person and deletes the line, or replaces "pending" with the reason module callers need
// it. This fails on a PERSON_ONLY tool that is neither reach person nor listed, and on a stale line.
// It reads files only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PERSON_ONLY } from "../core/presence/index.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
function* manifests(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "testing"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* manifests(p);
    else if (e.name === "module.json") yield p;
  }
}
const reach = new Map();
for (const top of ["core", "local", "modules", "apps"]) {
  const dir = path.join(root, top);
  if (!fs.existsSync(dir)) continue;
  for (const f of manifests(dir)) {
    let m; try { m = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
    for (const t of (m && m.does && m.does.tools) || []) reach.set(typeof t === "string" ? t : t.name, typeof t === "object" ? t.reach || null : null);
  }
}
const listed = JSON.parse(fs.readFileSync(path.join(root, "test", "reach-person-only.json"), "utf8")).tools;

test("every PERSON_ONLY tool declares reach person, or is on the list with a reason", () => {
  const bad = [...PERSON_ONLY].filter(t => reach.has(t) && reach.get(t) !== "person" && !(t in listed)).sort();
  assert.deepEqual(bad, [], "set reach person in module.json (or list the tool in test/reach-person-only.json with the reason)");
});

test("the PERSON_ONLY list only names tools that still are not reach person", () => {
  const stale = Object.keys(listed).filter(t => !PERSON_ONLY.has(t) || !reach.has(t) || reach.get(t) === "person").sort();
  assert.deepEqual(stale, [], "delete these lines from test/reach-person-only.json");
});
