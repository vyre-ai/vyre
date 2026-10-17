// The slot a person token is kept under, for a page whose origin is the string "null" (the Mac app's custom scheme): writing and reading use the same slot, and an ordinary address keeps its origin.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { tokenOrigin } from "./token-origin.ts";

test("a token kept under the origin \"null\" is read back from the same slot, and a web address keeps its origin", () => {
  const written = tokenOrigin("null");
  const read = tokenOrigin("null");
  assert.equal(written, "null");
  assert.equal(`token:${written}`, `token:${read}`);
  assert.equal(tokenOrigin("https://web.vyre.run/app?x=1"), "https://web.vyre.run");
  assert.equal(tokenOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.equal(tokenOrigin("vyreapp://box"), "null", "a custom-scheme address has the opaque origin");
});
