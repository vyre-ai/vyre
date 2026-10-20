import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createPhotoCache, dataUri, photoRef, picture } from "./photo-model.js";

const URN = "vyre://spc_aaaaaaaaaaaa/member-photo/0192f0aa-0000-7000-8000-000000000001";
const URI = "data:image/webp;base64,UklGRg==";
const photos = { per_bob: URN, bob: URN };

test("a person's face finds their photo by id, else by name; an agent, the assistant and a teammate never do", () => {
  assert.equal(photoRef({ kind: "person", id: "per_bob", name: "Someone" }, photos), URN, "by id");
  assert.equal(photoRef({ kind: "person", id: "bob-slug", name: "Bob" }, photos), URN, "by name");
  assert.equal(photoRef({ kind: "person", id: "per_dan", name: "Dan" }, photos), "", "a person with none");
  for (const kind of ["agent", "assistant", "teammate"]) assert.equal(photoRef({ kind, id: "per_bob", name: "Bob" }, photos), "", kind);
  assert.equal(photoRef({ kind: "person", id: "per_bob", name: "Bob" }, photos, true), "", "the look picker asks for the look itself");
});

test("the Avatar draws the photo when the person has one and it is here, and the face otherwise", () => {
  const bob = { kind: "person", id: "per_bob", name: "Bob" };
  assert.deepEqual(picture(bob, URI), { photo: URI }, "the photo");
  assert.deepEqual(picture(bob, ""), { face: true }, "no photo, or not here yet: the face, in the same box");
  assert.deepEqual(picture(bob, undefined), { face: true });
  assert.deepEqual(picture({ kind: "agent", id: "a", name: "Bob" }, URI), { face: true }, "an agent keeps its look");
  assert.deepEqual(picture(bob, URI, true), { face: true }, "the look picker's preview");
  assert.deepEqual(picture(bob, "https://example.com/me.png"), { face: true }, "never a web address: only a picture the Space holds");
});

test("a photo record reads as a data address, and a wiped or odd one as nothing", () => {
  assert.equal(dataUri({ record: { data: { image: "UklGRg==", mime: "image/webp" } } }), URI);
  assert.equal(dataUri({ record: { data: { image: "", mime: "image/webp" } } }), "", "wiped");
  assert.equal(dataUri({ record: { data: { image: "PHN2Zz4=", mime: "image/svg+xml" } } }), "", "not a kind it draws");
  assert.equal(dataUri({ record: { data: { image: "<script>", mime: "image/png" } } }), "", "not base64");
  assert.equal(dataUri({ record: null }), "");
  assert.equal(dataUri(undefined), "");
});

test("each photo is read once: faces asking at once share the read, a failed read is not asked again for every row, and the oldest go first", async () => {
  const cache = createPhotoCache({ max: 2 });
  let reads = 0;
  const read = async (/** @type {string} */ ref) => { reads++; if (ref === "bad") throw new Error("gone"); return `data:image/jpeg;base64,${ref}`; };
  const [a, b] = await Promise.all([cache.load("A", read), cache.load("A", read)]);
  assert.equal(a, "data:image/jpeg;base64,A");
  assert.equal(b, a);
  assert.equal(reads, 1, "one read for two faces");
  assert.equal(await cache.load("A", read), a);
  assert.equal(reads, 1, "kept");
  assert.equal(await cache.load("bad", read), "");
  assert.equal(await cache.load("bad", read), "");
  assert.equal(reads, 2, "a failed read is kept as nothing");
  await cache.load("C", read);
  assert.equal(cache.size(), 2);
  assert.equal(cache.get("A"), undefined, "the oldest left");
  cache.put("mine", URI);
  assert.equal(cache.get("mine"), URI, "the person's own new photo shows at once");
});
