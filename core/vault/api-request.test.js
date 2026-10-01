// @ts-check
// The pure engine behind vault-routed API access: normalize(), classify() and the SSRF guard
// checkTarget(). What these prove: an api-credential's shape is checked the way a hub server row
// is (auth, a bounded host allowlist, an endpoint table); a DWD credential's subject is fixed on
// the item, never a field a caller can set; a read defaults to running, anything else defaults to
// held, and a preset cannot be loosened by a credential's own endpoints; and the target check
// refuses private/loopback/link-local/CGNAT/tailnet/metadata addresses outright, checks every
// resolved address, unwraps an IPv4-mapped IPv6 address before checking it, and a wildcard host
// matches exactly one label, never a bare suffix or a deeper subdomain.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, classify, hostAllowed, addressBlocked, checkTarget, PRESETS, presetFor, presetRead } from "./api-request.js";

test("normalize: service-account needs a fixed subject and scopes; oauth needs a client and https endpoints; hosts are bounded", () => {
  assert.throws(() => normalize({ auth: { type: "service-account", item: "sa" }, hosts: ["googleapis.com"] }), /subject/);
  assert.throws(() => normalize({ auth: { type: "service-account", item: "sa", subject: "a@b.com" }, hosts: ["googleapis.com"] }), /scopes/);
  const sa = normalize({ auth: { type: "service-account", item: "sa", subject: "alex@harlowlegal.com", scopes: ["s1"] }, hosts: ["gmail.googleapis.com", "*.harlow.test"] });
  assert.deepEqual(sa.auth, { type: "service-account", item: "sa", subject: "alex@harlowlegal.com", scopes: ["s1"] });
  assert.deepEqual(sa.hosts, ["gmail.googleapis.com", "*.harlow.test"]);
  // With no item named, the secret is the credential's own sealed one.
  assert.deepEqual(normalize({ auth: { type: "bearer" }, hosts: ["api.harlow.test"] }).auth, { type: "bearer" });

  assert.throws(() => normalize({ auth: { type: "oauth", authorize_uri: "https://a/authorize", token_uri: "https://a/token", scopes: ["s"] }, hosts: ["a"] }), /client/);
  assert.throws(() => normalize({ auth: { type: "oauth", client: { item: "c" }, authorize_uri: "http://a/authorize", token_uri: "https://a/token", scopes: ["s"] }, hosts: ["a"] }), /https/);
  const oa = normalize({ auth: { type: "oauth", client: { item: "c" }, authorize_uri: "https://a/authorize", token_uri: "https://a/token", scopes: ["s"] }, hosts: ["graph.microsoft.com"] });
  assert.equal(oa.auth.type, "oauth");

  assert.throws(() => normalize({ auth: { type: "bearer", item: "b" }, hosts: [] }), /hosts/);
  assert.throws(() => normalize({ auth: { type: "bearer", item: "b" }, hosts: ["not a host!"] }), /is not a host/);
  const b = normalize({ auth: { type: "bearer", item: "b", header: "X-Api-Key" }, hosts: ["api.stripe.com"], endpoints: [{ method: "post", path: "/v1/charges", kind: "spend" }] });
  assert.equal(b.auth.header, "x-api-key");
  assert.deepEqual(b.endpoints, [{ method: "POST", path: "/v1/charges", kind: "spend" }]);

  assert.throws(() => normalize({ auth: { type: "bearer", item: "b" }, hosts: ["example.com"], endpoints: [{ method: "GET", path: "/x", kind: "maybe" }] }), /endpoint entry/);
});

