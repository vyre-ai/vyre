import test from "node:test";
import assert from "node:assert/strict";
import { kitLibrary, kitFromLibrary } from "./library.js";

test("the library lists the Kit this build ships, with what it adds", () => {
  const lib = kitLibrary();
  const estate = lib.find((k) => k.id === "estate-planning");
  assert.ok(estate, "the estate Kit is on offer");
  assert.ok(estate.description.length > 20 && estate.version >= 1);
  assert.deepEqual(estate.adds.types.sort(), ["contact", "matter"]);
  assert.deepEqual(estate.adds.sealed_fields, ["contact.ssn"]);
  assert.equal(estate.adds.flows, 1);
});

test("a Kit from the library is in the kernel's form and a name outside the library is refused", () => {
  const k = kitFromLibrary("estate-planning");
  assert.equal(k.id, "estate-planning");
  assert.ok(k.version >= 1);
  assert.throws(() => kitFromLibrary("../x"), { code: "not_found" });
  assert.throws(() => kitFromLibrary("nope"), { code: "not_found" });
});
