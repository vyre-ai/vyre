// @ts-check
// The rules for where a Kit may come from: a file path or an https address, never a secret.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSource, looksLikeSource, MAX_SOURCE } from "./kit-source.js";

test("a source is a file path or an https address", () => {
  assert.deepEqual(checkSource("/tmp/kit.json"), { ok: true, kind: "file", source: "/tmp/kit.json" });
  assert.deepEqual(checkSource("kit.json"), { ok: true, kind: "file", source: "kit.json" });
  assert.deepEqual(checkSource("https://example.com/kit.json"), { ok: true, kind: "url", source: "https://example.com/kit.json" });
  assert.deepEqual(checkSource("  https://example.com/kit.json  "), { ok: true, kind: "url", source: "https://example.com/kit.json" });
});

test("a source carries no name, no password and no scheme but https", () => {
  for (const bad of ["http://example.com/kit.json", "ftp://example.com/kit.json", "https://user:pass@example.com/kit.json", "https://someone@example.com/kit.json", "someone@example.com"]) {
    const r = checkSource(bad);
    assert.equal(r.ok, false, bad);
    assert.match(r.why, /https|password/, bad);
  }
});

test("an address with a query or a fragment is refused: it can carry a key, and the source is kept", () => {
  for (const bad of ["https://example.com/kit.json?token=abc", "https://example.com/kit.json#abc"]) {
    const r = checkSource(bad);
    assert.equal(r.ok, false, bad);
    assert.match(r.why, /query or a fragment/, bad);
  }
});

test("a source is there, and it is short", () => {
  assert.equal(checkSource("").ok, false);
  assert.equal(checkSource("   ").ok, false);
  assert.equal(checkSource(42).ok, false);
  assert.equal(checkSource("x".repeat(MAX_SOURCE + 1)).ok, false);
  assert.equal(checkSource("x".repeat(MAX_SOURCE)).ok, true);
});

test("a source may not carry control characters: they are invisible and they end a line", () => {
  for (const bad of ["/tmp/kit\n.json", "/tmp/kit\u0000.json", "/tmp/kit\t.json"]) {
    const r = checkSource(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.why, /control characters/, JSON.stringify(bad));
  }
  assert.equal(checkSource("/tmp/kit.json").ok, true);
});

test("a scheme that is not https at all is refused as a source", () => {
  const r = checkSource("vault://item/field");
  assert.equal(r.ok, false);
  assert.match(r.why, /file path or an https address/);
});

test("a word with no path in it is a Kit of the library; a path or an address is a source", () => {
  assert.equal(looksLikeSource("base"), false);
  assert.equal(looksLikeSource("starter-kit"), false);
  assert.equal(looksLikeSource(""), false);
  assert.equal(looksLikeSource("kit.json"), true);
  assert.equal(looksLikeSource("./kit.json"), true);
  assert.equal(looksLikeSource("/tmp/kit.json"), true);
  assert.equal(looksLikeSource("https://example.com/kit.json"), true);
});
