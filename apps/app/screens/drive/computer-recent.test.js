// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

test("files.recent folders become Worked in lately rows, and a file-shaped answer does not", { skip: !strip }, async () => {
  const { workedInLately, workedLine } = await import("./computer-recent.ts");
  const rows = workedInLately([
    { path: "/work/quill-posters", last: 10, sessions: 2 },
    { path: "/work/nim-notes", last: 4, sessions: 1 },
    { name: "not-a-folder" },
  ]);
  assert.deepEqual(rows, [
    { path: "/work/quill-posters", name: "quill-posters", sessions: 2 },
    { path: "/work/nim-notes", name: "nim-notes", sessions: 1 },
  ]);
  assert.equal(workedLine(rows[0]), "2 chats");
  assert.equal(workedLine(rows[1]), "1 chat");
  assert.deepEqual(workedInLately({ files: [{ path: "/work/a.txt" }] }), []);
  assert.deepEqual(workedInLately(null), []);
});
