// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { columnCall, madeName, promoteCall } from "./add-column.js";

test("a plain kind is a fast field, a link is a link with its twin", () => {
  assert.deepEqual(columnCall("deal", { label: " Budget ", kind: "number" }), { tool: "records.field.add", input: { type: "deal", label: "Budget", kind: "number" } });
  assert.deepEqual(columnCall("deal", { label: "Partner", kind: "link", to: "organization", many: true }), { tool: "records.link.add", input: { type: "deal", label: "Partner", to: "organization", many: true } });
  assert.deepEqual(columnCall("deal", { label: "Source", kind: "choice", options: "Ad, Referral , " }), { tool: "records.field.add", input: { type: "deal", label: "Source", kind: "choice", options: ["Ad", "Referral"] } });
});

test("what is missing is said in a sentence", () => {
  assert.match(/** @type {any} */ (columnCall("deal", { label: "", kind: "text" })).problem, /Name/);
  assert.match(/** @type {any} */ (columnCall("deal", { label: "X", kind: "link" })).problem, /type it links to/);
  assert.match(/** @type {any} */ (columnCall("deal", { label: "X", kind: "choice", options: "one" })).problem, /two options/);
  assert.match(/** @type {any} */ (columnCall("deal", { label: "X", kind: "zzz" })).problem, /kind/);
});

test("the made field's name is found in either answer shape", () => {
  assert.equal(madeName({ field: { name: "budget" } }), "budget");
  assert.equal(madeName({ name: "partner" }), "partner");
  assert.equal(madeName(undefined), undefined);
});

test("a fast field is made real in the background after it is added; a link needs nothing more", () => {
  const add = /** @type {any} */ (columnCall("deal", { label: "Budget", kind: "number" }));
  assert.deepEqual(promoteCall("deal", add, { field: { name: "budget", state: "bag" } }), { tool: "records.field.promote", input: { type: "deal", name: "budget" } });
  assert.equal(promoteCall("deal", /** @type {any} */ (columnCall("deal", { label: "Partner", kind: "link", to: "organization" })), { field: { name: "partner" } }), null);
  assert.equal(promoteCall("deal", add, {}), null, "no field named, nothing to promote");
  assert.equal(promoteCall("deal", add, { field: { name: "budget", state: "real" } }), null);
});
