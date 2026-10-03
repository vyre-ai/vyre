#!/usr/bin/env node
// verify-list-trees <package root> <modules.json>: every module folder under a package root against the release's signed list, with the kernel's own check (verifyTrees in
// kernel/modules/release-list.js). The release runs it on the unpacked vyre.tgz AND on the BUILT box image's /opt/vyre (docker cp), because the list is made from the tarball while the
// image is built from a context that is not the tarball: one byte of difference in a module folder, and every box refuses that module. Exit 1 and name each module on any difference.
import fs from "node:fs";
import path from "node:path";
import * as rl from "../kernel/modules/release-list.js";

// The kernel's own check when it has one (verifyTrees); on a line whose release-list.js does not have it yet, the same walk with the kernel's createListCheck.
/** @param {string} root @param {any} list @returns {{ ok: boolean, bad: string[] }} */
function verifyTrees(root, list) {
  if (typeof (/** @type {any} */ (rl)).verifyTrees === "function") return /** @type {any} */ (rl).verifyTrees(root, list);
  const check = /** @type {any} */ (rl).createListCheck(list);
  /** @type {string[]} */ const bad = [], seen = [];
  for (const top of ["core", "local", "modules"]) {
    const base = path.join(root, top);
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base).sort()) {
      const dir = path.join(base, d), mj = path.join(dir, "module.json");
      if (!fs.existsSync(mj)) continue;
      let name = d;
      try { name = String(JSON.parse(fs.readFileSync(mj, "utf8")).name); } catch { /* counted as bad below */ }
      seen.push(name);
      if (!check(dir)) bad.push(name);
    }
  }
  for (const n of Object.keys(list.modules)) if (!seen.includes(n)) bad.push(n);
  return { ok: bad.length === 0, bad };
}

const [root, listFile] = process.argv.slice(2);
if (!root || !listFile) { console.error("usage: verify-list-trees.mjs <package root> <modules.json>"); process.exit(2); }
const list = JSON.parse(fs.readFileSync(listFile, "utf8"));
const r = verifyTrees(root, list);
if (!r.ok) { console.error(`verify-list-trees: ${root} does not match the signed list: ${r.bad.join(", ")}`); process.exit(1); }
console.log(`verify-list-trees: ${root} holds exactly the ${Object.keys(list.modules).length} listed modules`);
