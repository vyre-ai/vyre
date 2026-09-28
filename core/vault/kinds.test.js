// @ts-check
// Typed credentials (ADR 0028): kinds, the field each hands over, details that list and never
// carry a value, Watchtower's expired and expiring, and passkeys that never leave vyred.
// Every value here is a made-up sample.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { recorded } from "./testing.js";
import { KINDS, SPEC, defaultField, checkFields, cleanDetails, derivedDetails, PERSONAL_KINDS } from "./kinds.js";
import { judge } from "./health.js";

// A throwaway self-signed certificate for intake.harlow.test, public half only.
const CERT = `-----BEGIN CERTIFICATE-----
MIIBjzCCATWgAwIBAgIUCX+ogGnhFO9OIoJ0CcnIFng+xAswCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSaW50YWtlLmhhcmxvdy50ZXN0MB4XDTI2MDkyNzEwNTMwNloX
DTI2MTAyNzEwNTMwNlowHTEbMBkGA1UEAwwSaW50YWtlLmhhcmxvdy50ZXN0MFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFp/SmnisERYciTL+sp76Wpq/raeP3sxk
k/KcFiMwnhyHpD3lxv5AEFtcGB8bwqfd5quPjYFm+5Org1MFasyXPaNTMFEwHQYD
VR0OBBYEFNSLP2zEPS8nJJzncfBLVXDuDcrcMB8GA1UdIwQYMBaAFNSLP2zEPS8n
JJzncfBLVXDuDcrcMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIg
a6ulQ32+WsmMA1A+ob9qzPFaZeDhymtA4Vhf1B5gD88CIQC9IVGz3M9h2DClXj+J
NS4bWmb8lnXfX4ZBXO6UXs3qAw==
-----END CERTIFICATE-----`;
const hex = n => crypto.randomBytes(n).toString("hex");

test("kinds: every kind has a spec; the field handed over; what each needs", () => {
  for (const k of KINDS) assert.ok(SPEC[k], k);
  assert.equal(defaultField("pat"), "token");
  assert.equal(defaultField("oauth", ["client_id", "refresh_token"]), "refresh_token");
  assert.equal(defaultField("cloud", ["access_key_id", "secret_access_key"]), "secret_access_key");
  assert.equal(defaultField("cloud", ["json"]), "json");
  assert.equal(defaultField("env-set"), null);
  assert.equal(defaultField("passkey"), null);
  assert.equal(defaultField("address"), null);
  assert.throws(() => checkFields("pat", { username: "kit" }), /a pat needs a token/);
  assert.throws(() => checkFields("oauth", { client_id: "x" }), /needs one of token, access_token/);
  assert.throws(() => checkFields("nope", {}), /kind must be one of/);
  checkFields("login", { username: "alex" });
  assert.ok(PERSONAL_KINDS.includes("authenticator") && PERSONAL_KINDS.includes("wifi") && !PERSONAL_KINDS.includes("pat"));
});

test("kinds: details are checked by name, and derived from fields without any value", () => {
  assert.deepEqual(cleanDetails({ scope: ["repo", "workflow", "repo"], provider: "github", expires: 1800000000000 }),
    { scope: ["repo", "workflow"], provider: "github", expires: 1800000000000 });
  assert.throws(() => cleanDetails({ password: "x" }), /details.password is not one of/);
  assert.throws(() => cleanDetails({ provider: "GitHub Inc!" }), /not a usable provider/);
  assert.throws(() => cleanDetails([]), /details must be an object/);
  assert.equal(derivedDetails("cert", { certificate: CERT }).expires, Date.parse("Oct 27 10:53:06 2026 GMT"));
  assert.deepEqual(derivedDetails("cert", { certificate: "not a certificate" }), {});
  assert.equal(derivedDetails("authenticator", { totp: "otpauth://totp/Harlow%20Legal:alex@harlow.test?secret=JBSWY3DPEHPK3PXP&issuer=Harlow%20Legal" }).issuer, "Harlow Legal");
  assert.equal(derivedDetails("authenticator", { totp: "otpauth://totp/Northwind:kit?secret=JBSWY3DPEHPK3PXP" }).issuer, "Northwind");
  assert.equal(derivedDetails("recovery-codes", { codes: "aaaa-1111 bbbb-2222\ncccc-3333" }).count, 3);
  assert.equal(derivedDetails("wifi", { ssid: "Northwind Guest", password: "x" }).ssid, "Northwind Guest");
});

