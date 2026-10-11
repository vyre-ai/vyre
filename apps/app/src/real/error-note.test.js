import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { errorNote } from "./error-note.js";

test("a known code shows the box's words, what to do and the code", () => {
  const n = errorNote({ code: "not_found", message: "no agent kit" });
  assert.deepEqual([n.code, n.reason], ["not_found", "no agent kit"]);
  assert.match(n.recourse, /Check the name/);
  assert.equal(n.title, "Not found");
});
test("no message: the catalogue's description stands in; an unknown code still shows the code; nothing at all shows the fallback", () => {
  assert.match(errorNote({ code: "timeout" }).reason, /waited for an answer/i);
  const u = errorNote({ code: "brand_new", message: "x broke" });
  assert.deepEqual([u.code, u.reason, u.recourse, u.title], ["brand_new", "x broke", "", ""]);
  assert.equal(errorNote(null, "Backups could not be read.").reason, "Backups could not be read.");
});
