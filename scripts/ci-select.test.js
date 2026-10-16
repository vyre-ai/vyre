// @ts-check
// The test selector for fast pull request CI (scripts/ci-select.mjs): a changed file picks the tests that reach it through imports, and the changes that reach every test pick all of them. Built on small
// in-memory trees, so each rule is shown on its own.
import "./mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { select, specifiers, resolve } from "./ci-select.mjs";

/** A tree of file -> source, and the selection for a change to it. @param {Record<string, string>} tree @param {string[]} changed */
const pick = (tree, changed) => select({ changed, tracked: new Set(Object.keys(tree)), read: f => tree[f] ?? "" });
/** Twelve unrelated tests plus the files under test, so a third of them is four tests. */
const base = () => {
  /** @type {Record<string, string>} */ const t = {
    "lib/a.js": "export const a = 1;", "lib/b.js": `import { a } from "./a.js"; export const b = a;`, "lib/c.js": "export const c = 1;",
    "lib/a.test.js": `import { a } from "./a.js";`, "lib/c.test.js": `import { c } from "./c.js";`,
    "core/x/index.js": `import { b } from "../../lib/b.js";`, "core/x/index.test.js": `import "./index.js";`,
  };
  for (let i = 0; i < 12; i++) t[`core/u${i}/u.test.js`] = "";
  return t;
};

test("a changed file picks the tests that reach it, through a chain of imports, and no others", () => {
  const r = pick(base(), ["lib/a.js"]);
  assert.equal(r.all, false);
  assert.deepEqual(r.files, ["core/x/index.test.js", "lib/a.test.js"], "a is imported by b, which core/x imports; and by its own test");
  assert.deepEqual(pick(base(), ["lib/c.js"]).files, ["lib/c.test.js"]);
  assert.deepEqual(pick(base(), ["lib/c.js", "lib/b.js"]).files, ["core/x/index.test.js", "lib/c.test.js"], "several changed files add up");
});

test("a changed test file picks itself; a deleted test picks nothing", () => {
  assert.deepEqual(pick(base(), ["lib/c.test.js"]).files, ["lib/c.test.js"]);
  assert.deepEqual(pick(base(), ["lib/gone.test.js"]).files, []);
});

test("a change to a lockfile, a package.json, a workflow, the module loader, the kernel core or the test runner picks all", () => {
  for (const f of ["package-lock.json", "package.json", "apps/app/package.json", "apps/app/package-lock.json", ".github/workflows/node.yml", ".github/actions/twenty-golden/action.yml", "core/modules/index.js", "kernel/core/errors.js", "scripts/test-counts.mjs", "test/helpers.js", "test/test-counts.json"]) {
    const r = pick(base(), [f]);
    assert.equal(r.all, true, f);
    assert.match(r.why.join(" "), /reaches every test/);
  }
});

test("a file that more than a third of the tests reach picks all, one just under does not", () => {
  const t = base();
  for (let i = 0; i < 4; i++) t[`core/u${i}/u.test.js`] = `import "../../lib/c.js";`;   // c now has 5 of 19 tests: under a third
  assert.equal(pick(t, ["lib/c.js"]).all, false);
  t["core/u4/u.test.js"] = `import "../../lib/c.js";`; t["core/u5/u.test.js"] = `import "../../lib/c.js";`;   // 7 of 19: over a third
  const r = pick(t, ["lib/c.js"]);
  assert.equal(r.all, true);
  assert.match(r.why.join(" "), /reached by 7 of 19/);
});

test("notes run nothing; the generated docs and module manifests run the docs check alone", () => {
  const t = { ...base(), "test/docs-check.test.js": "", "docs/reference/tools.md": "", "core/x/module.json": "{}", "team/0.5.3/host53.md": "", "README.md": "" };
  assert.deepEqual(pick(t, ["team/0.5.3/host53.md", "README.md"]).files, []);
  for (const f of ["docs/reference/tools.md", "core/x/module.json"]) {
    const r = pick(t, [f]);
    assert.deepEqual([r.all, r.files, r.docs], [false, ["test/docs-check.test.js"], true], f);
  }
  assert.equal(pick(t, ["lib/c.js"]).docs, false);
});

