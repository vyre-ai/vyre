#!/usr/bin/env node
// verify-list-trees <package root> <modules.json>: every module folder under a package root against the release's signed list, with the kernel's own check (verifyTrees in
// kernel/modules/release-list.js). The release runs it on the unpacked vyre.tgz AND on the BUILT box image's /opt/vyre (docker cp), because the list is made from the tarball while the
// image is built from a context that is not the tarball: one byte of difference in a module folder, and every box refuses that module. Exit 1 and name each module on any difference.
import fs from "node:fs";
import { verifyTrees } from "../kernel/modules/release-list.js";

const [root, listFile] = process.argv.slice(2);
if (!root || !listFile) { console.error("usage: verify-list-trees.mjs <package root> <modules.json>"); process.exit(2); }
const list = JSON.parse(fs.readFileSync(listFile, "utf8"));
const r = verifyTrees(root, list);
if (!r.ok) { console.error(`verify-list-trees: ${root} does not match the signed list: ${r.bad.join(", ")}`); process.exit(1); }
console.log(`verify-list-trees: ${root} holds exactly the ${Object.keys(list.modules).length} listed modules`);
