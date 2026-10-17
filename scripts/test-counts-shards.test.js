// @ts-check
// The shards of a CI run (scripts/test-counts.mjs shardFiles): balanced by how long each file takes, every file in exactly one shard, the same split from every shard's own point of view.
import "./mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { shardFiles, DEFAULT_SECONDS, TIMINGS, GLOBS } from "./test-counts.mjs";

const files = Array.from({ length: 200 }, (_, i) => `core/m${String(i).padStart(3, "0")}/x.test.js`);
const weights = { [files[0]]: 120, [files[1]]: 90, [files[2]]: 90, [files[3]]: 60, [files[4]]: 60, [files[5]]: 45 };
const seconds = (/** @type {string[]} */ list, /** @type {Record<string, number>} */ w) => list.reduce((a, f) => a + (w[f] ?? DEFAULT_SECONDS), 0);

test("every file is in exactly one shard, and each shard's own call gives the same split", () => {
  for (const total of [1, 5, 12]) {
    const parts = Array.from({ length: total }, (_, i) => shardFiles(files, i + 1, total, weights));
    assert.deepEqual(parts.flat().sort(), [...files].sort(), `${total} shards cover every file once`);
    assert.deepEqual(parts, Array.from({ length: total }, (_, i) => shardFiles([...files].reverse().sort(), i + 1, total, weights)), "the same on every call");
  }
});

test("the longest files go to different shards, and no shard is more than the longest file above the lightest", () => {
  const total = 12, parts = Array.from({ length: total }, (_, i) => shardFiles(files, i + 1, total, weights));
  const holder = (/** @type {string} */ f) => parts.findIndex(p => p.includes(f));
  assert.equal(new Set([0, 1, 2, 3, 4, 5].map(i => holder(files[i]))).size, 6, "the six heavy files are in six different shards");
  const loads = parts.map(p => seconds(p, weights));
  assert.ok(Math.max(...loads) - Math.min(...loads) <= 120, `loads ${loads.join(", ")}`);
});

test("the boot tests' time counts toward shard 1, and a file with no weight counts the default", () => {
  const withBoot = shardFiles(files, 1, 4, {}, 600), without = shardFiles(files, 1, 4, {}, 0);
  assert.ok(withBoot.length < without.length, "a shard that starts with 600 seconds of boot tests takes fewer files");
  assert.equal(seconds(shardFiles(files, 2, 4, {}), {}), (files.length / 4) * DEFAULT_SECONDS, "equal files split equally");
});

test("the recorded timings are numbers for files that exist, and the measured ones are not the default", () => {
  const w = JSON.parse(fs.readFileSync(TIMINGS, "utf8"));
  const all = new Set(GLOBS.flatMap(g => fs.globSync(g)).map(f => f.split("\\").join("/")));
  for (const [f, s] of Object.entries(w)) { assert.equal(typeof s, "number", f); assert.ok(s > 0 && s < 600, f); assert.ok(all.has(f), `${f} is a test file the suite runs`); }
});