test("a data file a test imports picks that test; one nothing imports picks all, because a test may read it from disk", () => {
  const t = { ...base(), "core/x/data.json": "{}", "core/x/orphan.json": "{}", "core/x/read.test.js": `import d from "./data.json" with { type: "json" };` };
  assert.deepEqual(pick(t, ["core/x/data.json"]).files, ["core/x/read.test.js"]);
  const r = pick(t, ["core/x/orphan.json"]);
  assert.equal(r.all, true);
  assert.match(r.why.join(" "), /data nothing imports/);
});

test("a code file no test reaches is reported as uncovered; the apps and the capsule, with workflows of their own, are not", () => {
  const t = { ...base(), "lib/lonely.js": "export const z = 1;", "apps/app/screens/s.tsx": "", "local/capsule/x.js": "" };
  const r = pick(t, ["lib/lonely.js"]);
  assert.deepEqual([r.all, r.files, r.uncovered], [false, [], ["lib/lonely.js"]]);
  assert.deepEqual(pick(t, ["apps/app/screens/s.tsx", "local/capsule/x.js"]).uncovered, []);
  assert.deepEqual(pick(t, ["lib/c.js"]).uncovered, []);
  assert.deepEqual(pick(t, ["lib/lonely.js", "package.json"]).uncovered, [], "a run of everything covers it");
});

test("a script a test spawns by path, and a workspace package a test imports by name, count as imports", () => {
  const t = {
    "scripts/tool.mjs": "", "core/y/y.test.js": `spawn("node", ["scripts/tool.mjs"]); const p = new URL("../../scripts/other.mjs", import.meta.url);`, "scripts/other.mjs": "",
    "packages/ui/package.json": `{"name":"@vyre/ui"}`, "packages/ui/button.js": "", "apps/app/screens/s.test.js": `import { Button } from "@vyre/ui/button";`,
  };
  for (let i = 0; i < 12; i++) t[`core/u${i}/u.test.js`] = "";
  assert.deepEqual(pick(t, ["scripts/tool.mjs"]).files, ["core/y/y.test.js"]);
  assert.deepEqual(pick(t, ["scripts/other.mjs"]).files, ["core/y/y.test.js"]);
  assert.deepEqual(pick(t, ["packages/ui/button.js"]).files, ["apps/app/screens/s.test.js"]);
});

test("Windows jobs are asked for only when the change can differ there", () => {
  const t = { ...base(), "core/config/index.js": "", "core/config/config.test.js": `import "./index.js";` };
  assert.equal(pick(t, ["core/config/index.js"]).windows, true);
  assert.equal(pick(t, ["lib/c.js"]).windows, true, "lib/ is shared with the Windows set");
  assert.equal(pick(t, ["core/x/index.js"]).windows, false);
});

test("imports are read from every form, and a bare package name resolves to nothing", () => {
  const s = specifiers(`import a from "./a.js"; import "./b.js"; export * from "./c.js"; const d = await import("./d.js"); const e = require("./e.cjs"); import f from "node:fs"; x = "core/k/module.json";`);
  for (const w of ["./a.js", "./b.js", "./c.js", "./d.js", "./e.cjs", "/core/k/module.json"]) assert.ok(s.includes(w), w);
  const tracked = new Set(["lib/a.js", "lib/dir/index.js", "lib/j.json"]);
  assert.equal(resolve("lib/x.js", "./a.js", tracked), "lib/a.js");
  assert.equal(resolve("lib/x.js", "./a", tracked), "lib/a.js");
  assert.equal(resolve("lib/x.js", "./dir", tracked), "lib/dir/index.js");
  assert.equal(resolve("lib/x.js", "./j", tracked), "lib/j.json");
  assert.equal(resolve("lib/x.js", "node:fs", tracked), null);
  assert.equal(resolve("lib/x.js", "./nope.js", tracked), null);
});

test("with no base to compare against the command picks everything", () => {
  const r = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "ci-select.mjs"), ""], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.all, true);
  assert.match(out.why.join(" "), /running everything/);
});
