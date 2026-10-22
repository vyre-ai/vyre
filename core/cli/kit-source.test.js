// @ts-check
// Reading a Kit from a file on this computer and from an address, without a network: the fetch is
// an argument, and the address path is also proved against lib/http's own test seam.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { testHooks } from "../../lib/http.js";
import { readKit, tokenRef, vaultToken } from "./kit-source.js";

const KIT = { format: 1, id: "demo-kit", version: 1, name: "Demo Kit", includes: {} };

/** A folder of its own under the checkout's scratch, so nothing is left behind. */
const folder = () => fs.mkdtempSync(path.join(SCRATCH, "kit-source-"));
const file = (/** @type {string} */ dir, /** @type {string} */ name, /** @type {string} */ text) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text);
  return p;
};

test("a Kit is read from a file on this computer", async () => {
  const dir = folder();
  try {
    const p = file(dir, "kit.json", JSON.stringify(KIT));
    const got = await readKit(p);
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.kit.id, "demo-kit");
    assert.equal(got.source, p);
    assert.equal(got.kind, "file");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a file that is not there, or not a Kit, is said in plain words", async () => {
  const dir = folder();
  try {
    const missing = await readKit(path.join(dir, "no-such-kit-file.json"));
    assert.equal(missing.ok, false);
    assert.match(missing.why, /no Kit at/);
    assert.equal(missing.code, "not_found");
    const p = file(dir, "bad.json", "not json at all");
    const bad = await readKit(p);
    assert.equal(bad.ok, false);
    assert.match(bad.why, /not JSON/);
    assert.equal(bad.code, "bad_input");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a Kit is fetched from an https address, with the token in the request's own header", async () => {
  const seen = /** @type {any[]} */ ([]);
  const got = await readKit("https://example.com/kit.json", {
    token: async () => ({ ok: true, value: "s3cret" }),
    fetch: async (/** @type {string} */ url, /** @type {any} */ init) => { seen.push([url, init]); return { ok: true, status: 200, text: async () => JSON.stringify(KIT) }; },
  });
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.equal(got.kit.id, "demo-kit");
  assert.equal(got.source, "https://example.com/kit.json");
  assert.equal(got.kind, "url");
  assert.equal(seen[0][0], "https://example.com/kit.json");
  assert.deepEqual(seen[0][1].headers, { authorization: "Bearer s3cret" });
});

test("a token is asked for only when the source is an address", async () => {
  const dir = folder();
  try {
    let asked = 0;
    const p = file(dir, "kit.json", JSON.stringify(KIT));
    const got = await readKit(p, { token: async () => { asked++; return { ok: true, value: "s3cret" }; } });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(asked, 0, "a file needs no token");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the address is fetched with lib/http's own client, so the rules of that client hold", async (t) => {
  testHooks.fetch = async () => new Response(JSON.stringify(KIT), { status: 200 });
  t.after(() => { testHooks.fetch = null; });
  const got = await readKit("https://example.com/kit.json");
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.equal(got.kit.id, "demo-kit");
  assert.equal(got.source, "https://example.com/kit.json");
});

test("an address that is not https is refused before anything is fetched", async () => {
  let called = 0;
  const got = await readKit("http://example.com/kit.json", { fetch: async () => { called++; return { ok: true, status: 200, text: async () => "{}" }; } });
  assert.equal(got.ok, false);
  assert.match(got.why, /https/);
  assert.equal(got.code, "bad_input");
  assert.equal(called, 0, "nothing was fetched");
});

test("an address that answers with nothing is said in plain words", async () => {
  const got = await readKit("https://example.com/kit.json", { fetch: async () => ({ ok: false, status: 404, text: async () => "" }) });
  assert.equal(got.ok, false);
  assert.match(got.why, /404/);
  assert.equal(got.code, "not_found");
});

test("an address that does not answer is out of reach", async () => {
  const got = await readKit("https://example.com/kit.json", { fetch: async () => { throw new Error("connection refused"); } });
  assert.equal(got.ok, false);
  assert.match(got.why, /cannot reach/);
  assert.equal(got.code, "unreachable");
});

test("an answer that is too large is said as it is, not as an address out of reach", async () => {
  const got = await readKit("https://example.com/kit.json", { fetch: async () => { throw Object.assign(new Error("the answer is over the 1048576-byte limit"), { code: "too_large" }); } });
  assert.equal(got.ok, false);
  assert.equal(got.code, "too_large");
  assert.match(got.why, /too large/);
  assert.doesNotMatch(got.why, /cannot reach/);
});

test("a token comes from the Vault, and a reference that is not one is refused", async () => {
  const v = await vaultToken("vault://item/field", { resolve: async (/** @type {string} */ ref) => ({ data: { values: { [ref]: "s3cret" } } }) });
  assert.deepEqual(v, { ok: true, value: "s3cret" });
  const locked = await vaultToken("vault://item/field", { resolve: async () => ({ error: { code: "locked", message: "the vault is locked" } }) });
  assert.equal(locked.ok, false);
  assert.equal(locked.code, "locked");
  const bad = await vaultToken("not-a-reference", { resolve: async () => ({ data: { values: {} } }) });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "bad_input");
  assert.ok(!JSON.stringify(bad).includes("s3cret"), "a refusal never repeats the value");
});

test("a reference is named as vault://item/field, and nothing else", () => {
  assert.deepEqual(tokenRef("vault://item/field"), { ok: true, ref: "vault://item/field" });
  const bad = tokenRef("https://example.com/kit.json");
  assert.equal(bad.ok, false);
  assert.match(bad.why, /vault:\/\/item\/field/);
});