test("normalize: a wildcard on a domain anyone can rent a name under is refused; an exact host there is fine; an address is never a host", () => {
  for (const h of ["*.googleapis.com", "*.storage.googleapis.com", "*.s3.amazonaws.com", "*.appspot.com", "*.run.app", "*.azurewebsites.net", "*.cloudfunctions.net", "*.workers.dev", "*.github.io", "*.herokuapp.com"])
    assert.throws(() => normalize({ auth: { type: "bearer" }, hosts: [h] }), /wildcard on a domain anyone can rent/, h);
  assert.deepEqual(normalize({ auth: { type: "bearer" }, hosts: ["gmail.googleapis.com", "graph.microsoft.com"] }).hosts, ["gmail.googleapis.com", "graph.microsoft.com"]);
  for (const h of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "2130706433", "0x7f000001", "1.2.3.4", "[::1]", "::1", "0177.0.0.1"])
    assert.throws(() => normalize({ auth: { type: "bearer" }, hosts: [h] }), /is not a host/, h);
});

test("classify: GET/HEAD default to read, everything else defaults to held; a credential's endpoints are checked first, presets second", () => {
  assert.deepEqual(classify("GET", "/anything", []), { kind: "read", matched: false, from: "default" });
  assert.deepEqual(classify("POST", "/anything", []), { kind: "send", matched: false, from: "default" });
  assert.deepEqual(classify("DELETE", "/x/y", []), { kind: "send", matched: false, from: "default" });

  // A preset write is caught even with no credential-declared endpoints.
  assert.deepEqual(classify("POST", "/v1/charges", []), { kind: "spend", matched: true, from: "preset" });
  assert.deepEqual(classify("POST", "/gmail/v1/users/me/messages/send", []), { kind: "send", matched: true, from: "preset" });
  assert.equal(classify("GET", "/v1/charges", []).matched, false, "a GET on the same path is not a preset match");

  // A credential's own endpoints are checked first (so it can classify its own custom paths)...
  assert.deepEqual(classify("DELETE", "/api/widgets/9", [{ method: "DELETE", path: "/api/widgets/*", kind: "delete" }]), { kind: "delete", matched: true, from: "endpoints" });
  // ...but cannot loosen a preset into a read: presets are still checked, endpoints came first and
  // simply did not match this path, so the preset still holds it.
  assert.deepEqual(classify("POST", "/v1/charges", [{ method: "GET", path: "/v1/customers", kind: "read" }]), { kind: "spend", matched: true, from: "preset" });

  // "*" matches any method.
  assert.deepEqual(classify("PATCH", "/webhooks/1", [{ method: "*", path: "/webhooks/*", kind: "send" }]), { kind: "send", matched: true, from: "endpoints" });
});

test("hostAllowed: exact match, a wildcard matches exactly one label, never a bare suffix or a deeper subdomain", () => {
  assert.ok(hostAllowed("api.stripe.com", ["api.stripe.com"]));
  assert.ok(!hostAllowed("evil-api.stripe.com", ["api.stripe.com"]));
  assert.ok(hostAllowed("gmail.googleapis.com", ["*.googleapis.com"]));
  assert.ok(!hostAllowed("googleapis.com", ["*.googleapis.com"]), "the wildcard needs a label, not the bare domain");
  assert.ok(!hostAllowed("a.gmail.googleapis.com", ["*.googleapis.com"]), "a wildcard matches exactly one label");
  assert.ok(!hostAllowed("evilgoogleapis.com", ["*.googleapis.com"]), "no dot before the suffix is not a subdomain match");
  assert.ok(!hostAllowed("googleapis.com.evil.test", ["*.googleapis.com"]), "a bare suffix elsewhere in the name is not a match");
});

