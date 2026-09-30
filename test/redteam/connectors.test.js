// @ts-check
// Red-team refusals for the connectors module (catalog, connect flows, the hub's host binding and the
// internal tools between connectors, mcp and vault). One runner test per finding, named
// "redteam <ID>: <attack> is refused", against a real registry in a temp home, or against fakes where the
// attack is on the sign-in itself. Runs on runners and the test box (node --test "test/redteam/*.test.js"),
// never on the Mac. Nothing here connects a real app or reaches a vendor.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { start } from "../../core/daemon/index.js";
import { connector } from "../../lib/connectors/oauth.js";
import { startFakeAuthServer } from "../../lib/connectors/testing/fake-oauth.js";
import { catalogFrom } from "../../lib/connector-presets/index.js";
import { tempHome, present } from "../helpers.js";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;

async function world(t, config = {}) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" }, ...config }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const call = (tool, input, caller) => d.registry.call(tool, input, caller);
  return { d, call };
}

const NOT_PERSON = ["mcp", "mcp:agent:kit", "module:sessions", "module:watchers", "hook"];

test("redteam RT-C1: a config file that adds presets cannot rewrite a vendor's host binding", async t => {
  const w = await world(t, { connectors: { presets: [{ id: "notion-auth", label: "Evil", group: "work", url: "https://evil.example.test/mcp", transport: "http", who: "x", evidence: "docs", oauth: { client: "dcr", as: ["https://evil.example.test"] } }] } });
  assert.equal(catalogFrom({ connectors: { presets: [{ id: "x" }] } }).boundFor("notion-auth").hosts[0], "mcp.notion.com");
  for (const item of ["notion-auth", "Notion-Auth", "notion-work-auth"]) {
    const r = await w.call("mcp.add", { name: "sneaky", transport: "http", url: "https://evil.example.test/mcp", auth: { type: "bearer", item, field: "value" } }, "cli");
    assert.ok(r.error && /goes only to mcp\.notion\.com/.test(r.error.message), `${item}: ${JSON.stringify(r)}`);
  }
  const cat = (await w.call("connectors.catalog", {}, "cli")).data;
  assert.ok(!cat.presets.some(p => p.id === "notion-auth"), "the config's preset is not in the catalog");
});

test("redteam RT-C2: a vendor's sign-in metadata naming a server the catalog did not expect is refused before anything is sent", async t => {
  const fakeAs = await startFakeAuthServer(t, { dcr: true });
  const events = [];
  const c = connector({ complete: async () => ({}), emit: (type, payload) => events.push({ type, payload }) });
  t.after(() => c.stop());
  await assert.rejects(c.start({ name: "a", resource: `${fakeAs.origin}/mcp`, scopes: [], pin: ["https://the-real-vendor.test"] }), /not one of the servers this app signs in with/);
  assert.ok(!fakeAs.calls.some(x => x.path === "/register" || x.path === "/token"), "no registration, no code, no secret reached it");
  assert.equal(c.port(), null, "no listener was opened");
});

test("redteam RT-C3: an added module putting a command or a vault environment in the hub is refused", async t => {
  const w = await world(t);
  const added = (tool, input) => w.call(tool, input, "module:some-added-module");
  for (const input of [
    { name: "p1", transport: "stdio", command: "/bin/sh", args: ["-c", "env"] },
    { name: "p2", transport: "stdio", command: "/bin/sh", env: { TOKEN: "github-alex" } },
    { name: "p3", transport: "http", url: "https://vendor.example.test/mcp", env: { TOKEN: "github-alex" } },
    { name: "p4", transport: "http", url: "https://vendor.example.test/mcp", auth: { type: "env", item: "github-alex", var: "T" } },
  ]) assert.equal((await added("mcp.add", input)).error?.code, "denied", JSON.stringify(input));
  // and an http row cannot be turned into a process later
  assert.ok((await w.call("mcp.add", { name: "web", transport: "http", url: "https://vendor.example.test/mcp" }, "cli")).data);
  assert.equal((await added("mcp.update", { name: "web", command: "/bin/sh" })).error?.code, "denied");
});

test("redteam RT-C4: a model, agent, watcher, hook or another module connecting, disconnecting or pasting a token is refused", async t => {
  const w = await world(t);
  for (const who of NOT_PERSON) {
    for (const [tool, input] of [
      ["connectors.connect", { preset: "ghl" }],
      ["connectors.connect", { preset: "ghl", mode: "token", token: fake("tok") }],
      ["connectors.connect", { preset: "asana", app: { client_id: "x", client_secret: fake("s") } }],
      ["connectors.connect.finish", { id: "oa_x", url: "https://127.0.0.1/connect/callback?code=a&state=b" }],
      ["connectors.connect.cancel", { id: "oa_x" }],
      ["connectors.disconnect", { name: "ghl" }],
    ]) assert.equal((await w.call(tool, input, who)).error?.code, "denied", `${who} ${tool}`);
  }
  // nothing was created
  assert.deepEqual((await w.call("connectors.list", {}, "cli")).data, []);
});

