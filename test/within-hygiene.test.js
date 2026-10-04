// A promise raced against a clock goes through lib/within.js. A hand-rolled race with an unref'd
// timer let the event loop drain with the call still pending (macOS, Node 22): the runner then
// cancelled the rest of the file. This reads the source only; it boots nothing.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const skip = new Set(["node_modules", ".git", "testing"]);
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".js") && !e.name.endsWith(".test.js")) yield p;
  }
}

test("no source races a promise against an unref'd timer; use lib/within.js", () => {
  const bad = [];
  for (const top of ["core", "lib", "local", "packages"]) {
    const dir = path.join(root, top);
    if (!fs.existsSync(dir)) continue;
    for (const f of walk(dir)) {
      if (f.endsWith(path.join("lib", "within.js"))) continue;
      const lines = fs.readFileSync(f, "utf8").split("\n");
      lines.forEach((l, i) => { if (/Promise\.race\(/.test(l) && /setTimeout/.test(l) && /unref/.test(l)) bad.push(`${path.relative(root, f)}:${i + 1}`); });
    }
  }
  assert.deepEqual(bad, []);
});
