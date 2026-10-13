// A new Space opens with views: Contacts and Organizations as lists, Events as a calendar. Each names only fields its type has, so the kernel's own view check (kernel/gateway/records.js) accepts it.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { CORE_TYPES } from "./core-types.js";

const VIEW_KEYS = ["name", "type", "label", "groupBy", "dateField", "columns", "filter", "sort"];
const typeOf = n => CORE_TYPES.find(t => t.name === n);

test("Contacts and Organizations open as lists, Events as a calendar on its start", () => {
  const seeds = { contact: ["list", undefined], organization: ["list", undefined], event: ["calendar", "starts_at"] };
  for (const [name, [kind, date]] of Object.entries(seeds)) {
    const t = typeOf(name);
    assert.equal(t.views?.length, 1, `${name} has one seed view`);
    assert.equal(t.views[0].type, kind);
    assert.equal(t.views[0].dateField, date);
    assert.match(t.views[0].name, /^[a-z][a-z0-9_-]*$/);
  }
});

test("every seed view names fields its type has, with the keys the kernel accepts", () => {
  for (const t of CORE_TYPES) for (const v of t.views || []) {
    const has = n => t.fields.some(f => f.name === n);
    for (const k of Object.keys(v)) assert.ok(VIEW_KEYS.includes(k), `${t.name}.${v.name}: key ${k}`);
    for (const c of v.columns || []) assert.ok(has(c), `${t.name}.${v.name} column ${c}`);
    if (v.dateField) assert.ok(["date", "datetime"].includes(t.fields.find(f => f.name === v.dateField)?.kind), `${t.name}.${v.name} dateField`);
    if (v.sort) assert.ok(has(v.sort.field));
  }
});
