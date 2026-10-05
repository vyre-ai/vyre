// @ts-check
// The three signature schemes on their own.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verify, sign, TOLERANCE_S } from "./verify.js";

const SECRET = "whsec_northwind_test_4f1a9c2e7b";
const BODY = Buffer.from(JSON.stringify({ order: 1041, customer: "alex@example.com", items: ["rye loaf"] }));
const NOW = Date.parse("2026-09-27T09:00:00Z");
const T = Math.floor(NOW / 1000);

test("hmac-sha256: hex over the raw body in the named header", () => {
  const route = { scheme: "hmac-sha256", header: "x-northwind-signature" };
  assert.deepEqual(verify(route, { "x-northwind-signature": sign("hmac-sha256", SECRET, BODY) }, BODY, SECRET, NOW), { ok: true });
  assert.deepEqual(verify(route, { "x-northwind-signature": sign("hmac-sha256", SECRET, BODY).toUpperCase() }, BODY, SECRET, NOW), { ok: true }, "hex is case-insensitive");
  assert.equal(verify(route, { "x-northwind-signature": sign("hmac-sha256", "another", BODY) }, BODY, SECRET, NOW).ok, false);
  assert.equal(verify(route, { "x-northwind-signature": sign("hmac-sha256", SECRET, BODY) }, Buffer.from(BODY.toString() + " "), SECRET, NOW).ok, false, "one byte more");
  assert.match(/** @type {any} */ (verify(route, {}, BODY, SECRET, NOW)).why, /no x-northwind-signature header/);
  assert.equal(verify(route, { "x-northwind-signature": "zz" }, BODY, SECRET, NOW).ok, false);
});

test("github: X-Hub-Signature-256 sha256=<hex>", () => {
  const route = { scheme: "github" };
  assert.deepEqual(verify(route, { "x-hub-signature-256": sign("github", SECRET, BODY) }, BODY, SECRET, NOW), { ok: true });
  assert.equal(verify(route, { "x-hub-signature-256": sign("hmac-sha256", SECRET, BODY) }, BODY, SECRET, NOW).ok, false, "bare hex without sha256=");
  assert.equal(verify(route, { "x-hub-signature-256": sign("github", "wrong", BODY) }, BODY, SECRET, NOW).ok, false);
  // The old SHA-1 header is not a signature this route reads.
  const sha1 = "sha1=" + crypto.createHmac("sha1", SECRET).update(BODY).digest("hex");
  assert.equal(verify(route, { "x-hub-signature": sha1 }, BODY, SECRET, NOW).ok, false);
});

test("stripe: t= and v1= over t.body, five minutes either way, and a replayed timestamp is refused", () => {
  const route = { scheme: "stripe" };
  assert.deepEqual(verify(route, { "stripe-signature": sign("stripe", SECRET, BODY, T) }, BODY, SECRET, NOW), { ok: true });
  assert.deepEqual(verify(route, { "stripe-signature": sign("stripe", SECRET, BODY, T - TOLERANCE_S) }, BODY, SECRET, NOW), { ok: true }, "at the edge");
  const old = /** @type {any} */ (verify(route, { "stripe-signature": sign("stripe", SECRET, BODY, T - TOLERANCE_S - 1) }, BODY, SECRET, NOW));
  assert.equal(old.ok, false);
  assert.match(old.why, /more than 5 minutes/);
  assert.equal(verify(route, { "stripe-signature": sign("stripe", SECRET, BODY, T + 400) }, BODY, SECRET, NOW).ok, false, "from the future");
  // A signature for one timestamp does not hold for another: the timestamp is signed.
  const v1 = sign("stripe", SECRET, BODY, T - 3600).split("v1=")[1];
  assert.equal(verify(route, { "stripe-signature": `t=${T},v1=${v1}` }, BODY, SECRET, NOW).ok, false);
  // Two v1 while a secret is rolled: either may match.
  const good = sign("stripe", SECRET, BODY, T).split("v1=")[1];
  assert.deepEqual(verify(route, { "stripe-signature": `t=${T},v1=${"0".repeat(64)},v1=${good},v0=abc` }, BODY, SECRET, NOW), { ok: true });
  assert.equal(verify(route, { "stripe-signature": `t=${T},t=${T},v1=${good}` }, BODY, SECRET, NOW).ok, false, "two timestamps");
  assert.equal(verify(route, { "stripe-signature": `v1=${good}` }, BODY, SECRET, NOW).ok, false, "no timestamp");
  assert.equal(verify(route, { "stripe-signature": `t=${T}` }, BODY, SECRET, NOW).ok, false, "no v1");
});

test("a refusal never carries the secret or the signature it expected", () => {
  const cases = [
    [{ scheme: "hmac-sha256", header: "x-sig" }, { "x-sig": "00" }],
    [{ scheme: "github" }, { "x-hub-signature-256": "sha256=" + "1".repeat(64) }],
    [{ scheme: "stripe" }, { "stripe-signature": `t=${T},v1=${"2".repeat(64)}` }],
    [{ scheme: "none" }, {}],
  ];
  for (const [route, headers] of cases) {
    const r = verify(route, headers, BODY, SECRET, NOW);
    const text = JSON.stringify(r);
    assert.equal(r.ok, false);
    assert.ok(!text.includes(SECRET), text);
    for (const s of ["hmac-sha256", "github"]) assert.ok(!text.includes(sign(s, SECRET, BODY).replace("sha256=", "")), text);
    assert.ok(!text.includes(sign("stripe", SECRET, BODY, T).split("v1=")[1]), text);
  }
  assert.equal(verify({ scheme: "github" }, { "x-hub-signature-256": sign("github", "", BODY) }, BODY, "", NOW).ok, false, "an empty secret checks nothing");
});
