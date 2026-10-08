// @ts-check
// The step runner behind scripts/proof-install.mjs: a person reads its lines, so what it prints and how it counts is a promise.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRun } from "../scripts/lib/proof/run.mjs";

const make = () => { const lines = /** @type {string[]} */ ([]); const out = fs.mkdtempSync(path.join(os.tmpdir(), "proof-run-")); return { lines, out, run: createRun({ out, say: l => lines.push(l) }) }; };

test("a step prints PASS with its note, or FAIL with the reason and the error's code", async () => {
  const { lines, run } = make();
  await run.step("one", () => "a note");
  await run.step("two", () => { throw Object.assign(new Error("it broke"), { code: "x_y" }); });
  assert.deepEqual(lines, ["PASS  one: a note", "FAIL  two: it broke [x_y]"]);
});

test("a step whose needed step failed is SKIPped and names the one that broke, not counted as a failure", async () => {
  const { lines, run, out } = make();
  await run.step("a", () => { throw new Error("no"); });
  assert.equal(await run.step("b", () => "never", { needs: ["a"] }), false);
  await run.step("c", () => {});
  assert.equal(lines[1], 'SKIP  b: needs "a"');
  assert.equal(run.finish(), 1);
  const j = JSON.parse(fs.readFileSync(path.join(out, "results.json"), "utf8"));
  assert.deepEqual([j.pass, j.fail, j.skip], [1, 1, 1]);
});

test("the last line sums the run and the exit code is 0 only when nothing failed", async () => {
  const { lines, run } = make();
  await run.step("a", () => {});
  assert.equal(run.finish(), 0);
  assert.equal(lines[lines.length - 1], "PASS  1 passed, 0 failed, 0 skipped");
});
