// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { capsuleFromTree } from "./capsule-peer.js";
import { SCRATCH } from "../../test/scratch.mjs";

test("capsule-peer: only the Vyre.app in core's own tree is the Capsule, however the path is reached; a copy elsewhere is not", async t => {
  const d = fs.mkdtempSync(path.join(SCRATCH, "cp-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const tree = path.join(d, "versions", "1.0.0");
  const bin = path.join(tree, "Vyre.app", "Contents", "MacOS", "Vyre");
  fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.writeFileSync(bin, "capsule");
  fs.symlinkSync("versions/1.0.0", path.join(d, "current"));
  const copy = path.join(d, "elsewhere", "Vyre"); fs.mkdirSync(path.dirname(copy)); fs.writeFileSync(copy, "capsule");
  const exes = /** @type {Record<number, string | null>} */ ({ 1: bin, 2: path.join(d, "current", "Vyre.app", "Contents", "MacOS", "Vyre"), 3: copy, 4: null, 5: "/nonexistent/x" });
  const is = capsuleFromTree({ codeDir: tree, exeOf: pid => exes[pid] ?? null });
  assert.equal(await is(1), true);
  assert.equal(await is(2), true, "through the current link");
  assert.equal(await is(3), false, "an identical copy elsewhere");
  assert.equal(await is(4), false, "no answer from ps");
  assert.equal(await is(5), false);
  assert.equal(await capsuleFromTree({ codeDir: path.join(d, "no-tree"), exeOf: () => bin })(1), false, "a tree with no app");
});
