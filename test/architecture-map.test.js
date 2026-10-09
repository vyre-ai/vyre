// @ts-check
// docs/architecture/map.md is the 30-minute map of Vyre for a new developer, and it must not go stale. Three tables are written from the tree (scripts/gen-architecture-map.mjs): the repository's top-level
// folders, kernel/'s folders and every module. This test fails when
//   - one of those tables differs from what the tree says now (run the generator),
//   - a folder or module exists that the generator has no words for (add them there: that is how the map learns of it),
//   - the generator describes a folder or module that is gone,
//   - the page names a path that does not exist, or loses a heading the architecture questions point at,
//   - the page grows past what can be read in about 30 minutes, or shrinks to something that is no longer a map.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, PAGE, LAYOUT, KERNEL, MODULES, GROUPS, render, topLevelDirs, kernelDirs, moduleFolders } from "../scripts/gen-architecture-map.mjs";

const page = fs.readFileSync(path.join(ROOT, PAGE), "utf8");

test("the generated tables of the map match the tree", () => {
  assert.equal(render(page), page, `${PAGE} is out of date: run node scripts/gen-architecture-map.mjs`);
});

test("every top-level folder, kernel folder and module has a description in the generator, and none is left over", () => {
  const same = (/** @type {string[]} */ have, /** @type {string[]} */ want, /** @type {string} */ what) => {
    assert.deepEqual(have.filter((x) => !want.includes(x)), [], `${what}: in the tree but not described in scripts/gen-architecture-map.mjs`);
    assert.deepEqual(want.filter((x) => !have.includes(x)), [], `${what}: described in scripts/gen-architecture-map.mjs but gone from the tree`);
  };
  same(topLevelDirs(), Object.keys(LAYOUT), "top-level folders");
  same(kernelDirs(), Object.keys(KERNEL), "kernel folders");
  same(moduleFolders().map((m) => m.folder), Object.keys(MODULES), "modules");
  const groups = GROUPS.map((g) => g[0]);
  for (const [folder, [group, blurb]] of Object.entries(MODULES)) {
    assert.ok(groups.includes(group), `${folder} names the group ${group}, which does not exist`);
    assert.ok(blurb && blurb.length > 10, `${folder} needs a sentence saying what it does`);
  }
});

test("every path the map names exists", () => {
  const text = page.replace(/<!-- map:(\w+):start -->[\s\S]*?<!-- map:\1:end -->/g, "");
  const tops = new Set(topLevelDirs());
  const missing = [];
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    let p = m[1].trim();
    if (!/^[A-Za-z0-9_.][A-Za-z0-9_.\/-]*$/.test(p)) continue;       // not a path-looking token (a command, a placeholder, a flag)
    const first = p.split("/")[0];
    if (!p.includes("/") || !tops.has(first)) continue;
    p = p.replace(/\/$/, "");
    if (!fs.existsSync(path.join(ROOT, p))) missing.push(p);
  }
  assert.deepEqual([...new Set(missing)], [], "the map names paths that are not in the repository");
});

test("the headings the architecture questions (team/0.3.1/ARCH-QUESTIONS.md) point at are still there", () => {
  const heads = [...page.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  for (const h of ["1. Vyre in one page", "2. The machines and the daemon", "3. The kernel", "4. The contract: six things and one gateway", "5. The Gate, presence and approvals", "6. The Vault and sealing", "7. Records and Flows", "8. Connections", "9. The harness, sessions and the MCP server", "10. The apps and surfaces", "11. The network: relay, Wink and names", "12. Where data lives", "13. One request, end to end", "14. The repository, top to bottom", "15. Every module", "16. How to read the code in your first hour"])
    assert.ok(heads.includes(h), `the map lost its heading "${h}"`);
});

test("the map is a map: readable in about 30 minutes, no em dash, no section sign", () => {
  const prose = page.replace(/<!-- map:(\w+):start -->[\s\S]*?<!-- map:\1:end -->/g, "");
  const words = prose.split(/\s+/).filter(Boolean).length;
  assert.ok(words >= 3500 && words <= 8000, `the prose is ${words} words; a 30 minute read is about 3,500 to 8,000`);
  assert.ok(!page.includes("—") && !page.includes("§"), "no em dash, no section sign");
});
