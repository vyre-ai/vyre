// @ts-check
// Quick Look reads the next and previous file ahead, including a linked folder's files.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

const row = (key, root, path, link) => ({ key, dir: false, root, path, size: 10, ...(link ? { link } : {}) });

test("ahead of a linked file is the next and previous file in that folder, not a Space file", { skip: !strip }, async () => {
  const { aheadOf } = await import("./preload-plan.ts");
  const shown = [
    row("s1", "space", "a.txt"),
    row("l1", "linked", "one.txt", "fold"),
    row("l2", "linked", "two.txt", "fold"),
    row("l3", "linked", "three.txt", "fold"),
    row("o1", "linked", "other.txt", "other"),
    { key: "dir", dir: true, root: "linked", path: "sub", size: 0, link: "fold" },
  ];
  assert.deepEqual(aheadOf(shown, "l2").map((r) => r.key), ["l3", "l1"]);
  assert.deepEqual(aheadOf(shown, "l1").map((r) => r.key), ["l2", "l3"]);
  assert.deepEqual(aheadOf(shown, "s1").map((r) => r.key), []);
  assert.deepEqual(aheadOf(shown, "dir"), []);
});
