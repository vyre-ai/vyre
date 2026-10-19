import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { ABOUT_MAX, PROFILE_TYPE, aboutProblem, looksByName, profileWrite, profilesOf } from "./profiles-model.js";
import { MEMBER_PROFILE } from "../../../../records/core-types.js";

const row = (id, data, version = 1, updated_at = 1) => ({ type: PROFILE_TYPE, id, version, data, updated_at });

test("the app writes the type the Space defines, with the fields it has", () => {
  assert.equal(PROFILE_TYPE, MEMBER_PROFILE.name);
  const fields = MEMBER_PROFILE.fields.map((f) => f.name);
  for (const k of ["person", "name", "about", "look"]) assert.ok(fields.includes(k), k);
});

test("one profile per person, the last saved, and nothing made up from a broken row", () => {
  const got = profilesOf({ rows: [row("a", { person: "per_bob", about: "old" }, 1, 10), row("b", { person: "per_bob", about: "new", look: "s3~c5" }, 2, 20), row("c", { about: "nobody" }), row("d", { person: "per_dan", look: "not a look" }), null] });
  assert.deepEqual(Object.keys(got).sort(), ["per_bob", "per_dan"]);
  assert.equal(got.per_bob.about, "new");
  assert.equal(got.per_bob.look, "s3~c5");
  assert.equal(got.per_dan.look, "", "a look that is not a seed is dropped");
  assert.deepEqual(profilesOf(undefined), {});
});

test("a face drawn by name finds the look, unless two people share the name", () => {
  const byPerson = profilesOf({ rows: [row("a", { person: "p1", name: "Ana", look: "s1~c1" }), row("b", { person: "p2", name: "Sam", look: "s2~c2" }), row("c", { person: "p3", name: "sam", look: "s3~c3" })] });
  assert.deepEqual(looksByName(byPerson), { ana: "s1~c1" });
});

test("About me: up to its length, and no control characters", () => {
  assert.equal(aboutProblem("I run intake and billing."), "");
  assert.equal(aboutProblem("Line one\nLine two"), "");
  assert.match(aboutProblem("x".repeat(ABOUT_MAX + 1)), /Keep it to/);
  assert.match(aboutProblem("a\u0007b"), /special/);
});

test("a save makes the record once, then changes only what changed, against the version it read", () => {
  const first = profileWrite(null, "per_bob", { name: "Bob", about: " Runs intake ", look: "s3~c5" }, "spc_aaaaaaaaaaaa");
  assert.deepEqual(first, { tool: "records.create", input: { type: PROFILE_TYPE, space: "spc_aaaaaaaaaaaa", data: { person: "per_bob", name: "Bob", about: "Runs intake", look: "s3~c5" } } });
  const cur = profilesOf({ rows: [row("r1", first.input.data, 4)] }).per_bob;
  assert.equal(profileWrite(cur, "per_bob", { name: "Bob", about: "Runs intake" }, "spc_aaaaaaaaaaaa"), null, "nothing changed");
  assert.deepEqual(profileWrite(cur, "per_bob", { about: "Runs intake and billing" }, "spc_aaaaaaaaaaaa"), { tool: "records.update", input: { urn: `vyre://spc_aaaaaaaaaaaa/${PROFILE_TYPE}/r1`, patch: { about: "Runs intake and billing" }, base_version: 4 } });
});
