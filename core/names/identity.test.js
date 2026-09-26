// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { identifier, isTailnet, normalize } from "./identity.js";
import { parseStatus, parseWhois } from "./tailscale.js";

const people = {
  "100.101.1.2": { login: "alex@example.com", tagged: false, node: "phone.example.ts.net" },
  "100.101.1.3": { login: "sam@example.com", tagged: false, node: "laptop.example.ts.net" },
  "100.101.1.4": { login: null, tagged: true, node: "ci.example.ts.net" },
};

function make(owner = "alex@example.com") {
  let lookups = 0;
  const id = identifier({ whois: async ip => { lookups++; return people[ip] || null; }, selfIps: () => ["100.101.1.1", "fd7a:115c:a1e0::1"], owner: () => owner });
  return { id, lookups: () => lookups };
}

test("identity: only tailnet addresses are looked up", () => {
  assert.equal(isTailnet("100.64.0.1"), true);
  assert.equal(isTailnet("100.127.255.255"), true);
  assert.equal(isTailnet("100.128.0.1"), false);
  assert.equal(isTailnet("127.0.0.1"), false);
  assert.equal(isTailnet("172.17.0.2"), false, "a container on the docker bridge is a stranger");
  assert.equal(isTailnet("fd7a:115c:a1e0::5"), true);
  assert.equal(isTailnet("::1"), false);
  assert.equal(normalize("::ffff:100.101.1.2"), "100.101.1.2");
});

test("identity: the owner on another device is served; everyone else is refused", async () => {
  const { id, lookups } = make();
  assert.deepEqual(await id("::ffff:100.101.1.2"), { ok: true, login: "alex@example.com", node: "phone.example.ts.net", why: "owner" });
  assert.equal((await id("100.101.1.3")).why, "not the owner");
  assert.equal((await id("100.101.1.4")).why, "a tagged node, not a person");
  assert.equal((await id("100.101.1.9")).why, "tailscale does not know this address");
  assert.equal((await id("127.0.0.1")).why, "not a tailnet address");
  const before = lookups();
  await id("100.101.1.2");
  assert.equal(lookups(), before, "whois is cached per address");
});

test("identity: a connection from the box's own tailnet address is a local process and is refused", async () => {
  const { id, lookups } = make();
  assert.equal((await id("100.101.1.1")).ok, false);
  assert.equal((await id("100.101.1.1")).why, "from this box itself");
  assert.equal((await id("fd7a:115c:a1e0::1")).ok, false);
  assert.equal(lookups(), 0, "the box itself is refused before any lookup, whatever whois would say");
});

test("identity: owner matching ignores case; with no owner nobody is served", async () => {
  assert.equal((await make("ALEX@example.com").id("100.101.1.2")).ok, true);
  const r = await make(null).id("100.101.1.2");
  assert.equal(r.ok, false);
  assert.equal(r.why, "no owner yet");
  assert.equal(r.login, "alex@example.com", "the claim flow needs to know who it is");
});

test("tailscale: status and whois parse the fields vyre uses", () => {
  const s = parseStatus({ BackendState: "Running", TUN: true, CertDomains: ["box.example.ts.net"],
    Self: { ID: "nS1", HostName: "box", DNSName: "box.example.ts.net.", TailscaleIPs: ["100.101.1.1", "fd7a:115c:a1e0::1"], UserID: 7 },
    User: { 7: { LoginName: "alex@example.com" } } });
  assert.equal(s.running, true);
  assert.equal(s.owner, "alex@example.com");
  assert.deepEqual(s.node && s.node.ips, ["100.101.1.1", "fd7a:115c:a1e0::1"]);
  assert.equal(s.node && s.node.dnsName, "box.example.ts.net");
  const tagged = parseStatus({ BackendState: "Running", Self: { UserID: 7, Tags: ["tag:server"], TailscaleIPs: [] }, User: { 7: { LoginName: "alex@example.com" } } });
  assert.equal(tagged.owner, null, "a tagged node has no owner to take");
  const login = parseStatus({ BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/abc" });
  assert.equal(login.loginUrl, "https://login.tailscale.com/a/abc");
  assert.equal(login.node, null);
  assert.deepEqual(parseWhois({ Node: { Name: "phone.example.ts.net.", StableID: "n2" }, UserProfile: { LoginName: "alex@example.com" } }),
    { login: "alex@example.com", tagged: false, node: "phone.example.ts.net", stableId: "n2" });
  assert.equal(parseWhois({ Node: { Name: "ci.", Tags: ["tag:ci"] }, UserProfile: { LoginName: "tagged-devices" } })?.login, null);
});
