import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { ADD_WORDS, LIMIT_DOWN, LIMIT_UP, OPEN_WORDS, checkUpload, openedView } from "./files-model.js";

const b64 = (/** @type {string} */ s) => Buffer.from(s).toString("base64");

test("the limits are said in words before she picks a file: 150 KB to add, 1.4 MB to open, text only", () => {
  assert.equal(LIMIT_UP, 150 * 1024);
  assert.equal(LIMIT_DOWN, 1_400_000);
  assert.match(ADD_WORDS, /up to 150 KB.*ask the owner/);
  assert.match(OPEN_WORDS, /up to 1\.4 MB.*as text.*Save is not in the app yet/);
});

test("a file she picks is sent as it is, or refused in words that name the limit or the name rule", () => {
  assert.deepEqual(checkUpload({ name: "brief.txt", bytes: 10, base64: b64("hello") }), { name: "brief.txt", data: b64("hello") });
  assert.match(/** @type {any} */ (checkUpload({ name: "big.pdf", bytes: LIMIT_UP + 1, base64: "" })).error, /at most 150 KB.*ask the owner to add it/);
  for (const bad of ["../x.txt", "a/b.txt", ".hidden", "x..y", "", "trailing."]) assert.match(/** @type {any} */ (checkUpload({ name: bad, bytes: 1, base64: "" })).error, /file name is letters, numbers/, JSON.stringify(bad));
});

test("an opened file shows its text, or words saying why not", () => {
  assert.deepEqual(openedView({ name: "notes.md", data: b64("# Hello ünï") }), { name: "notes.md", text: "# Hello ünï" });
  assert.match(/** @type {any} */ (openedView({ name: "scan.pdf", data: b64("x") })).words, /does not open in the app yet/);
});
