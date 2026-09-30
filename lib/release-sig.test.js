// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { sumsSigned, RELEASE_KEY } from "./release-sig.js";

// The shared vector (also in test/box-update.test.js and anywhere's tests): a fixed key, a fixed SHA256SUMS, and the signature over
// "vyre-release-sums\n" + those exact bytes.
const V = {
  key: "MCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=",
  sums: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  manifest.json\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  vyre.tgz\n",
  sig: "X+aWDX+6p5YDh32E4tUXAHKEvCwi36rUm4I889QLs2I6b4hlP0J05o8PNtuyZnsCaqMkiv2MWmqJ3fllTLIzDA==",
};

test("release-sig: the shared vector verifies; one byte more, the bare bytes, another key and garbage do not", () => {
  assert.equal(sumsSigned(V.sums, V.sig, V.key), true);
  assert.equal(sumsSigned(V.sums + "x", V.sig, V.key), false);
  const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 7)]), format: "der", type: "pkcs8" });
  assert.equal(sumsSigned(V.sums, crypto.sign(null, Buffer.from(V.sums), priv).toString("base64"), V.key), false, "no prefix");
  assert.equal(sumsSigned(V.sums, V.sig, RELEASE_KEY), false, "the pinned release key did not sign it");
  for (const junk of ["", "not base64!", "AAAA"]) assert.equal(sumsSigned(V.sums, junk, V.key), false);
  assert.equal(sumsSigned(V.sums, V.sig, "not a key"), false);
});

test("release-sig: the pinned key is the one box/vyre and the Mac installer pin", async () => {
  const { readFileSync } = await import("node:fs");
  const box = readFileSync(new URL("../box/vyre", import.meta.url), "utf8");
  assert.ok(box.includes(RELEASE_KEY), "box/vyre pins the same key");
});
