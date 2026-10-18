// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultScope, filterByScope, scopeFilter, scopeNote, scopesFor } from "./scope-views.js";

const rows = [
  { id: "1", data: { owner: "person:me1", visibility: "private" } },
  { id: "2", data: { owner: "person:other", visibility: "space" } },
  { id: "3", data: { visibility: "record" } },
];

test("each type offers its own scopes", () => {
  assert.deepEqual(scopesFor("note").map(([k]) => k), ["mine", "shared", "space"]);
  assert.deepEqual(scopesFor("communication").map(([k]) => k), ["mine", "visible"]);
  assert.deepEqual(scopesFor("event").map(([k]) => k), ["mine", "team", "everyone"]);
  assert.deepEqual(scopesFor("deal"), []);
});

test("Mine is what I own, Shared and Team are what I do not, Space is visibility space", () => {
  assert.deepEqual(filterByScope(rows, "mine", "me1").map((r) => r.id), ["1"]);
  assert.deepEqual(filterByScope(rows, "mine", "person:me1").map((r) => r.id), ["1"]);
  assert.deepEqual(filterByScope(rows, "shared", "me1").map((r) => r.id), ["2", "3"]);
  assert.deepEqual(filterByScope(rows, "team", "me1").map((r) => r.id), ["2", "3"]);
  assert.deepEqual(filterByScope(rows, "space", "me1").map((r) => r.id), ["2"]);
});

test("Everyone and On records I can see keep every row; with no me, Mine is empty", () => {
  assert.equal(filterByScope(rows, "everyone", "me1").length, 3);
  assert.equal(filterByScope(rows, "visible", "me1").length, 3);
  assert.deepEqual(filterByScope(rows, "mine", undefined), []);
});

test("Notes and Communications open on Mine, Events on Team", () => {
  assert.equal(defaultScope("note"), "mine");
  assert.equal(defaultScope("communication"), "mine");
  assert.equal(defaultScope("event"), "team");
  assert.equal(defaultScope("deal"), "");
});

test("a scope is cut on the box with $me and visibility", () => {
  assert.deepEqual(scopeFilter("mine"), { field: "owner", op: "eq", value: "$me" });
  assert.deepEqual(scopeFilter("team"), { field: "owner", op: "ne", value: "$me" });
  assert.deepEqual(scopeFilter("shared"), { field: "owner", op: "ne", value: "$me" });
  assert.deepEqual(scopeFilter("space"), { field: "visibility", op: "eq", value: "space" });
  assert.equal(scopeFilter("everyone"), undefined);
  assert.equal(scopeFilter("visible"), undefined);
});

test("Events say what each tab shows; other types say nothing", () => {
  assert.match(scopeNote("event", "team"), /Busy/);
  assert.equal(scopeNote("note", "mine"), "");
});