test("redteam RT-C5: the internal tools between connectors, mcp and vault answer only their own caller", async t => {
  const w = await world(t);
  const tokens = { access_token: fake("at"), refresh_token: fake("rt"), expires_in: 3600, token_uri: "https://login.example.test/token" };
  for (const who of ["cli", "local", "mcp", "mcp:agent:kit", "module:sessions", "module:watchers", "module:google"]) {
    for (const [tool, input] of [
      ["connectors.persist", { item: "ghl-auth", fields: { refresh_token: fake("x") } }],
      ["mcp.grant", { server: "ghl", thread: "t1" }],
      ["vault.credential.tokens", { name: "ms", tokens }],
      ["connectors.mention.resolve", { id: "ghl", thread: "t1" }],
    ]) {
      const r = await w.call(tool, input, who);
      assert.ok(r.error, `${who} ${tool} was refused`);
    }
  }
  // the vault's own sign-in store: connectors only, and only from the token endpoint the person's config names
  const cfg = JSON.stringify({ auth: { type: "oauth", client: { item: "ms-app" }, authorize_uri: "https://login.example.test/authorize", token_uri: "https://login.example.test/token", scopes: ["s"] }, hosts: ["graph.example.test"] });
  assert.ok((await w.call("vault.put", { name: "ms", kind: "api-credential", fields: { config: cfg } }, "cli")).data);
  assert.ok((await w.call("vault.credential.tokens", { name: "ms", tokens: { ...tokens, token_uri: "https://evil.example.test/token" } }, "module:connectors")).error, "a token endpoint the config does not name");
  assert.ok((await w.call("vault.credential.tokens", { name: "ms", tokens }, "module:connectors")).data, "the one real caller works");
});

test("redteam RT-C6: a #tag grants only its own thread, and only sessions or the assistant can resolve one", async t => {
  const w = await world(t);
  assert.ok((await w.call("mcp.add", { name: "web", transport: "http", url: "https://vendor.example.test/mcp", scope: { projects: ["only-this-one"] } }, "cli")).data);
  const sees = async thread => (await w.d.registry.call("mcp.servers", {}, "mcp", { thread })).data.some(x => x.name === "web");
  assert.equal(await sees("t-a"), false);
  for (const who of ["cli", "mcp", "mcp:agent:kit", "module:watchers"]) assert.ok((await w.call("mcp.grant", { server: "web", thread: "t-a" }, who)).error, who);
  assert.equal(await sees("t-a"), false, "a refused grant changed nothing");
});

test("redteam RT-C7: a preset's server row cannot be taken over by a same-named row from elsewhere", async t => {
  const fakeAs = await startFakeAuthServer(t, { dcr: true });
  const { connections, MIGRATIONS } = await import("../../lib/connectors/connect.js");
  const { makeCatalog } = await import("../../lib/connector-presets/index.js");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const servers = new Map([["notion", { name: "notion", url: "https://elsewhere.example.test/mcp", auth: { type: "bearer", item: "other" } }]]);
  const c = connections({ db, catalog: makeCatalog({ presets: [{ id: "notion", label: "Notion", group: "work", url: `${fakeAs.origin}/mcp`, transport: "http", who: "x", evidence: "docs", oauth: { client: "dcr" } }] }, { loopback: true }),
    fetchItem: async () => { throw new Error("none"); }, save: async () => {}, addServer: async () => ({}), testServer: async () => ({ ok: true, tools: [] }),
    hasServer: async name => servers.get(name) || null, removeServer: async () => {}, emit() {}, log() {} });
  t.after(() => c.stop());
  const s = await c.start({ preset: "notion", replace: true }, { person: true });
  await assert.rejects(c.finish({ id: s.id, url: fakeAs.consent(s.url) }), /already exists and is not this Notion connection/);
  assert.equal(c.list().length, 0);
});

test("redteam RT-C8: a connection named for one app cannot be given to another, and a token from anyone but a person is refused", async t => {
  const fakeAs = await startFakeAuthServer(t, { dcr: true });
  const { connections, MIGRATIONS } = await import("../../lib/connectors/connect.js");
  const { makeCatalog } = await import("../../lib/connector-presets/index.js");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const mk = id => ({ id, label: id, group: "work", url: `${fakeAs.origin}/mcp`, transport: "http", who: "x", evidence: "docs", oauth: { client: "dcr" }, token: { label: "T", help: "h" } });
  const c = connections({ db, catalog: makeCatalog({ presets: [mk("notion"), mk("linear")] }, { loopback: true }), fetchItem: async () => "", save: async () => {}, addServer: async () => ({}),
    testServer: async () => ({}), hasServer: async () => null, removeServer: async () => {}, emit() {}, log() {} });
  t.after(() => c.stop());
  await assert.rejects(c.start({ preset: "notion", name: "linear-work" }, { person: true }), /named notion or starts with notion-/);
  await assert.rejects(c.start({ preset: "notion", mode: "token", token: fake("t") }, { person: false }), /pasted by the person/);
  await assert.rejects(c.start({ preset: "linear", mode: "token", token: "line\nbreak" }, { person: true }), /one line/);
});
