// @ts-check
// The sites of a login (core/vault/sites.js): bare https origins from its saved addresses, never a path, a login or a value.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sitesOf } from "./sites.js";

test("a login's saved addresses become bare https origins, deduplicated; nothing else", () => {
  assert.deepEqual(sitesOf({ url: "https://portal.example.test/login?x=1" }), ["https://portal.example.test"]);
  assert.deepEqual(sitesOf({ url: "https://a.example.test/x", urls: "https://a.example.test/y, https://b.example.test\nhttps://c.example.test:8443/z" }), ["https://a.example.test", "https://b.example.test", "https://c.example.test:8443"]);
  assert.deepEqual(sitesOf({ url: "http://plain.example.test", website: "https://user:pw@x.example.test", origin: "not an address", password: "https://secret.example.test" }), [], "http, a login in the address, junk and other fields are not sites");
  assert.deepEqual(sitesOf({}), []);
  assert.deepEqual(sitesOf(undefined), []);
  assert.equal(sitesOf({ urls: Array.from({ length: 30 }, (_, i) => `https://h${i}.example.test`).join(" ") }).length, 10, "capped");
});