test("addressBlocked: private, loopback, link-local/metadata, CGNAT/tailnet and their IPv6 forms are all refused", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.5", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.100.100.200", "0.0.0.0"]) {
    assert.ok(addressBlocked(ip), `${ip} should be blocked`);
  }
  for (const ip of ["8.8.8.8", "142.250.80.46", "104.16.132.229"]) assert.ok(!addressBlocked(ip), `${ip} is a real public address`);

  assert.ok(addressBlocked("::1"), "IPv6 loopback");
  assert.ok(addressBlocked("fe80::1"), "IPv6 link-local");
  assert.ok(addressBlocked("fc00::1"), "IPv6 unique-local");
  assert.ok(addressBlocked("::ffff:169.254.169.254"), "an IPv4-mapped IPv6 metadata address must not dodge the IPv4 check");
  assert.ok(addressBlocked("::ffff:127.0.0.1"), "an IPv4-mapped IPv6 loopback address");
  assert.ok(!addressBlocked("2606:4700:4700::1111"), "a real public IPv6 address");
});

test("checkTarget: https only, an allowed host, every resolved address checked, and the addresses are handed back for pinning", async () => {
  const lookup = async host => (host === "api.example.com" ? [{ address: "203.0.113.9", family: 4 }] : []);
  const out = await checkTarget("https://api.example.com/v1/x", ["api.example.com"], { lookup });
  assert.deepEqual(out.addresses, ["203.0.113.9"]);
  assert.equal(out.url.pathname, "/v1/x");

  await assert.rejects(checkTarget("http://api.example.com/v1/x", ["api.example.com"], { lookup }), /https/);
  await assert.rejects(checkTarget("https://user:pass@api.example.com/x", ["api.example.com"], { lookup }), /user or password/);
  await assert.rejects(checkTarget("https://not-allowed.example.com/x", ["api.example.com"], { lookup }), /not on this credential/);

  // One good address and one bad one: the bad one refuses the whole request, not just half of it.
  const mixedLookup = async () => [{ address: "203.0.113.9", family: 4 }, { address: "169.254.169.254", family: 4 }];
  await assert.rejects(checkTarget("https://api.example.com/x", ["api.example.com"], { lookup: mixedLookup }), /private, loopback, link-local or metadata/);
});

test("presets name exact hosts, never a wildcard, and presetFor finds the family a request falls under", () => {
  for (const p of PRESETS) assert.ok(/^[a-z0-9.-]+$/.test(p.host) && !p.host.includes("*"), `${p.path}: ${p.host}`);
  assert.equal(presetFor("POST", "/v1.0/me/sendMail").family, "graph-mail");
  assert.equal(presetFor("POST", "/gmail/v1/users/me/messages/send").host, "gmail.googleapis.com");
  assert.equal(presetFor("GET", "/v1.0/me/sendMail"), null);
  assert.equal(presetFor("POST", "/v1.0/me/messages"), null);
  assert.ok(presetRead("GET", "/v1.0/me/messages", "graph.microsoft.com"));
  assert.ok(!presetRead("GET", "/v1.0/me/messages", "evil.test"), "a preset read is for the preset's own host");
  assert.ok(!presetRead("POST", "/v1.0/me/messages", "graph.microsoft.com"));
});

test("no preset silently classifies a known write as a read (the safety net this depends on)", () => {
  for (const p of PRESETS) assert.notEqual(p.kind, "read", `${p.method} ${p.path} must not be classified read`);
});

test("scopeAllows fails closed: a caller naming no agent or no project is let in only by '*', never by a list", async () => {
  const { scopeAllows } = await import("./api-request.js");
  const one = { scope: { projects: ["project-a"], agents: ["kit"] } };
  assert.equal(scopeAllows(one, { agent: "kit", project: "project-a" }), true);
  assert.equal(scopeAllows(one, { agent: "kit" }), false, "no project does not match a list");
  assert.equal(scopeAllows(one, { project: "project-a" }), false, "no agent does not match a list");
  assert.equal(scopeAllows(one, {}), false);
  assert.equal(scopeAllows({ scope: { projects: "*", agents: "*" } }, {}), true, "* is everyone");
  assert.equal(scopeAllows({ scope: { projects: "*", agents: ["kit"] } }, { project: "p" }), false);
  assert.equal(scopeAllows({}, { agent: "kit", project: "p" }), false, "no scope is no one");
});
