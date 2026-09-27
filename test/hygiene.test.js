// @ts-check
// Repository hygiene: nothing personal and no secrets in shipped code.
//
// The forbidden words and the secret pattern live in scripts/lib/hygiene.js, shared with
// scripts/docs-check, which holds the published docs to the same rules.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FORBIDDEN, SECRET } from "../scripts/lib/hygiene.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPED = ["bin", "core", "harness", "local", "deck", "modules"];

function files(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    // dist/ and bin/ hold build output (a packaged app, compiled helpers), not source.
    if (e.name === "node_modules" || e.name === "dist" || e.name === "bin" || e.name.startsWith(".git")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.(js|json|md|mjs|cjs|sh|html|css|swift)$|^vyre$/.test(e.name)) out.push(p);
  }
  return out;
}

test("hygiene: shipped code names no one and carries no secrets", () => {
  const hits = [];
  for (const dir of SHIPPED) for (const f of files(path.join(ROOT, dir))) {
    const text = fs.readFileSync(f, "utf8").toLowerCase();
    for (const w of FORBIDDEN) if (text.includes(w)) hits.push(`${path.relative(ROOT, f)}: personal name`);
    if (SECRET.test(fs.readFileSync(f, "utf8"))) hits.push(`${path.relative(ROOT, f)}: looks like a secret`);
  }
  assert.deepEqual(hits, []);
});
