// @ts-check
// The connect flows (connect.js) against a fake authorization server and an injected vault, hub and
// database. No real vendor is ever reached: presets here point at the fake on 127.0.0.1 port 0.
//
// What these prove: an automatic (dynamic registration) sign-in ends in a vault item bound to the
// server's host and a hub row that names it; a vendor with no registration asks for the person's own
// app and works with one; a vendor that stops offering registration falls back to a token; a pasted
// token is stored and used as the preset says (header, format, extra headers); a preset that is not
// available, a name that does not fit its preset, a second connection under one name and a token
// from anyone but a person are each refused in plain words; a rotated refresh token is saved only
// into an item a connection made; and no secret reaches a result, an event, a log line or the table.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { connections, MIGRATIONS } from "./connect.js";
import { makeCatalog } from "../connector-presets/index.js";
import { startFakeAuthServer } from "./testing/fake-oauth.js";

const TOKEN = "tok_" + "n".repeat(20) + "SECRET1";

function catalogFor(origin, extra = []) {
  return makeCatalog({
    checked: "test",
    presets: [
      { id: "notion", label: "Notion", group: "work", url: `${origin}/mcp`, transport: "http", who: "Anyone.", evidence: "dcr-registered", oauth: { client: "dcr" } },
      { id: "asana", label: "Asana", group: "work", url: `${origin}/mcp`, transport: "http", who: "Anyone.", evidence: "docs", oauth: { client: "byo", help: "Make an app.", port: 53699 } },
      { id: "linear", label: "Linear", group: "work", url: `${origin}/mcp`, transport: "http", who: "Anyone.", evidence: "dcr-registered", oauth: { client: "dcr" },
        token: { label: "API key", help: "In Linear.", header: "x-api-key", format: "{value}", extra: [{ name: "locationId", header: "locationId", label: "Location ID", required: false }] } },
      { id: "monday", label: "monday", group: "work", url: `${origin}/mcp`, transport: "http", who: "Anyone.", evidence: "docs", prefer: "token", oauth: { client: "dcr" }, token: { label: "Token", help: "Somewhere." } },
      ...extra,
    ],
    unavailable: [{ id: "slack", label: "Slack", status: "unavailable", reason: "No automatic registration." }],
  }, { loopback: true });
}

