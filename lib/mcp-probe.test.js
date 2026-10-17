// @ts-check
// B4: the probe for one catalog row. It reads the vendor's own discovery documents (RFC 9728, RFC 8414) and says whether
// the server advertises dynamic registration, whether it takes a public client with PKCE, or whether it needs a client the
// person makes. It never registers, never posts and never sends a token, so a probe leaves nothing at the vendor.
// No network: the fetch is a fake.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeServer } from "./mcp-probe.js";

/** A fake fetch over a map of url -> body (or a status), recording every method it saw. */
function fakeFetch(map) {
  const seen = [];
  const f = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method || "GET" });
    const hit = map[String(url)];
    if (hit === undefined) return { ok: false, status: 404, json: async () => ({}) };
    if (typeof hit === "number") return { ok: false, status: hit, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => hit };
  };
  return { f, seen };
}

const LINEAR = "https://mcp.linear.app/mcp";
const linearDocs = {
  "https://mcp.linear.app/.well-known/oauth-protected-resource": { resource: "https://mcp.linear.app/mcp", authorization_servers: ["https://mcp.linear.app"] },
  "https://mcp.linear.app/.well-known/oauth-authorization-server": {
    issuer: "https://mcp.linear.app", authorization_endpoint: "https://mcp.linear.app/authorize", token_endpoint: "https://mcp.linear.app/token",
    registration_endpoint: "https://mcp.linear.app/register", token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"],
  },
};

test("a server that advertises dynamic registration is dcr-advertised, and the probe never registers", async () => {
  const { f, seen } = fakeFetch(linearDocs);
  const r = await probeServer(LINEAR, f);
  assert.equal(r.result, "dcr-advertised");
  assert.equal(r.registration, true);
  assert.equal(r.pkce_s256, true);
  assert.equal(r.issuer, "https://mcp.linear.app");
  assert.ok(seen.every(s => s.method === "GET"), "the probe only reads");
  assert.ok(!seen.some(s => s.url.endsWith("/register")), "the registration endpoint is named, never called");
});

test("a public client with PKCE and no registration endpoint is open-client", async () => {
  const docs = { ...linearDocs, "https://mcp.linear.app/.well-known/oauth-authorization-server": { ...linearDocs["https://mcp.linear.app/.well-known/oauth-authorization-server"], registration_endpoint: undefined } };
  const r = await probeServer(LINEAR, fakeFetch(docs).f);
  assert.equal(r.result, "open-client");
  assert.equal(r.registration, false);
});

test("a server whose metadata needs a registered client is needs-client", async () => {
  const docs = { ...linearDocs, "https://mcp.linear.app/.well-known/oauth-authorization-server": { ...linearDocs["https://mcp.linear.app/.well-known/oauth-authorization-server"], registration_endpoint: undefined, token_endpoint_auth_methods_supported: ["client_secret_basic"] } };
  const r = await probeServer(LINEAR, fakeFetch(docs).f);
  assert.equal(r.result, "needs-client");
});

test("a server with no OAuth metadata at all is no-oauth, with the reason", async () => {
  const r = await probeServer("https://mcp.example.test/mcp", fakeFetch({}).f);
  assert.equal(r.result, "no-oauth");
  assert.equal(r.registration, false);
  assert.ok(r.reason && r.reason.length > 0);
});

test("a discovery document that names another origin is refused, not followed", async () => {
  const docs = { "https://mcp.evil.test/.well-known/oauth-protected-resource": { resource: "https://mcp.evil.test/mcp", authorization_servers: ["https://mcp.linear.app"] } };
  const r = await probeServer("https://mcp.evil.test/mcp", fakeFetch({ ...docs, ...linearDocs }).f);
  assert.equal(r.result, "refused");
});

test("only https addresses are probed", async () => {
  const r = await probeServer("http://mcp.linear.app/mcp", fakeFetch(linearDocs).f);
  assert.equal(r.result, "refused");
});
