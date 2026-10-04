// @ts-check
// Every input a wink, relay, link or network tool really reads is declared in its schema: the registry refuses undeclared keys from a caller that is not a module, so a tool that
// reads `input.proof` without declaring it works in a unit test that calls `run` and fails over the wire (walk step 4, 4 Oct).
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

const MODULES = ["wink", "relay", "link", "network"];

/** The keys a tool's run body reads from its input: `input.x`, `input?.x`, `input["x"]` and a destructured first parameter. @param {Function} run */
function readKeys(run) {
  const src = String(run);
  const keys = new Set();
  for (const m of src.matchAll(/\binput\??\.([A-Za-z_]\w*)/g)) keys.add(m[1]);
  for (const m of src.matchAll(/\binput\[\s*["']([A-Za-z_]\w*)["']\s*\]/g)) keys.add(m[1]);
  const d = /^(?:async\s*)?\(\s*\{([^}]*)\}/.exec(src);
  if (d) for (const part of d[1].split(",")) { const k = part.trim().split(/[:=\s]/)[0]; if (k) keys.add(k); }
  return keys;
}

test("every input a wink, relay, link or network tool reads is declared in its schema", { timeout: 60_000 }, async t => {
  /** @type {string[]} */ const missing = [];
  for (const role of ["box", "local"]) {
    const root = tempHome(t);
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role, transcripts: [], name: "harlow-box" }));
    const d = await start({ root, presence: present, log: () => {} });
    t.after(() => d.stop());
    for (const [name, def] of /** @type {Map<string, any>} */ (d.registry.tools)) {
      if (!MODULES.includes(name.split(".")[0]) || typeof def.run !== "function") continue;
      const declared = new Set(Object.keys((def.input && def.input.properties) || {}));
      for (const k of readKeys(def.run)) if (!declared.has(k) && !IGNORED.has(`${name}.${k}`)) missing.push(`${role}: ${name} reads ${k}`);
    }
  }
  assert.deepEqual(missing, [], "declare each of these in the tool's input schema");
});

/** Names that match the pattern but are not the tool's input: filled in only after a reading of the tool says so. */
// link.macs.call reads `input.ask` and `input.thread` of the tool it forwards (its own `input` property is declared), not of itself.
const IGNORED = new Set(["link.macs.call.ask", "link.macs.call.thread"]);
