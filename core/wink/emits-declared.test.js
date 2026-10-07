// @ts-check
// An event a module emits must be declared under watches.emits in its manifest, or the daemon refuses the emit at run time (a pairing once failed this way, found only by a live run). Scans core/wink's code
// for emit("literal"...) calls and checks each name is declared.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
test("every event core/wink emits by a literal name is declared under watches.emits", () => {
  const declared = new Set(JSON.parse(fs.readFileSync(path.join(dir, "module.json"), "utf8")).watches.emits);
  /** @type {string[]} */ const missing = [];
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    const rel = String(f);
    if (!/\.js$/.test(rel) || /\.test\.js$/.test(rel) || rel.startsWith("node/") || rel.startsWith("storage/") && false) continue;
    const src = fs.readFileSync(path.join(dir, rel), "utf8");
    for (const m of src.matchAll(/\bevents\.emit\(\s*["'`]([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)["'`]/g)) if (!declared.has(m[1])) missing.push(`${rel}: ${m[1]}`);
  }
  assert.deepEqual([...new Set(missing)], [], "declare these under watches.emits in core/wink/module.json");
});