function rig(t, fake, opts = {}) {
  const db = new DatabaseSync(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const items = new Map();
  const saved = [];
  const servers = new Map();
  const credentials = [];
  const updates = [];
  const stored = [];
  const events = [];
  const lines = [];
  const out = [];
  const c = connections({
    db,
    catalog: catalogFor(fake.origin),
    fetchItem: async (item, field) => { const v = items.get(item); if (!v) throw new Error(`${item} is not granted`); if (!(field in v)) throw new Error(`no field ${field}`); return v[field]; },
    save: async (item, fields, o) => { saved.push({ item, fields, ...o }); items.set(item, { ...(items.get(item) || {}), ...fields }); },
    addServer: async input => { servers.set(input.name, input); return { name: input.name, test: { ok: true, tools: 3 } }; },
    testServer: async name => ({ ok: true, tools: 3, name }),
    hasServer: async name => servers.get(name) || null,
    removeServer: async name => { servers.delete(name); },
    updateServer: async input => { updates.push(input); },
    putCredential: async (name, cred, as) => { credentials.push({ name, ...cred, as }); },
    storeTokens: async (name, tokens) => { stored.push({ name, tokens }); },
    emit: (type, payload) => events.push({ type, payload }),
    log: (m, x) => lines.push(`${m} ${JSON.stringify(x || {})}`),
    ...opts,
  });
  t.after(() => c.stop());
  const keep = async p => { try { const r = await p; out.push(r); return r; } catch (e) { out.push(String(/** @type {any} */ (e).message)); throw e; } };
  const leak = extra => {
    const everything = JSON.stringify([out, events, lines, db.prepare("SELECT * FROM connectors_connections").all()]);
    for (const v of [...fake.tokens.keys(), TOKEN, ...extra]) assert.ok(!everything.includes(v), `a value leaked: ${v.slice(0, 10)}...`);
  };
  return { c, db, items, saved, servers, credentials, updates, stored, events, lines, out, keep, leak };
}

const PERSON = { person: true };

test("automatic sign-in: registers, signs in, saves a host-bound item and adds the hub row", async t => {
  const fake = await startFakeAuthServer(t, { dcr: true });
  const r = rig(t, fake);
  const s = await r.keep(r.c.start({ preset: "notion" }, PERSON));
  assert.equal(s.step, "open");
  assert.equal(s.name, "notion");
  assert.ok(fake.calls.some(x => x.path === "/register"), "it registered a client");
  const done = await r.keep(r.c.finish({ id: s.id, url: fake.consent(s.url) }));
  assert.equal(done.step, "connected");
  assert.equal(done.tools, 3);
  const save = r.saved[0];
  assert.equal(save.item, "notion-auth");
  assert.deepEqual(save.hosts, [fake.origin]);
  assert.equal(save.kind, "env-set");
  assert.equal(save.fields.resource, `${fake.origin}/mcp`);
  assert.ok(save.fields.refresh_token && save.fields.access_token && save.fields.client_id);
  assert.equal(save.fields.client_secret, undefined, "a public client has no secret");
  assert.deepEqual(r.servers.get("notion").auth, { type: "oauth", item: "notion-auth" });
  assert.equal(r.servers.get("notion").url, `${fake.origin}/mcp`);
  assert.deepEqual(r.events.map(e => e.type), ["connectors.connected"]);
  assert.equal(r.c.list()[0].name, "notion");
  assert.equal((await r.c.catalog()).presets.find(p => p.id === "notion").connected[0].name, "notion");
  r.leak([]);
});

test("a second account has its own name, item and row; the same name is refused", async t => {
  const fake = await startFakeAuthServer(t, { dcr: true });
  const r = rig(t, fake);
  for (const label of [undefined, "Work Team"]) {
    const s = await r.c.start({ preset: "notion", label }, PERSON);
    await r.c.finish({ id: s.id, url: fake.consent(s.url) });
  }
  assert.deepEqual([...r.servers.keys()].sort(), ["notion", "notion-work-team"]);
  assert.deepEqual(r.saved.map(x => x.item), ["notion-auth", "notion-work-team-auth"]);
  await assert.rejects(r.c.start({ preset: "notion" }, PERSON), /already connected/);
  await assert.rejects(r.c.start({ preset: "notion", name: "linear-work" }, PERSON), /named notion or starts with notion-/);
  // replace signs in again over the same row
  const s = await r.c.start({ preset: "notion", replace: true }, PERSON);
  await r.c.finish({ id: s.id, url: fake.consent(s.url) });
  assert.equal(r.servers.size, 2);
});

test("a vendor with no registration asks for the person's own app, then works with one", async t => {
  const fake = await startFakeAuthServer(t, { dcr: false });
  const r = rig(t, fake);
  const need = await r.keep(r.c.start({ preset: "asana" }, PERSON));
  assert.equal(need.step, "needs");
  assert.equal(need.needs, "client");
  assert.equal(need.redirect, "http://127.0.0.1:53699/connect/callback");
  const client = fake.registerClient("app-secret-value-1");
  r.items.set("asana-app", client);
  const s = await r.keep(r.c.start({ preset: "asana", client: "asana-app" }, PERSON));
  assert.equal(s.step, "open");
  assert.equal(new URL(s.redirect).port, "53699", "the redirect address is the one the person typed into the vendor");
  await r.c.finish({ id: s.id, url: fake.consent(s.url) });
  assert.equal(r.saved[0].fields.client_secret, "app-secret-value-1");
  r.leak(["app-secret-value-1"]);
});

test("a vendor that stopped offering registration falls back to its token", async t => {
  const fake = await startFakeAuthServer(t, { dcr: false });
  const r = rig(t, fake);
  const need = await r.c.start({ preset: "linear" }, PERSON);
  assert.equal(need.step, "needs");
  assert.equal(need.needs, "token");
  assert.match(need.help, /no longer registers apps automatically/);
});

test("a token is stored as the preset says and never comes back out", async t => {
  const fake = await startFakeAuthServer(t, { dcr: false });
  const r = rig(t, fake);
  const need = await r.keep(r.c.start({ preset: "linear", mode: "token" }, PERSON));
  assert.equal(need.needs, "token");
  assert.deepEqual(need.extra, [{ name: "locationId", label: "Location ID", required: false }]);
  const done = await r.keep(r.c.start({ preset: "linear", mode: "token", token: TOKEN, extra: { locationId: "loc_123" } }, PERSON));
  assert.equal(done.step, "connected");
  assert.deepEqual(r.saved[0], { item: "linear-auth", fields: { value: TOKEN }, kind: "api-key", description: "Linear token (made by Vyre)", hosts: [fake.origin] });
  const row = r.servers.get("linear");
  assert.deepEqual(row.auth, { type: "bearer", item: "linear-auth", field: "value", header: "x-api-key", format: "{value}" });
  assert.deepEqual(row.headers, { locationId: "loc_123" });
  r.leak([]);
  // the token also flows through the tool's error path without leaking
  await assert.rejects(r.c.start({ preset: "monday", token: "line\nbreak" }, PERSON), /one line/);
});

test("prefer: a preset that prefers its token asks for it first; a token needs a person", async t => {
  const fake = await startFakeAuthServer(t, { dcr: true });
  const r = rig(t, fake);
  assert.equal((await r.c.start({ preset: "monday" }, PERSON)).needs, "token");
  await assert.rejects(r.c.start({ preset: "monday", token: TOKEN }, { person: false }), /pasted by the person/);
  assert.equal(r.saved.length, 0);
});

test("unavailable vendors and unknown presets are refused with the reason", async t => {
  const fake = await startFakeAuthServer(t, { dcr: true });
  const r = rig(t, fake);
  await assert.rejects(r.c.start({ preset: "slack" }, PERSON), /Slack cannot be connected: No automatic registration/);
  await assert.rejects(r.c.start({ preset: "nope" }, PERSON), /no connector named nope/);
  assert.deepEqual((await r.c.catalog({ all: true })).unavailable.map(u => u.id), ["slack"]);
  assert.equal((await r.c.catalog()).unavailable, undefined);
  assert.deepEqual((await r.c.catalog()).presets.map(p => p.setup), ["none", "app", "none", "token"]);
});

test("persist: only an item a connection made, only sign-in fields, other fields kept", async t => {
  const fake = await startFakeAuthServer(t, { dcr: true });
  const r = rig(t, fake);
  const s = await r.c.start({ preset: "notion" }, PERSON);
  await r.c.finish({ id: s.id, url: fake.consent(s.url) });
  const before = { ...r.items.get("notion-auth") };
  await r.c.persist({ item: "notion-auth", fields: { refresh_token: "rt_new_value_1234", access_token: "at_new_value_1234", expires_at: "1" } });
  const after = r.items.get("notion-auth");
  assert.equal(after.refresh_token, "rt_new_value_1234");
  assert.equal(after.client_id, before.client_id);
  assert.equal(after.token_uri, before.token_uri);
  await assert.rejects(r.c.persist({ item: "vault-elsewhere", fields: { refresh_token: "x".repeat(8) } }), /not a connector sign-in/);
  await assert.rejects(r.c.persist({ item: "notion-auth", fields: { hosts: "evil.example" } }), /not a field a refresh changes/);
  for (const f of ["token_uri", "client_id", "issuer", "resource", "client_secret", "token_auth"]) await assert.rejects(r.c.persist({ item: "notion-auth", fields: { [f]: "https://evil.example/x" } }), /not a field a refresh changes/, f);
  assert.equal(r.items.get("notion-auth").token_uri, before.token_uri, "the token address is untouched");
});

test("disconnect removes the row and the record and leaves the vault item", async t => {
  const fake = await startFakeAuthServer(t, { dcr: true });
  const r = rig(t, fake);
  const s = await r.c.start({ preset: "notion" }, PERSON);
  await r.c.finish({ id: s.id, url: fake.consent(s.url) });
  await r.c.disconnect({ name: "notion" });
  assert.equal(r.servers.size, 0);
  assert.equal(r.c.list().length, 0);
  assert.ok(r.items.has("notion-auth"));
  await assert.rejects(r.c.disconnect({ name: "notion" }), /no connection notion/);
});

test("a cancelled sign-in leaves nothing behind", async t => {
  const fake = await startFakeAuthServer(t, { dcr: true });
  const r = rig(t, fake);
  const s = await r.c.start({ preset: "notion" }, PERSON);
  await r.c.cancel({ id: s.id });
  assert.equal(r.saved.length, 0);
  assert.equal(r.servers.size, 0);
  assert.deepEqual(r.events.map(e => e.type), ["connectors.connect-failed"]);
});

test("guided own-app sign-in: the guide, the app typed in on a person's screen, an https redirect pasted back, a Basic secret", async t => {
  const fake = await startFakeAuthServer(t, { dcr: false });
  const manifest = { link: "https://api.example.com/apps?new_app=1&manifest_json=", json: { oauth_config: { redirect_urls: ["{redirect}"] } } };
  const extra = [{ id: "guided", label: "Guided", group: "work", url: `${fake.origin}/mcp`, transport: "http", who: "Anyone.", evidence: "docs",
    oauth: { client: "byo", port: 53688, redirect: { scheme: "https", host: "127.0.0.1", path: "/connect/callback" }, basic: true, help: "Make an app.",
      guide: { manifest, steps: ["Make the app.", "Add {redirect} as its redirect."], links: [{ label: "Console", url: "https://example.com/console" }] } } }];
  const r = rig(t, fake, { catalog: catalogFor(fake.origin, extra) });
  const need = await r.keep(r.c.start({ preset: "guided" }, PERSON));
  assert.equal(need.needs, "client");
  assert.equal(need.redirect, "https://127.0.0.1:53688/connect/callback");
  assert.deepEqual(need.fields.map(f => [f.name, f.secret]), [["client_id", false], ["client_secret", true]]);
  assert.equal(need.guide.steps[1], "Add https://127.0.0.1:53688/connect/callback as its redirect.");
  assert.equal(need.guide.links[0].label, "Make the app with its settings filled in");
  const made = JSON.parse(decodeURIComponent(need.guide.links[0].url.split("manifest_json=")[1]));
  assert.deepEqual(made.oauth_config.redirect_urls, ["https://127.0.0.1:53688/connect/callback"]);
  assert.equal(need.guide.links[1].url, "https://example.com/console");

  // the app is entered by a person; it goes to the vault as <name>-app, granted to this module only
  await assert.rejects(r.c.start({ preset: "guided", app: { client_id: "x", client_secret: "y" } }, { person: false }), /entered by the person/);
  const client = fake.registerClient("app-secret-value-2");
  const s = await r.keep(r.c.start({ preset: "guided", app: { client_id: client.client_id, client_secret: client.client_secret } }, PERSON));
  assert.equal(s.step, "open");
  assert.equal(s.redirect, "https://127.0.0.1:53688/connect/callback");
  assert.deepEqual(r.saved[0], { item: "guided-app", fields: { client_id: client.client_id, client_secret: "app-secret-value-2" }, kind: "env-set", description: "Guided OAuth app (made by Vyre)", hosts: [], grants: ["connectors"] });
  // nothing listens on an https redirect: only the pasted address finishes it
  await r.c.finish({ id: s.id, url: fake.consent(s.url) });
  assert.ok(fake.calls.some(c => c.method === "BASIC"), "the secret went in a Basic header");
  assert.equal(r.saved[1].fields.token_auth, "basic");
  assert.equal(r.saved[1].fields.client_secret, "app-secret-value-2");
  r.leak(["app-secret-value-2"]);

  // a second sign-in of the same app reuses the stored one: no prompt
  const again = await r.c.start({ preset: "guided", name: "guided-work" }, PERSON);
  assert.equal(again.needs, "client", "a second account has its own name, so it asks for its own app");
});

test("a localhost redirect with the root path, for a vendor that matches only that (Microsoft's shape)", async t => {
  const fake = await startFakeAuthServer(t, { dcr: false });
  const extra = [{ id: "local", label: "Local", group: "work", url: `${fake.origin}/mcp`, transport: "http", who: "Anyone.", evidence: "docs",
    oauth: { client: "byo", redirect: { host: "localhost", path: "/" }, help: "Make an app." } }];
  const r = rig(t, fake, { catalog: catalogFor(fake.origin, extra) });
  const client = fake.registerClient(null);
  r.items.set("local-app", { client_id: client.client_id });
  const s = await r.c.start({ preset: "local" }, PERSON);
  assert.match(s.redirect, /^http:\/\/localhost:\d+\/$/);
  await r.c.finish({ id: s.id, url: fake.consent(s.url) });
  assert.equal(r.saved.at(-1).fields.client_secret, undefined, "a public client has no secret");
});

test("an api preset with a token makes a person-written api-credential, as the caller who asked, and no hub server", async t => {
  const fake = await startFakeAuthServer(t, { dcr: false });
  const extra = [{ id: "webapi", label: "Web API", group: "work", target: "api", who: "Anyone.", evidence: "docs", api: { hosts: ["api.example.test"], use: "Use vault.request.", readers: [{ module: "connectors", paths: ["/v1/calendar*"] }] },
    token: { label: "Token", help: "Somewhere." } }];
  const r = rig(t, fake, { catalog: catalogFor(fake.origin, extra) });
  assert.equal((await r.c.start({ preset: "webapi" }, { person: true, as: "cli" })).needs, "token");
  const done = await r.keep(r.c.start({ preset: "webapi", token: TOKEN }, { person: true, as: "deck" }));
  assert.deepEqual(done.use, { tool: "vault.request", credential: "webapi", hosts: ["api.example.test"], how: "Use vault.request." });
  assert.deepEqual(r.credentials, [{ name: "webapi", config: { auth: { type: "bearer" }, hosts: ["api.example.test"], readers: [{ module: "connectors", paths: ["/v1/calendar*"] }] }, secret: TOKEN, description: "Web API (made by Vyre)", as: "deck" }]);
  assert.equal(r.servers.size, 0, "an api connection is not a hub server");
  assert.equal(r.saved.length, 0, "and it is not a plain vault item either");
  assert.equal((await r.c.catalog()).presets.find(p => p.id === "webapi").target, "api");
  await r.c.disconnect({ name: "webapi" });
  assert.equal(r.c.list().length, 0);
  r.leak([]);
});

test("an api preset with an own-app sign-in: the credential is made without a secret, then the sign-in is sealed into it", async t => {
  const fake = await startFakeAuthServer(t, { dcr: false });
  const extra = [{ id: "graphish", label: "Graphish", group: "work", target: "api", who: "Anyone.", evidence: "docs", api: { hosts: ["graph.example.test"] },
    oauth: { client: "byo", public: true, redirect: { host: "localhost", path: "/" }, scopes: ["Mail.ReadWrite", "offline_access"], help: "Register an app.",
      server: { issuer: fake.origin, authorize_uri: `${fake.origin}/authorize`, token_uri: `${fake.origin}/token` } } }];
  const r = rig(t, fake, { catalog: catalogFor(fake.origin, extra) });
  const need = await r.c.start({ preset: "graphish" }, { person: true, as: "cli" });
  assert.equal(need.needs, "client");
  assert.equal(need.fields.find(f => f.name === "client_secret").required, false, "a public client needs no secret");
  const client = fake.registerClient(null);
  const s = await r.keep(r.c.start({ preset: "graphish", app: { client_id: client.client_id } }, { person: true, as: "capsule" }));
  assert.match(s.redirect, /^http:\/\/localhost:\d+\/$/);
  assert.equal(new URL(s.url).searchParams.get("scope"), "Mail.ReadWrite offline_access");
  const done = await r.keep(r.c.finish({ id: s.id, url: fake.consent(s.url) }));
  assert.equal(done.step, "connected");
  assert.equal(done.use.credential, "graphish");
  assert.equal(r.saved[0].item, "graphish-app");
  assert.deepEqual(r.credentials[0].config, { auth: { type: "oauth", client: { item: "graphish-app" }, authorize_uri: `${fake.origin}/authorize`, token_uri: `${fake.origin}/token`, scopes: ["Mail.ReadWrite", "offline_access"] }, hosts: ["graph.example.test"] });
  assert.equal(r.credentials[0].secret, undefined);
  assert.equal(r.credentials[0].as, "capsule", "written as the person who started the sign-in");
  assert.equal(r.stored[0].name, "graphish");
  assert.equal(r.stored[0].tokens.token_uri, `${fake.origin}/token`);
  assert.ok(r.stored[0].tokens.refresh_token && r.stored[0].tokens.access_token);
  assert.equal(r.servers.size, 0);
  assert.equal(r.c.list()[0].name, "graphish");
});

test("an api preset made from a connector declaration makes a credential that is a connector: endpoint classes, rate and service rules come with the sign-in", async t => {
  const fake = await startFakeAuthServer(t, { dcr: false });
  const extra = [{ id: "billapi", label: "Billing", group: "finance", target: "api", who: "Anyone.", evidence: "docs", api: { hosts: ["api.stripe.com"], declaration: "stripe" },
    oauth: { client: "byo", public: true, redirect: { host: "localhost", path: "/" }, scopes: ["read_write"], help: "Register an app.", server: { issuer: fake.origin, authorize_uri: `${fake.origin}/authorize`, token_uri: `${fake.origin}/token` } } }];
  const r = rig(t, fake, { catalog: catalogFor(fake.origin, extra) });
  const client = fake.registerClient(null);
  const s = await r.c.start({ preset: "billapi", app: { client_id: client.client_id } }, { person: true, as: "cli" });
  const done = await r.c.finish({ id: s.id, url: fake.consent(s.url) });
  assert.equal(done.step, "connected");
  const cfg = r.credentials[0].config;
  assert.deepEqual(cfg.hosts, ["api.stripe.com"]);
  assert.equal(cfg.auth.type, "oauth");
  const vault = (await import("../../core/vault/api-request.js")).normalize({ ...cfg, auth: { ...cfg.auth, authorize_uri: "https://sign-in.example.test/a", token_uri: "https://sign-in.example.test/t" } });
  const { DECLARATIONS } = await import("../../records/connectors/index.js");
  assert.equal(vault.service.allow.length, Object.keys(DECLARATIONS.stripe.ops).length, "the declaration's ops are the only routes");
  assert.equal(vault.service.ops.find(o => o.name === "refunds.create").outward, true);
  assert.deepEqual(vault.service.idempotency, { header: "Idempotency-Key" });
  // a preset naming a connector this build does not declare, or a host it does not own, is refused
  assert.throws(() => catalogFor(fake.origin, [{ ...extra[0], id: "otherapi", api: { hosts: ["api.stripe.com"], declaration: "nope" } }]), /declares/);
  assert.throws(() => catalogFor(fake.origin, [{ ...extra[0], id: "otherapi", api: { hosts: ["elsewhere.example.test"], declaration: "stripe" } }]), /declares/);
  // and Google is never a vault credential: one Google path, the google module
  assert.throws(() => catalogFor(fake.origin, [{ ...extra[0], id: "mailapi", api: { hosts: ["gmail.googleapis.com"], declaration: "gmail" } }]), /google module/);
});

test("an api sign-in whose token store fails takes back the credential it made, and no connection is recorded", async t => {
  const fake = await startFakeAuthServer(t, { dcr: false });
  const extra = [{ id: "graphish", label: "Graphish", group: "work", target: "api", who: "Anyone.", evidence: "docs", api: { hosts: ["graph.example.test"] },
    oauth: { client: "byo", public: true, redirect: { host: "localhost", path: "/" }, scopes: ["Mail.ReadWrite"], help: "Register an app.",
      server: { issuer: fake.origin, authorize_uri: `${fake.origin}/authorize`, token_uri: `${fake.origin}/token` } } }];
  const removed = [];
  const r = rig(t, fake, { catalog: catalogFor(fake.origin, extra), storeTokens: async () => { throw new Error("the vault refused the tokens"); },
    removeCredential: async (name, as) => { removed.push({ name, as }); } });
  const client = fake.registerClient(null);
  const s = await r.c.start({ preset: "graphish", app: { client_id: client.client_id } }, { person: true, as: "capsule" });
  await assert.rejects(r.c.finish({ id: s.id, url: fake.consent(s.url) }), /refused the tokens/);
  assert.deepEqual(removed, [{ name: "graphish", as: "capsule" }]);
  assert.deepEqual(r.c.list(), []);
});

test("the # picker: connected apps first, then a Connect row for each app not connected; a tag grants the thread", async t => {
  const fake = await startFakeAuthServer(t, { dcr: true });
  const granted = [];
  const r = rig(t, fake, { grantThread: async (server, thread) => { granted.push([server, thread]); } });
  assert.deepEqual(r.c.mentionSearch({ q: "notion" }), [{ kind: "connector", id: "connect:notion", name: "Connect Notion", hint: "Not connected", icon: "plug" }]);
  const s = await r.c.start({ preset: "notion", label: "Work" }, PERSON);
  await r.c.finish({ id: s.id, url: fake.consent(s.url) });
  const all = r.c.mentionSearch({});
  assert.deepEqual(all[0], { kind: "connector", id: "notion-work", name: "Notion (Work)", hint: "Connected", icon: "plug" });
  assert.ok(all.slice(1).every(x => x.id.startsWith("connect:") && x.name.startsWith("Connect ")));
  assert.ok(!all.some(x => x.id === "connect:notion"), "a connected app has no Connect row");
  assert.equal(r.c.mentionSearch({ q: "zzz" }).length, 0);
  assert.equal(r.c.mentionSearch({ limit: 2 }).length, 2);

  const res = await r.c.mentionResolve({ id: "notion-work", thread: "t-9" });
  assert.deepEqual(granted, [["notion-work", "t-9"]]);
  assert.deepEqual(res.grant, { use: true, hosts: ["127.0.0.1"] });
  assert.match(res.note, /notion-work__<tool>/);
  await assert.rejects(r.c.mentionResolve({ id: "connect:asana", thread: "t-9" }), /no connection/);
  await assert.rejects(r.c.mentionResolve({ id: "nothing", thread: "t-9" }), /no connection/);
  r.leak([]);
});

test("a sign-in host is shown, and a same-named server that is not this connection is never taken over", async t => {
  const fake = await startFakeAuthServer(t, { dcr: true });
  const r = rig(t, fake);
  r.servers.set("notion", { name: "notion", url: "https://elsewhere.example/mcp", auth: { type: "bearer", item: "other" } });
  const s = await r.c.start({ preset: "notion", replace: true }, PERSON);
  assert.equal(s.host, new URL(fake.origin).host);
  await assert.rejects(r.c.finish({ id: s.id, url: fake.consent(s.url) }), /already exists and is not this Notion connection/);
  assert.equal(r.c.list().length, 0, "nothing was recorded");
  // the same row, made by this connection earlier, is fine
  r.servers.set("notion", { name: "notion", url: `${fake.origin}/mcp`, auth: { type: "oauth", item: "notion-auth" } });
  const s2 = await r.c.start({ preset: "notion", replace: true }, PERSON);
  assert.equal((await r.c.finish({ id: s2.id, url: fake.consent(s2.url) })).step, "connected");
});

test("a connection's scope (who may use it) goes to the hub row and into an api-credential's config; nothing written means the default", async t => {
  const fake = await startFakeAuthServer(t, { dcr: true });
  const extra = [{ id: "webapi", label: "Web API", group: "work", target: "api", who: "Anyone.", evidence: "docs", api: { hosts: ["api.example.test"] }, token: { label: "Token", help: "Somewhere." } },
    { id: "graphish", label: "Graphish", group: "work", target: "api", who: "Anyone.", evidence: "docs", api: { hosts: ["graph.example.test"] },
      oauth: { client: "byo", public: true, scopes: ["a"], help: "x", server: { issuer: fake.origin, authorize_uri: `${fake.origin}/authorize`, token_uri: `${fake.origin}/token` } } }];
  const r = rig(t, fake, { catalog: catalogFor(fake.origin, extra) });
  const scope = { projects: ["harlow-site"], agents: ["kit"] };
  // a hub server gets it on its row
  const s = await r.c.start({ preset: "notion", scope }, PERSON);
  await r.c.finish({ id: s.id, url: fake.consent(s.url) });
  assert.deepEqual(r.servers.get("notion").scope, scope);
  // a token credential gets it in its config; a partial scope fills the other side with "*"
  await r.c.start({ preset: "webapi", token: TOKEN, scope: { agents: ["kit"] } }, { person: true, as: "cli" });
  assert.deepEqual(r.credentials[0].config.scope, { projects: "*", agents: ["kit"] });
  // an own-app sign-in carries it through to the credential it makes
  const client = fake.registerClient(null);
  const g = await r.c.start({ preset: "graphish", app: { client_id: client.client_id }, scope }, { person: true, as: "capsule" });
  await r.c.finish({ id: g.id, url: fake.consent(g.url) });
  assert.deepEqual(r.credentials[1].config.scope, scope);
  // none given: none written
  await r.c.start({ preset: "webapi", name: "webapi-two", token: TOKEN }, { person: true, as: "cli" });
  assert.equal(r.credentials[2].config.scope, undefined);
  // a bad scope is refused before anything is made
  for (const bad of ["everyone", [], { projects: "harlow" }, { agents: ["a b"] }, { agents: [1] }]) {
    await assert.rejects(r.c.start({ preset: "webapi", name: "webapi-bad", token: TOKEN, scope: bad }, PERSON), /scope/, JSON.stringify(bad));
  }
  assert.equal(r.credentials.length, 3);
});

test("changing who may use a connection: a hub server's row, an api credential rebuilt without its secret, null for the default, and the catalog shows it", async t => {
  const fake = await startFakeAuthServer(t, { dcr: true });
  const extra = [{ id: "webapi", label: "Web API", group: "work", target: "api", who: "Anyone.", evidence: "docs", api: { hosts: ["api.example.test"], readers: [{ module: "connectors", paths: ["/v1/calendar"] }] },
    token: { label: "Token", help: "Somewhere.", header: "x-api-key", format: "{value}" } }];
  const r = rig(t, fake, { catalog: catalogFor(fake.origin, extra) });
  const s = await r.c.start({ preset: "notion" }, PERSON);
  await r.c.finish({ id: s.id, url: fake.consent(s.url) });
  await r.c.start({ preset: "webapi", token: TOKEN }, { person: true, as: "cli" });
  const scopeOf = async name => (await r.c.catalog()).presets.flatMap(p => p.connected).find(c => c.name === name).scope;
  assert.equal(await scopeOf("notion"), null, "made with none: the default");
  assert.equal(await scopeOf("webapi"), null);

  // a hub server: the row is updated and the connection remembers it
  const one = { projects: ["harlow-site"], agents: "*" };
  assert.deepEqual(await r.c.setScope({ name: "notion", scope: one }, { as: "deck" }), { name: "notion", scope: one });
  assert.deepEqual(r.updates.at(-1), { name: "notion", scope: one });
  assert.deepEqual(await scopeOf("notion"), one);
  assert.deepEqual(r.c.list().find(c => c.name === "notion").scope, one);
  // null resets to the hub's own default (you and the assistant only)
  await r.c.setScope({ name: "notion", scope: null }, { as: "deck" });
  assert.deepEqual(r.updates.at(-1), { name: "notion", scope: null }, "null is the hub's own default");
  assert.equal(await scopeOf("notion"), null);

  // an api credential: rebuilt from its preset with the scope and the readers, written as the asker, with no secret
  const two = { projects: "*", agents: ["kit"] };
  await r.c.setScope({ name: "webapi", scope: two }, { as: "capsule" });
  const made = r.credentials.at(-1);
  assert.deepEqual(made, { name: "webapi", config: { auth: { type: "bearer", header: "x-api-key", format: "{value}" }, hosts: ["api.example.test"], readers: [{ module: "connectors", paths: ["/v1/calendar"] }], scope: two },
    description: "Web API (made by Vyre)", as: "capsule" });
  assert.equal(made.secret, undefined, "no secret: the vault keeps the stored one");
  assert.deepEqual(await scopeOf("webapi"), two);
  await r.c.setScope({ name: "webapi", scope: null }, { as: "capsule" });
  assert.equal(r.credentials.at(-1).config.scope, undefined);

  await assert.rejects(r.c.setScope({ name: "nothing", scope: one }), /no connection/);
  await assert.rejects(r.c.setScope({ name: "notion", scope: "everyone" }), /scope is/);
  assert.ok(r.events.some(e => e.type === "connectors.scope-changed"));
  r.leak([]);
});

test("connections made before 'no scope means you and the assistant only' stay open; the api apps keep no scope", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(MIGRATIONS[0]);
  db.exec(MIGRATIONS[1]);
  const put = (name, preset, scope) => db.prepare("INSERT INTO connectors_connections (name, preset, item, mode, label, created, scope) VALUES (?,?,?,?,?,?,?)").run(name, preset, name, "oauth", null, 1, scope);
  put("notion", "notion", null);
  put("linear-work", "linear", null);
  put("microsoft", "microsoft", null);
  put("slack-web", "slack-web", null);
  put("asana", "asana", '{"projects":["harlow"],"agents":"*"}');
  for (const m of MIGRATIONS.slice(2)) db.exec(m);
  const got = Object.fromEntries(db.prepare("SELECT name, scope FROM connectors_connections").all().map(r => [r.name, r.scope && JSON.parse(r.scope)]));
  assert.deepEqual(got.notion, { projects: "*", agents: "*" }, "an old hub-server connection stays open, as its row is");
  assert.deepEqual(got["linear-work"], { projects: "*", agents: "*" });
  assert.equal(got.microsoft, null, "a credential app had no scope and stays you and the assistant only");
  assert.equal(got["slack-web"], null);
  assert.deepEqual(got.asana, { projects: ["harlow"], agents: "*" }, "a written scope is untouched");
});

test("the catalog has no Google api preset: Gmail and Calendar are signed in through the google module, so there is one Google path", async () => {
  const { preset } = await import("../connector-presets/index.js");
  for (const id of ["google-api", "gmail-api", "google-calendar-api"]) assert.equal(preset(id), null, id);
  const { DECLARATIONS } = await import("../../records/connectors/index.js");
  assert.equal(DECLARATIONS.gmail.auth.type, "google"); assert.equal(DECLARATIONS["google-calendar"].auth.type, "google");
});

