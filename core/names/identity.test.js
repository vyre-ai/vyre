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
  assert.deepEqual(await id("::ffff:100.101.1.2"), { ok: true, kind: "owner", login: "alex@example.com", node: "phone.example.ts.net", stableId: null, tags: [], caps: {}, why: "owner" });
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

// ---- guests and agent nodes (ADR 0014 parts 8 and 9) ----

const WORLD = {
  "100.101.1.2": { login: "alex@example.com", tagged: false, node: "phone", stableId: "nPHONE", tags: [], caps: {} },
  "100.101.2.7": { login: "sam@harlow.example", tagged: false, node: "sams-laptop", stableId: "nSAM", tags: [], caps: {} },
  "100.101.2.8": { login: "pat@northwind.example", tagged: false, node: "pats-mac", stableId: "nPAT", tags: [],
    caps: { "vyre.run/cap/guest": [{ tools: ["threads.list"] }] } },
  "100.101.3.1": { login: null, tagged: true, node: "kit", stableId: "nKIT", tags: ["tag:vyre-agent"], caps: {} },
  "100.101.3.2": { login: null, tagged: true, node: "ci", stableId: "nCI", tags: ["tag:ci"], caps: {} },
};

function kinds({ guests = { enabled: true, people: { "sam@harlow.example": { tools: ["glass.open"] } } }, computers = { enabled: true, tag: "tag:vyre-agent" },
  agentOf = undefined } = {}) {
  return identifier({ whois: async ip => WORLD[ip] || null, selfIps: () => ["100.101.1.1"], owner: () => "alex@example.com",
    network: () => ({ guests }), agentNodes: () => computers, ...(agentOf ? { agentOf } : {}) });
}

test("identity: the owner is still the owner, with its tags and caps beside it", async () => {
  const r = await kinds()("100.101.1.2");
  assert.equal(r.kind, "owner");
  assert.deepEqual(r.tags, []);
});

test("identity: a listed person from another tailnet is a guest while guests are on", async () => {
  const r = await kinds()("100.101.2.7");
  assert.deepEqual([r.ok, r.kind, r.login, r.why], [true, "guest", "sam@harlow.example", "guest"]);
  const upper = await kinds({ guests: { enabled: true, people: { "SAM@harlow.example": { tools: [] } } } })("100.101.2.7");
  assert.equal(upper.kind, "guest", "logins match without case");
});

test("identity: a person the policy grants vyre.run/cap/guest is a guest without being listed", async () => {
  const r = await kinds()("100.101.2.8");
  assert.equal(r.kind, "guest");
  assert.deepEqual(r.caps, WORLD["100.101.2.8"].caps);
});

test("identity: with guests off, a listed or granted person is refused as before", async () => {
  const id = kinds({ guests: { enabled: false, people: { "sam@harlow.example": { tools: ["glass.open"] } } } });
  for (const ip of ["100.101.2.7", "100.101.2.8"]) {
    const r = await id(ip);
    assert.deepEqual([r.ok, r.kind, r.why], [false, null, "not the owner"]);
  }
  const unlisted = await kinds({ guests: { enabled: true, people: {} } })("100.101.2.7");
  assert.equal(unlisted.why, "not the owner", "on, but neither listed nor granted");
});

test("identity: a node with the agent tag is that agent only when the resolver names one", async () => {
  // No resolver (the computers module has no computers.node.agent yet): refused as any tagged node.
  assert.equal((await kinds()("100.101.3.1")).why, "a tagged node, not a person");
  let asked = null;
  const r = await kinds({ agentOf: async id => { asked = id; return id === "nKIT" ? "kit" : null; } })("100.101.3.1");
  assert.deepEqual([r.ok, r.kind, r.agent, r.login], [true, "agent", "kit", null]);
  assert.equal(asked, "nKIT", "the resolver is asked by stable id");
  assert.equal((await kinds({ agentOf: async () => "not a name!" })("100.101.3.1")).ok, false, "a resolver's odd answer is no agent");
  assert.equal((await kinds({ agentOf: async () => { throw new Error("down"); } })("100.101.3.1")).why, "a tagged node, not a person");
  // Off, the tag means nothing and the resolver is never asked.
  let called = false;
  const off = await kinds({ computers: { enabled: false }, agentOf: async () => { called = true; return "kit"; } })("100.101.3.1");
  assert.deepEqual([off.ok, called], [false, false]);
});

