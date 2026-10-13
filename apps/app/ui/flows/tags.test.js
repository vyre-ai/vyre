import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTags, tagLabel, tagToken } from "./tags.js";

test("a pick makes the token the engine resolves, and the token reads in words", () => {
  const toks = [tagToken({ kind: "this" }), tagToken({ kind: "field", field: "client" }), tagToken({ kind: "records", type: "matter" }), tagToken({ kind: "file", path: "docs/a.pdf" }), tagToken({ kind: "record", urn: "vyre://s/matter/m1" })];
  assert.deepEqual(toks, ["[[record:this]]", "[[field:this#client]]", "[[records:matter]]", "[[file:docs/a.pdf]]", "[[record:vyre://s/matter/m1]]"]);
  const types = [{ name: "matter", label: "Matter" }];
  assert.deepEqual(parseTags(toks.join(" ")).map((t) => tagLabel(t, { types })), ["This record", "client of this record", "Several Matter records", "File docs/a.pdf", "Record matter/m1"]);
});
