// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { revokeAtVendor } from "./connection-revoke.js";

const people = (/** @type {any} */ fields, kind = "connection") => ({ get: async () => ({ kind, fields }) });
const mk = (/** @type {number} */ status = 200) => { /** @type {any[]} */ const calls = []; return { calls, fetch: /** @type {any} */ (async (u, init) => { calls.push({ url: String(u), init }); if (status === 0) throw new Error("down"); return { status }; }) }; };
const I = { owner: "per_alice", connection: "clio" };

test("revoking a connection tells the vendor to drop the refresh token (RFC 7009), over the address the connection names, and returns no token", async () => {
  const f = mk();
  const out = await revokeAtVendor({ people: people({ revocation_endpoint: "https://auth.example.test/revoke", token_uri: "https://auth.example.test/token", refresh_token: "REFRESH-SECRET-0001", client_id: "c1", client_secret: "s1" }), fetch: f.fetch }, I);
  assert.deepEqual(out, { revoked: true, why: "revoked at the vendor" });
  const body = new URLSearchParams(f.calls[0].init.body);
  assert.equal(f.calls[0].url, "https://auth.example.test/revoke");
  assert.equal(body.get("token"), "REFRESH-SECRET-0001"); assert.equal(body.get("token_type_hint"), "refresh_token"); assert.equal(body.get("client_id"), "c1");
  assert.equal(f.calls[0].init.redirect, "manual");
  assert.ok(!JSON.stringify(out).includes("REFRESH-SECRET"));
});

test("without a revocation address, a token, an https address or a connection, nothing is sent and the answer says why", async () => {
  for (const [fields, kind, re] of /** @type {[any, string, RegExp][]} */ ([
    [{ refresh_token: "t" }, "connection", /named no revocation address/],
    [{ revocation_endpoint: "https://auth.example.test/revoke", token_uri: "https://auth.example.test/token" }, "connection", /no token/],
    [{ revocation_endpoint: "http://auth.example.test/revoke", refresh_token: "t" }, "connection", /not https/],
    [{ revocation_endpoint: "not an address", refresh_token: "t" }, "connection", /not an address/],
    [{ revocation_endpoint: "https://auth.example.test/revoke", refresh_token: "t" }, "login", /not a connection/],
  ])) {
    const f = mk();
    const out = await revokeAtVendor({ people: people(fields, kind), fetch: f.fetch }, I);
    assert.equal(out.revoked, false); assert.match(out.why, re); assert.equal(f.calls.length, 0);
  }
});

test("a vendor that answers an error or cannot be reached is reported as not revoked, never as revoked", async () => {
  const fields = { revocation_endpoint: "https://auth.example.test/revoke", issuer: "https://auth.example.test", access_token: "ACCESS-1" };
  assert.equal((await revokeAtVendor({ people: people(fields), fetch: mk(503).fetch }, I)).revoked, false);
  assert.match((await revokeAtVendor({ people: people(fields), fetch: mk(0).fetch }, I)).why, /could not be reached/);
  const f = mk();
  await revokeAtVendor({ people: people(fields), fetch: f.fetch }, I);
  assert.equal(new URLSearchParams(f.calls[0].init.body).get("token_type_hint"), "access_token", "with no refresh token the access token is sent");
});

test("the token and the client secret go only to the sign-in's own origin: a revocation address on any other origin is never called", async () => {
  for (const fields of [
    { revocation_endpoint: "https://evil.example.test/revoke", token_uri: "https://auth.example.test/token", refresh_token: "T", client_secret: "S" },
    { revocation_endpoint: "https://auth.example.test.evil.test/revoke", token_uri: "https://auth.example.test/token", refresh_token: "T" },
    { revocation_endpoint: "https://auth.example.test:8443/revoke", token_uri: "https://auth.example.test/token", refresh_token: "T" },
    { revocation_endpoint: "https://auth.example.test/revoke", refresh_token: "T" },
  ]) {
    const f = mk();
    const out = await revokeAtVendor({ people: people(fields), fetch: f.fetch }, I);
    assert.equal(out.revoked, false); assert.match(out.why, /not on the sign-in's own origin/); assert.equal(f.calls.length, 0, JSON.stringify(fields));
  }
  const f = mk();
  assert.equal((await revokeAtVendor({ people: people({ revocation_endpoint: "https://auth.example.test/oauth/revoke", token_uri: "https://auth.example.test/token", refresh_token: "T" }), fetch: f.fetch }, I)).revoked, true, "the same origin, another path, is fine");
  const g = mk();
  assert.equal((await revokeAtVendor({ people: people({ revocation_endpoint: "https://auth.example.test/revoke", issuer: "https://auth.example.test", refresh_token: "T" }), fetch: g.fetch }, I)).revoked, true, "the issuer's origin counts too");
});
