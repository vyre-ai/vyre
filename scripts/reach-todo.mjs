#!/usr/bin/env node
// What is left of the reach allowlist (test/reach-allowlist.json): the tools whose module.json entry has
// no explicit `reach`. `node scripts/reach-todo.mjs` prints the count per module; with a module name it
// prints that module's tools. Write { "name": ..., "reach": ... } in module.json and delete the line from
// the allowlist. Reads files only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { tools } = JSON.parse(fs.readFileSync(path.join(root, "test", "reach-allowlist.json"), "utf8"));
const only = process.argv[2];
if (only) {
  for (const [name, v] of Object.entries(tools)) if (v.module === only) console.log(`${name}\t${v.default}${v.internal ? "\tinternal" : ""}${v.hook ? "\thook" : ""}`);
} else {
  const by = {};
  for (const v of Object.values(tools)) by[v.module] = (by[v.module] || 0) + 1;
  for (const [m, n] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(4)}  ${m}`);
  console.log(`${String(Object.keys(tools).length).padStart(4)}  total`);
}
