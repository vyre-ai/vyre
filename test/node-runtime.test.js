// @ts-check
// The Node the box ships is the Node the shared branches test. box/Dockerfile's `FROM node:<major>` is the runtime users run; node.yml's matrix must run that major on every branch, work branches
// included. A matrix on the newer Node alone left the shipped one untested until main (v0.3.0's main was red on Node 22 only).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/** The Node major a Dockerfile's final FROM ships. @param {string} text */
export function shippedMajor(text) {
  const froms = [...text.matchAll(/^FROM\s+node:(\d+)/gim)].map(m => Number(m[1]));
  return froms.length ? froms[froms.length - 1] : 0;
}
/** The Node majors a node.yml matrix expression lists, per branch kind. @param {string} text @returns {number[][]} */
export function matrixArrays(text) {
  const line = text.split("\n").find(l => /^\s*node:\s*\$\{\{\s*fromJSON\(/.test(l)) || "";
  return [...line.matchAll(/'(\[[0-9, ]+\])'/g)].map(m => JSON.parse(m[1]));
}

test("shippedMajor and matrixArrays read the files' own forms", () => {
  assert.equal(shippedMajor("FROM golang:1.27 AS a\nFROM node:22-bookworm-slim@sha256:abc\n"), 22);
  assert.deepEqual(matrixArrays("        node: ${{ fromJSON((a && b) && '[22]' || '[22, 24]') }}"), [[22], [22, 24]]);
  assert.equal(shippedMajor("FROM alpine\n"), 0);
});

test("every matrix node.yml runs, for work branches and for main, includes the Node the box ships", () => {
  const major = shippedMajor(fs.readFileSync("box/Dockerfile", "utf8"));
  assert.ok(major >= 20, `box/Dockerfile has no FROM node:<major> (read ${major})`);
  const arrays = matrixArrays(fs.readFileSync(".github/workflows/node.yml", "utf8"));
  assert.ok(arrays.length === 2, `node.yml's matrix should name two lists (work branches, everything else); read ${arrays.length}`);
  for (const a of arrays) assert.ok(a.includes(major), `a node.yml matrix list ${JSON.stringify(a)} leaves out Node ${major}, which box/Dockerfile ships`);
});
