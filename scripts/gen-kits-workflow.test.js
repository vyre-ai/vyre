// @ts-check
// .github/workflows/gen-kits-branch.yml recompiles the record kits on a polish branch and commits kit.json back. What it must keep: only work/polish/** branches, the write token never in the job that runs the
// branch's compiler, nothing from the branch run by the job that has the write token, and a patch accepted only when it names records/kits/<name>/kit.json files or an app Kit's .kit.json.
import "./mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const yml = fs.readFileSync(path.join(ROOT, ".github/workflows/gen-kits-branch.yml"), "utf8");
const job = (/** @type {string} */ name) => { const a = yml.indexOf(`\n  ${name}:\n`); assert.ok(a >= 0, name); const m = /\n  [a-z][a-z0-9-]*:\n/.exec(yml.slice(a + 1)); return yml.slice(a, m ? a + 1 + m.index : undefined); };

test("only polish branches, on a change to a kit source, the language or this file", () => {
  assert.match(yml, /\n  push:\n    branches: \["work\/polish\/\*\*"\]\n    paths: \["records\/kits\/\*\*\/kit\.ts", "core\/appmods\/catalog\/\*\.kit\.ts", "records\/core-types\.js", "records\/language\/\*\*", "\.github\/workflows\/gen-kits-branch\.yml"\]\n/);
  assert.match(job("regenerate"), /if: startsWith\(github\.ref_name, 'work\/polish\/'\)/);
  assert.match(job("commit"), /case "\$BRANCH" in work\/polish\/\*\) ;; \*\) echo "::error::only work\/polish\/\*\* branches"; exit 1;; esac/);
});

test("the job that runs the branch's compiler has a read-only token and keeps no credentials", () => {
  const r = job("regenerate");
  assert.match(r, /permissions:\n      contents: read\n/);
  assert.match(r, /persist-credentials: false/);
  assert.ok(!/contents: write/.test(r));
  assert.match(r, /npm ci --ignore-scripts --no-audit --no-fund\n/, "dependencies install without running any install script");
  assert.match(r, /node records\/language\/cli\.js compile "\$src"/);
});

test("the job with the write token runs none of the branch's code and accepts only kit.json files", () => {
  const c = job("commit");
  assert.match(c, /permissions:\n      contents: write\n/);
  assert.ok(!/\bnode\b|\bnpm\b|records\/language/.test(c), "no node, npm or compiler in the job that can write");
  assert.match(c, /\^\(records\/kits\/\[A-Za-z0-9_-\]\+\/kit\\\.json\|core\/appmods\/catalog\/\[A-Za-z0-9_-\]\+\\\.kit\\\.json\)\$/);
  assert.match(c, /old mode\|new mode\|rename \|copy \|new file mode 120000\|deleted file mode 120000/);
  assert.match(c, /\[ "\$\(git rev-parse HEAD\)" = "\$HEAD_SHA" \]/, "a branch that moved on is left alone");
});
