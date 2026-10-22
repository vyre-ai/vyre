// The slot a person token is kept under, for a page whose origin is the string "null" (the Mac app's custom scheme): writing and reading use the same slot, and an ordinary address keeps its origin.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { tokenOrigin, tokenSlots } from "./token-origin.ts";

test("a token kept under the origin \"null\" is read back from the same slot, and a web address keeps its origin", () => {
  const written = tokenOrigin("null");
  const read = tokenOrigin("null");
  assert.equal(written, "null");
  assert.equal(`token:${written}`, `token:${read}`);
  assert.equal(tokenOrigin("https://web.vyre.run/app?x=1"), "https://web.vyre.run");
  assert.equal(tokenOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.equal(tokenOrigin("vyreapp://box"), "null", "a custom-scheme address has the opaque origin");
});

test("two paired servers keep two token slots, and a token from before routes is still read", () => {
  const page = "https://web.vyre.run";
  assert.deepEqual(tokenSlots("route-a", page), ["route-a", page]);
  assert.deepEqual(tokenSlots("route-b", page), ["route-b", page]);
  assert.notDeepEqual(tokenSlots("route-a", page)[0], tokenSlots("route-b", page)[0]);
  assert.deepEqual(tokenSlots(page, page), [page]);
  assert.deepEqual(tokenSlots("", page), [page]);
  assert.deepEqual(tokenSlots(null, page), [page]);
});
