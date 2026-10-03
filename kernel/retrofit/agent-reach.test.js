import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolEntries } from "../../packages/module-sdk/manifest.js";
import { PERSON_ONLY, OPEN, ASK_FIRST } from "../../core/modules/agent-reach.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("every reach:person tool in a manifest is classified once (person only, open, or ask first), and nothing classified has gone away", () => {
  /** @type {string[]} */ const declared = [];
  for (const root of ["core", "local", "modules"]) {
    const base = path.join(REPO, root);
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base)) {
      try { const m = JSON.parse(fs.readFileSync(path.join(base, d, "module.json"), "utf8")); for (const e of toolEntries(m)) if (e.reach === "person") declared.push(e.name); } catch { /* not a module */ }
    }
  }
  const listed = new Set([...PERSON_ONLY.keys(), ...OPEN, ...ASK_FIRST.keys()]);
  const unclassified = declared.filter(n => !listed.has(n));
  assert.deepEqual(unclassified, [], `classify these in core/modules/agent-reach.js (person only with a reason, open, or ask first): ${unclassified.join(", ")}`);
  const gone = [...listed].filter(n => !declared.includes(n));
  assert.deepEqual(gone, [], `these are classified but no longer person-reach tools: ${gone.join(", ")}`);
});
