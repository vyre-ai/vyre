import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { ABOUT_MAX, PHOTO_TYPE, PROFILE_TYPE, aboutProblem, looksByName, photoCreate, photosOf, profileWrite, profilesOf } from "./profiles-model.js";
import { MEMBER_PHOTO, MEMBER_PROFILE } from "../../../../records/core-types.js";

const row = (id, data, version = 1, updated_at = 1) => ({ type: PROFILE_TYPE, id, version, data, updated_at });

test("the app writes the type the Space defines, with the fields it has", () => {
  assert.equal(PROFILE_TYPE, MEMBER_PROFILE.name);
  const fields = MEMBER_PROFILE.fields.map((f) => f.name);
  for (const k of ["person", "name", "about", "look", "photo"]) assert.ok(fields.includes(k), k);
  assert.equal(PHOTO_TYPE, MEMBER_PHOTO.name);
  const photoFields = MEMBER_PHOTO.fields.map((f) => f.name);
  for (const k of Object.keys(photoCreate("per_bob", "spc_aaaaaaaaaaaa", { base64: "AAAA", mime: "image/webp", bytes: 3 }).data)) assert.ok(photoFields.includes(k), k);
});

const PID = "0192f0aa-0000-7000-8000-000000000001";
test("a profile names its photo by record id; the faces find it by person and by a name nobody else has", () => {
  const S = "spc_aaaaaaaaaaaa";
  const byPerson = profilesOf({ rows: [row("a", { person: "p1", name: "Ana", photo: PID }), row("b", { person: "p2", name: "Sam", photo: PID.replace(/1$/, "2") }), row("c", { person: "p3", name: "sam" }), row("d", { person: "p4", name: "Lee", photo: "../../etc" })] });
  assert.equal(byPerson.p1.photo, PID);
  assert.equal(byPerson.p4.photo, "", "a photo that is not a record id is dropped");
  const got = photosOf(byPerson, S);
  assert.equal(got.p1, `vyre://${S}/member-photo/${PID}`);
  assert.equal(got.ana, got.p1, "by name");
  assert.ok(got.p2, "by person even when the name is shared");
  assert.equal(got.sam, undefined, "a shared name finds nobody's photo");
  assert.equal(got.p3, undefined, "a person with none");
});

test("a new photo is a record of its person's; the profile then names it, and taking it away empties the field", () => {
  const S = "spc_aaaaaaaaaaaa";
  assert.deepEqual(photoCreate("per_bob", S, { base64: "AAAA", mime: "image/jpeg", bytes: 3 }), { type: PHOTO_TYPE, space: S, data: { person: "per_bob", image: "AAAA", mime: "image/jpeg", bytes: 3 } });
  const cur = profilesOf({ rows: [row("r1", { person: "per_bob", name: "Bob" }, 2)] }).per_bob;
  assert.deepEqual(profileWrite(cur, "per_bob", { photo: PID }, S), { tool: "records.update", input: { urn: `vyre://${S}/${PROFILE_TYPE}/r1`, patch: { photo: PID }, base_version: 2 } });
  const withPhoto = profilesOf({ rows: [row("r1", { person: "per_bob", name: "Bob", photo: PID }, 3)] }).per_bob;
  assert.deepEqual(profileWrite(withPhoto, "per_bob", { photo: "" }, S)?.input, { urn: `vyre://${S}/${PROFILE_TYPE}/r1`, patch: { photo: "" }, base_version: 3 });
  assert.deepEqual(profileWrite(withPhoto, "per_bob", { photo: "not an id!" }, S)?.input.patch, { photo: "" }, "never anything but an id");
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
