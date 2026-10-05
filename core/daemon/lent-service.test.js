import "../../scripts/mac-test-guard.mjs";
import "../runner/testing/hosted-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { lentServiceFor } from "./lent-service.js";

const chain = (person, device) => ({ space: "spc_aaaaaaaaaaaa", hops: [{ actor: { kind: "person", id: person }, via: { device } }] });
const kernel = (active) => ({ gateway: { grants: { offers: { active: () => active } }, leases: { renew: async () => ({}), bind() {}, unbind() {} } } });

test("a Space this home serves gets a lent service; a kernel with no offers store gets none", () => {
  const root = fs.mkdtempSync(path.join(SCRATCH, "ls-"));
  const f = lentServiceFor({ root });
  assert.equal(f("spc_aaaaaaaaaaaa", {}), null);
  assert.equal(f("spc_aaaaaaaaaaaa", { gateway: {} }), null);
  const s = f("spc_aaaaaaaaaaaa", kernel({ spaceAllows: true, memberAccepts: true }));
  assert.equal(typeof s.start, "function");
  assert.deepEqual(Object.keys(s).filter(k => ["status", "start", "stop", "putFile", "getFile", "putCheckpoint", "getCheckpoint", "appendTranscript", "getTranscript", "usage"].includes(k)).length, 10);
});

test("status answers from the Offers; start answers the member's own agent when the daemon gave no definition, and uses lentSpec when it did", async () => {
  const root = fs.mkdtempSync(path.join(SCRATCH, "ls-"));
  const k = kernel({ spaceAllows: true, memberAccepts: true });
  const bare = lentServiceFor({ root })("spc_aaaaaaaaaaaa", k);
  assert.deepEqual(await bare.status(chain("per_bob", "dev_laptop")), { spaceAllows: true, memberAccepts: true, lenderCap: null });
  const own = await bare.start(chain("per_bob", "dev_laptop"), { session: "s0" });
  assert.deepEqual([own.command, own.network, own.routes], ["claude", "provider", []], "the member's own agent, the provider as the only network");
  const seen = [];
  const withSpec = lentServiceFor({ root, lentSpec: async i => { seen.push(i); return { command: "/usr/bin/agent", args: [], env: {}, routes: [], readOnly: [], labels: {}, network: "provider" }; } })("spc_aaaaaaaaaaaa", k);
  const r = await withSpec.start(chain("per_bob", "dev_laptop"), { session: "s1" });
  assert.equal(r.command, "/usr/bin/agent");
  assert.deepEqual(seen, [{ space: "spc_aaaaaaaaaaaa", session: "s1", person: "per_bob", device: "dev_laptop" }]);
  const closed = lentServiceFor({ root, lentSpec: async () => ({ command: "x", routes: [] }) })("spc_aaaaaaaaaaaa", kernel({ spaceAllows: true, memberAccepts: false }));
  await assert.rejects(closed.start(chain("per_bob", "dev_laptop"), { session: "s1" }), e => e.code === "not_allowed");
});

test("an Offer for a computer that ends tells the daemon which computer, once per Space; an Offer for any computer is not pushed", () => {
  const root = fs.mkdtempSync(path.join(SCRATCH, "ls-"));
  const told = [];
  let listener = null, unsubbed = 0;
  const k = { gateway: { grants: { offers: { active: () => ({}), onRevoke: f => { listener = f; return () => { unsubbed++; }; } } }, leases: {} } };
  const f = lentServiceFor({ root, onRevoke: (space, info) => told.push([space, info.device]) });
  f("spc_aaaaaaaaaaaa", k);
  listener({ device: "dev_laptop", member: "per_bob", side: "member_accepts", reason: "withdrawn" });
  listener({ device: null, member: "per_bob", side: "space_allows", reason: "withdrawn" });
  assert.deepEqual(told, [["spc_aaaaaaaaaaaa", "dev_laptop"]]);
  f("spc_aaaaaaaaaaaa", k);   // the server for the Space was made again: the old listener goes
  assert.equal(unsubbed, 1);
});

test("the member's provider account becomes the session's only route and credential route; no account means no model route", async () => {
  const root = fs.mkdtempSync(path.join(SCRATCH, "ls-"));
  const k = kernel({ spaceAllows: true, memberAccepts: true });
  const withKey = lentServiceFor({ root, providerAccount: async () => ({ item: "ai-key-claude-abc", base_url: "https://llm.example" }) })("spc_aaaaaaaaaaaa", k);
  const s = await withKey.start(chain("per_bob", "dev_laptop"), { session: "s1" });
  assert.deepEqual(s.routes.map(r => [r.prefix, r.upstream, r.credential.header]), [["/provider", "https://llm.example", "x-api-key"]]);
  const none = await lentServiceFor({ root, providerAccount: async () => null })("spc_aaaaaaaaaaaa", k).start(chain("per_bob", "dev_laptop"), { session: "s1" });
  assert.deepEqual(none.routes, []);
});

test("a sign-in token account becomes a bearer route with its beta flag; an API key stays x-api-key", async () => {
  const root = fs.mkdtempSync(path.join(SCRATCH, "ls-"));
  const k = kernel({ spaceAllows: true, memberAccepts: true });
  const oauth = await lentServiceFor({ root, providerAccount: async () => ({ item: "claude-setup-token", oauth: true }) })("spc_aaaaaaaaaaaa", k).start(chain("per_bob", "dev_laptop"), { session: "s1" });
  assert.deepEqual(oauth.routes[0].credential, { header: "authorization", prefix: "Bearer " });
  assert.deepEqual(oauth.routes[0].headers, { "anthropic-beta": "oauth-2025-04-20" });
  const key = await lentServiceFor({ root, providerAccount: async () => ({ item: "ai-key-claude-1" }) })("spc_aaaaaaaaaaaa", k).start(chain("per_bob", "dev_laptop"), { session: "s1" });
  assert.deepEqual(key.routes[0].credential, { header: "x-api-key" });
  assert.equal(key.routes[0].headers, undefined);
});