test("typed items: put with details, list them, hand over the right field, refuse a passkey's key", async t => {
  const { run, db } = await recorded(t);
  const token = ["ghp", hex(18)].join("_"), secretKey = hex(20), wifiPw = hex(8), code = hex(6);
  await run("vault.put", { name: "kit-github", kind: "pat", value: token, details: { provider: "github", scope: ["repo", "read:org"], expires: "90d" } });
  await run("vault.put", { name: "northwind-aws", kind: "cloud", fields: { access_key_id: "AKIA" + "EXAMPLEEXAMPLE00", secret_access_key: secretKey }, details: { provider: "aws" } });
  await run("vault.put", { name: "harlow-intake-tls", kind: "cert", fields: { certificate: CERT } });
  await run("vault.put", { name: "northwind-guest", kind: "wifi", fields: { ssid: "Northwind Guest", password: wifiPw } });
  await run("vault.put", { name: "harlow-google-codes", kind: "recovery-codes", fields: { codes: `${code} ${hex(6)} ${hex(6)}` } });
  await run("vault.put", { name: "harlow-passkey", kind: "passkey", fields: { private_key: hex(32), credential_id: hex(16), rp_id: "harlow.test" }, details: { rp: "harlow.test" } });
  await assert.rejects(run("vault.put", { name: "bad", kind: "pat", fields: { username: "kit" } }), /a pat needs a token/);
  await assert.rejects(run("vault.put", { name: "bad", kind: "pat", value: "x", details: { token: "x" } }), /details.token is not one of/);

  const items = Object.fromEntries((await run("vault.list", {})).items.map(i => [i.name, i]));
  const pat = items["kit-github"].details;
  assert.deepEqual(pat.scope, ["repo", "read:org"]);
  assert.equal(pat.provider, "github");
  assert.ok(Math.abs(pat.expires - (Date.now() + 90 * 86400_000)) < 60_000);
  assert.equal(items["harlow-intake-tls"].details.expires, Date.parse("Oct 27 10:53:06 2026 GMT"));
  assert.equal(items["northwind-guest"].details.ssid, "Northwind Guest");
  assert.equal(items["harlow-google-codes"].details.count, 3);
  // Details the caller leaves out on a later put are kept.
  await run("vault.put", { name: "kit-github", kind: "pat", value: ["ghp", hex(18)].join("_") });
  assert.deepEqual((await run("vault.list", {})).items.find(i => i.name === "kit-github").details.scope, ["repo", "read:org"]);

  const env = (await run("vault.inject", { items: [{ name: "northwind-aws", env: "AWS_SECRET_ACCESS_KEY" }, { name: "northwind-guest", env: "PW" }] })).env;
  assert.equal(env.AWS_SECRET_ACCESS_KEY, secretKey);
  assert.equal(env.PW, wifiPw);
  await assert.rejects(run("vault.inject", { items: [{ name: "harlow-passkey" }] }), /is a passkey; it signs inside the vault/);
  await assert.rejects(run("vault.inject", { items: [{ name: "harlow-passkey", field: "private_key" }] }), /is a passkey/);

  // Nothing listable carries a value.
  const listed = JSON.stringify([(await run("vault.list", {})).items, db.prepare("SELECT name, kind, description, details FROM vault_items").all()]);
  for (const v of [token, secretKey, wifiPw, code]) assert.ok(!listed.includes(v));
});

test("Watchtower: expired and expiring from details; typed tokens count for reuse", () => {
  const now = Date.parse("2026-10-20T00:00:00Z");
  const same = hex(16);
  const out = judge([
    { name: "old-pat", kind: "pat", fields: { token: hex(16) }, updated: now, details: { expires: now - 1000 } },
    { name: "soon-cert", kind: "cert", fields: { certificate: CERT }, updated: now, details: { expires: Date.parse("Oct 27 10:53:06 2026 GMT") } },
    { name: "fine-pat", kind: "pat", fields: { token: hex(16) }, updated: now, details: { expires: now + 90 * 86400_000 } },
    { name: "db-a", kind: "db-url", fields: { url: `postgres://kit:${same}@db.northwind.test/a` }, updated: now },
    { name: "tok-a", kind: "oauth", fields: { token: same }, updated: now },
    { name: "tok-b", kind: "pat", fields: { token: same }, updated: now },
  ], { now, twofa: new Set() });
  const by = Object.fromEntries(out.items.map(i => [i.name, i.reasons]));
  assert.deepEqual(by["old-pat"], ["expired"]);
  assert.deepEqual(by["soon-cert"], ["expiring"]);
  assert.equal(by["fine-pat"], undefined);
  assert.deepEqual(by["tok-a"], ["reused"]);
  assert.deepEqual(by["tok-b"], ["reused"]);
  assert.equal(out.counts.expired, 1);
  assert.equal(out.counts.expiring, 1);
});