test("identity: a tagged node without the agent tag is refused, whatever the resolver says", async () => {
  const r = await kinds({ agentOf: async () => "kit" })("100.101.3.2");
  assert.deepEqual([r.ok, r.why], [false, "a tagged node, not a person"]);
  const other = await kinds({ computers: { enabled: true, tag: "tag:ci" }, agentOf: async () => "kit" })("100.101.3.1");
  assert.equal(other.ok, false, "the configured tag is the one that counts");
});

test("identity: the whois cache still holds 60 s while the guest list is read every time", async () => {
  let lookups = 0, now = 0;
  const g = { enabled: true, people: { "sam@harlow.example": { tools: [] } } };
  const id = identifier({ whois: async ip => { lookups++; return WORLD[ip] || null; }, selfIps: () => [], owner: () => "alex@example.com",
    network: () => ({ guests: g }), now: () => now });
  assert.equal((await id("100.101.2.7")).kind, "guest");
  g.enabled = false;
  assert.equal((await id("100.101.2.7")).ok, false, "turning guests off counts at once");
  assert.equal(lookups, 1);
  now = 60_001;
  await id("100.101.2.7");
  assert.equal(lookups, 2);
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
    { login: "alex@example.com", tagged: false, node: "phone.example.ts.net", stableId: "n2", tags: [], caps: {} });
  assert.equal(parseWhois({ Node: { Name: "ci.", Tags: ["tag:ci"] }, UserProfile: { LoginName: "tagged-devices" } })?.login, null);
  // The policy's app capabilities come through as written; anything not a list reads as none.
  const granted = parseWhois({ Node: { Name: "mac.", StableID: "n3" }, UserProfile: { LoginName: "alex@example.com" },
    CapMap: { "vyre.run/cap/vault": [{ items: ["northwind-*"] }], "odd": "nope" } });
  assert.deepEqual(granted?.caps, { "vyre.run/cap/vault": [{ items: ["northwind-*"] }], odd: [] });
});

test("tailscale up names the operator again on Linux, and takes only flag-shaped extras", async () => {
  const { upArgs } = await import("./tailscale.js");
  assert.deepEqual(upArgs({}, "darwin", "alex"), ["up"]);
  assert.deepEqual(upArgs({ VYRE_TAILSCALE_UP_FLAGS: "--accept-dns=false  --hostname=vyre" }, "linux", "vyre"),
    ["up", "--operator=vyre", "--accept-dns=false", "--hostname=vyre"]);
  assert.deepEqual(upArgs({ VYRE_TAILSCALE_UP_FLAGS: "--ok ; rm -rf /" }, "linux", "vyre"), ["up", "--operator=vyre", "--ok"]);
});

test("tailscale: under node --test, with no fake and no opt-in, the real CLI is never run", async () => {
  const { run, up } = await import("./tailscale.js");
  const saved = { bin: process.env.VYRE_TAILSCALE_BIN, real: process.env.VYRE_TEST_REAL_TAILSCALE };
  delete process.env.VYRE_TAILSCALE_BIN; delete process.env.VYRE_TEST_REAL_TAILSCALE;
  try {
    assert.equal((await run(["status", "--json"])).code, 127);
    assert.equal((await up()).code, 127);
  } finally {
    if (saved.bin !== undefined) process.env.VYRE_TAILSCALE_BIN = saved.bin;
    if (saved.real !== undefined) process.env.VYRE_TEST_REAL_TAILSCALE = saved.real;
  }
});
