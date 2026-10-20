// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { needsIdFill, defineInputOf } from "./records-screen.js";
import { CORE_TYPES } from "../../../../records/core-types.js";

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

test("a type as the box lists it is a valid define input again: nothing a listing adds, everything the type is", () => {
  const listed = { ...CORE_TYPES.find((t) => t.name === "contact"), system: false, version: 7, space: "spc_aaaaaaaaaaaa", count: 12 };
  const input = defineInputOf(listed);
  for (const k of ["system", "version", "space", "count"]) assert.equal(k in input, false, `${k} is left out`);
  const kept = CORE_TYPES.find((t) => t.name === "contact");
  assert.deepEqual(input, JSON.parse(JSON.stringify(kept)), "name, label, icon, fields and views are what the type is");
  assert.deepEqual(defineInputOf(null), {});
  assert.ok(input.fields.some((/** @type {any} */ f) => f.name === "ref" && f.read_only === true && f.unique === true), "the ID field keeps its marks");
});

test("Records opens with People, Companies, Tasks and Notes, then the rest in the Space's order, none added or dropped", async () => {
  const { tabOrder } = await import("./records-screen.js");
  const t = (/** @type {string} */ name) => ({ name });
  assert.deepEqual(tabOrder([t("deal"), t("note"), t("contact"), t("event"), t("task"), t("organization")]).map((x) => x.name), ["contact", "organization", "task", "note", "deal", "event"]);
  assert.deepEqual(tabOrder([t("deal")]).map((x) => x.name), ["deal"]);
  assert.deepEqual(tabOrder(/** @type {any} */ (undefined)), []);
});
