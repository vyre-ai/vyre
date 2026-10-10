// @ts-check
// A manifest's reach and the golden allow file must say the same thing (the 4 Oct 2026 ruling: an assistant can do what its person can, with a written reason for each tool kept the person's alone).
// `reach: "person"` is the person's own surfaces PLUS their assistant, except the tools on PERSON_ONLY (core/modules/agent-reach.js, one reason each). So every person-reach tool is in exactly one of
// three lists, and nothing a manifest hides (modules, hook) is allowed to a session. It reads files only; it boots nothing.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPEN, ASK_FIRST, PERSON_ONLY } from "../core/modules/agent-reach.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const allow = new Map(JSON.parse(fs.readFileSync(path.join(root, "kernel", "golden", "allow.json"), "utf8")).map((/** @type {any} */ e) => [e.tool, e.reason]));
/** @type {Map<string, string>} tool -> reach, over every first-party manifest */
const reach = new Map();
(function walk(/** @type {string} */ dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "testing"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === "module.json") for (const t of ((JSON.parse(fs.readFileSync(p, "utf8")).does || {}).tools || [])) if (t && t.name && t.reach) reach.set(t.name, t.reach);
  }
})(path.join(root, "core"));

test("every person-reach tool is exactly one of: open to the person's assistant, asked first, or the person's alone (PERSON_ONLY, with its reason)", () => {
  const bad = [];
  for (const [tool, r] of reach) {
    if (r !== "person") continue;
    const homes = [OPEN.has(tool) && "OPEN", ASK_FIRST.has(tool) && "ASK_FIRST", PERSON_ONLY.has(tool) && "PERSON_ONLY"].filter(Boolean);
    if (homes.length !== 1) bad.push(`${tool}: in ${homes.length ? homes.join(" and ") : "none of OPEN, ASK_FIRST, PERSON_ONLY"}`);
  }
  assert.deepEqual(bad, [], "a person-reach tool names where an assistant stands on it");
});

test("the golden allow file agrees with the manifests: an allowed tool is person or anyone reach, and a person-only or hidden tool is never allowed", () => {
  const bad = [];
  for (const tool of allow.keys()) {
    const r = reach.get(tool);
    if (r !== undefined && r !== "person" && r !== "anyone") bad.push(`${tool} is allowed to sessions but its manifest says reach ${r}`);
    if (PERSON_ONLY.has(tool)) bad.push(`${tool} is allowed to sessions and is on PERSON_ONLY`);
  }
  for (const [tool, r] of reach) if ((r === "modules" || r === "hook") && allow.has(tool)) bad.push(`${tool}: reach ${r} yet allowed`);
  assert.deepEqual(bad, []);
});

test("every person-reach tool a session may run is in the golden file with the ruling as its reason, and no other person-reach tool is", () => {
  const bad = [];
  for (const [tool, r] of reach) {
    if (r !== "person") continue;
    const inGolden = allow.has(tool), should = OPEN.has(tool) || ASK_FIRST.has(tool);
    if (inGolden !== should) bad.push(`${tool}: ${should ? "open or asked-first" : "the person's alone"} but ${inGolden ? "in" : "not in"} the golden allow file`);
    if (inGolden && !/an assistant can do what its person can/.test(String(allow.get(tool)))) bad.push(`${tool}: its golden reason does not cite the 4 Oct ruling`);
  }
  assert.deepEqual(bad, [], "regenerate with npm run golden:allow, or move the tool between the lists");
});
