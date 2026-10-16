// @ts-check
// Drive's pure helpers: a file's bytes read as UTF-8 text from base64, and the three places the Files screen opens.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const b64 = (/** @type {string} */ s) => Buffer.from(s, "utf8").toString("base64");

test("a file's bytes read as UTF-8 text, and a bad byte is a replacement mark, not an error", { skip: !strip }, async () => {
  const { textOf, bytesOf, sizeWord } = await import("./real-model.ts");
  assert.equal(textOf(bytesOf(b64("Hi Kit, é ok"))), "Hi Kit, é ok");
  assert.equal(textOf([72, 0xff, 105]), "H�i");
  assert.deepEqual([sizeWord(29), sizeWord(184 * 1024), sizeWord(2.1 * 1024 * 1024)], ["29 B", "184 KB", "2.1 MB"]);
});

test("the real Drive has one Shared tab, no separate Shared links tab, and no tab for the box's own folders", async () => {
  const { REAL_TABS } = await import("./tabs.js");
  const names = REAL_TABS.map(([k]) => k);
  assert.deepEqual(names, ["space", "shared", "linked"]);
  assert.ok(!REAL_TABS.some(([, label]) => label === "Shared links"));
});
