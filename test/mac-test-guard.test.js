import "../scripts/mac-test-guard.mjs";
// Every test file imports scripts/mac-test-guard.mjs, so a test never runs on a person's Mac, however it is started (`node --test <file>` included). A new test file without the import fails here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = path.join(REPO, "scripts", "mac-test-guard.mjs");

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "fixtures" || e.name === "image") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.test\.[mc]?js$/.test(e.name)) out.push(p);
  }
}

test("every test file imports the Mac test guard before anything else", () => {
  /** @type {string[]} */ const files = []; walk(REPO, files);
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    /** The first line of code: past blank lines, // comments, a shebang, block comments and "use strict". */
    let first = "", inBlock = false;
    for (const line of src.split("\n")) {
      const t = line.trim();
      if (inBlock) { if (t.includes("*/")) inBlock = false; continue; }
      if (t === "" || t.startsWith("//") || t.startsWith("#!") || /^["']use strict["'];?$/.test(t)) continue;
      if (t.startsWith("/*")) { if (!t.includes("*/")) inBlock = true; continue; }
      first = t; break;
    }
    if (!/^import\s+["'](?:[./]+\/(?:scripts\/)?|\.\/)mac-test-guard\.mjs["'];?$/.test(first.trim())) bad.push(path.relative(REPO, f));
  }
  assert.deepEqual(bad, [], "add `import \"<path to>/scripts/mac-test-guard.mjs\";` as the first import of each");
});

test("the guard stops a run on macOS unless a hosted runner, a test account or the lead's flag allows it, and does nothing elsewhere", () => {
  const run = (/** @type {Record<string,string>} */ env) => spawnSync(process.execPath, ["--input-type=module", "-e", `import ${JSON.stringify(GUARD)}; console.log("ran")`], { env: { PATH: process.env.PATH || "", ...env }, encoding: "utf8" });
  if (process.platform === "darwin") {
    const stopped = run({});
    assert.equal(stopped.status, 1); assert.match(stopped.stderr, /do not run on this Mac/);
    for (const allow of [{ GITHUB_ACTIONS: "true" }, { VYRE_TEST_HOSTED: "1" }, { VYRE_TEST_MAC_OK: "1" }]) assert.equal(run(allow).stdout.trim(), "ran");
  } else assert.equal(run({}).stdout.trim(), "ran");
});

test("the refusal rule: a Mac stops unless a hosted runner, a test account or the lead's flag allows it; the message names the test boxes", async () => {
  const { macWithoutLeave, REFUSAL } = await import("../lib/mac-test-refusal.js");
  assert.equal(macWithoutLeave({}, "darwin"), true);
  assert.equal(macWithoutLeave({ GITHUB_ACTIONS: "true" }, "darwin"), false);
  assert.equal(macWithoutLeave({ VYRE_TEST_HOSTED: "1" }, "darwin"), false);
  assert.equal(macWithoutLeave({ VYRE_TEST_MAC_OK: "1" }, "darwin"), false);
  assert.equal(macWithoutLeave({}, "linux"), false);
  assert.equal(macWithoutLeave({ GITHUB_ACTIONS: "1" }, "darwin"), true, "only the exact word counts");
  assert.match(REFUSAL, /test boxes/);
  assert.match(REFUSAL, /do not run on this Mac/);
});

test("every test file is covered twice: the guard line first, and the code under test that refuses on a Mac (core/config, core/store, lib/mac-test-refusal.js); a file with neither is a hole", () => {
  /** @type {string[]} */ const files = []; walk(REPO, files);
  const refusers = new Set(["core/config/index.js", "core/store/index.js", "lib/mac-test-refusal.js", "scripts/mac-test-guard.mjs"].map(f => path.join(REPO, f)));
  /** @type {Map<string, string[]>} */ const cache = new Map();
  const deps = (/** @type {string} */ f) => {
    if (cache.has(f)) return /** @type {string[]} */ (cache.get(f));
    let src = ""; try { src = fs.readFileSync(f, "utf8"); } catch { /* none */ }
    const out = [];
    for (const m of src.matchAll(/(?:from\s+|import\s*\(?\s*|import\s+)["'](\.[^"']+)["']/g)) {
      let p = path.normalize(path.join(path.dirname(f), m[1]));
      if (!fs.existsSync(p)) for (const e of [".js", ".mjs", "/index.js"]) if (fs.existsSync(p + e)) { p = p + e; break; }
      if (fs.existsSync(p) && fs.statSync(p).isFile()) out.push(p);
    }
    cache.set(f, out); return out;
  };
  const reaches = (/** @type {string} */ start) => { const seen = new Set([start]); const st = [start]; while (st.length) { const x = /** @type {string} */ (st.pop()); if (refusers.has(x)) return true; for (const d of deps(x)) if (!seen.has(d)) { seen.add(d); st.push(d); } } return false; };
  const holes = files.filter(f => !reaches(f)).map(f => path.relative(REPO, f));
  assert.deepEqual(holes, [], "a test file that loads none of Vyre's code and has no guard line");
});
