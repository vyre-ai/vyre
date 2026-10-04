import "../scripts/mac-test-guard.mjs";
// A module may emit only the events its manifest declares under watches.emits (the loader refuses the rest at run time: "emitted X, which its manifest does not declare"). That check only fires when the
// line runs, so signin.dev shipped broken. This guard reads every literal `ctx.events.emit("name"` in a module's own files and fails when the manifest does not list it. KNOWN is today's
// exceptions, per module, and only shrinks.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Emitted without being declared today, by module. Declare it (or have the daemon say it) and delete the entry; never add one. */
const KNOWN = {};

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "testing") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (/\.m?js$/.test(e.name) && !/\.test\.m?js$/.test(e.name)) out.push(p);
  }
  return out;
}

test("every event a module emits by literal name is declared in its manifest's watches.emits", () => {
  const bad = [];
  for (const top of ["core", "modules"]) {
    for (const m of fs.readdirSync(path.join(ROOT, top), { withFileTypes: true })) {
      const dir = path.join(ROOT, top, m.name), mf = path.join(dir, "module.json");
      if (!m.isDirectory() || !fs.existsSync(mf)) continue;
      const manifest = JSON.parse(fs.readFileSync(mf, "utf8"));
      const declared = new Set(((manifest.watches || {}).emits) || []);
      const known = new Set(KNOWN[manifest.name] || []);
      for (const f of files(dir)) {
        const src = fs.readFileSync(f, "utf8");
        for (const x of src.matchAll(/ctx\.events\.emit\(\s*["'`]([a-z][a-z0-9.\-]*)["'`]/g)) {
          if (!declared.has(x[1]) && !known.has(x[1])) bad.push(`${manifest.name}: ${x[1]} (${path.relative(ROOT, f)})`);
        }
      }
    }
  }
  assert.deepEqual([...new Set(bad)].sort(), [], "declare these under watches.emits in the module's manifest");
});
