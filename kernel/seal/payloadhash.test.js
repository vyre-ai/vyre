// @ts-check
// The nested payload hash (reviewer-2's WH-1): `fields` sits NESTED in the hashed object, so a field named op or space can never stand for the real one. The vector file is shared with native-core's
// signer and app-wire's apps/app/src/real/payload-hash.js: each asserts its own implementation against it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { payloadHash, canonical } from "./wire.js";

const file = JSON.parse(fs.readFileSync(new URL("./payloadhash-vectors.json", import.meta.url), "utf8"));

test("payloadHash reproduces every shared vector, canonical form included", () => {
  assert.ok(file.vectors.length >= 7);
  for (const v of file.vectors) {
    assert.equal(canonical({ op: v.op, space: v.space, fields: v.fields }), v.canonical, v.name);
    assert.equal(payloadHash(v.op, v.space, v.fields), v.hash, v.name);
  }
});

test("a field named op or space cannot change what the hash is about", () => {
  const spoof = payloadHash("grant.role", "spc_aaaaaaaaaaaa", { op: "grant.invite", space: "spc_bbbbbbbbbbbb" });
  assert.notEqual(spoof, payloadHash("grant.invite", "spc_bbbbbbbbbbbb", {}), "the old flat form made these equal");
  assert.notEqual(spoof, payloadHash("grant.role", "spc_aaaaaaaaaaaa", {}));
  assert.equal(new Set(file.vectors.map((/** @type {any} */ v) => v.hash)).size, file.vectors.length, "every vector hashes differently");
});
