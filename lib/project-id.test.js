// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { SLUG_RE, slugify, isProjectId } from "./project-id.js";

test("slugify: the canonical shape", () => {
  assert.equal(slugify("Harlow Legal"), "harlow-legal");
  assert.equal(slugify("Smith & Barrett"), "smith-and-barrett");
  assert.equal(slugify("  --Weird__Chars!!  "), "weird-chars");
  assert.equal(slugify(""), "");
  assert.equal(slugify(undefined), "");
});

test("isProjectId: accepts slugify's own output, refuses everything slugify would change", () => {
  for (const name of ["Harlow Legal", "Northwind Bakery", "Smith & Barrett", "a", "a1-b2"]) {
    const s = slugify(name);
    assert.ok(isProjectId(s), `slugify(${JSON.stringify(name)}) = ${JSON.stringify(s)} should be a project id`);
  }
  for (const bad of ["", "Harlow Legal", "-harlow", "harlow-", "harlow--legal", "harlow_legal", null, undefined, 42]) {
    assert.equal(isProjectId(/** @type {any} */ (bad)), false, JSON.stringify(bad));
  }
});

test("SLUG_RE matches isProjectId exactly", () => {
  for (const v of ["harlow-legal", "a", "a1-b2-c3", "harlow--legal", "-harlow", ""]) {
    assert.equal(SLUG_RE.test(v), isProjectId(v));
  }
});
