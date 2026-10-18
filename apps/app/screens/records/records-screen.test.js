// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { needsIdFill } from "./records-screen.js";

const withRef = { name: "contact", fields: [{ name: "name" }, { name: "ref" }] };

test("opening a type asks for the older records' IDs only for a person who may define, only when a record lacks one", () => {
  const bare = [{ data: { name: "A", ref: "PER-0001" } }, { data: { name: "B" } }];
  assert.equal(needsIdFill({ def: withRef, rows: bare, canDefine: true }), true);
  assert.equal(needsIdFill({ def: withRef, rows: bare, canDefine: false }), false, "a member is not asked: the define is not theirs");
  assert.equal(needsIdFill({ def: withRef, rows: [{ data: { name: "A", ref: "PER-0001" } }], canDefine: true }), false, "every record has one");
  assert.equal(needsIdFill({ def: { name: "plain", fields: [{ name: "name" }] }, rows: bare, canDefine: true }), false, "a type without an ID field");
  assert.equal(needsIdFill({ def: undefined, rows: bare, canDefine: true }), false);
  assert.equal(needsIdFill({ def: withRef, rows: [], canDefine: true }), false);
});
