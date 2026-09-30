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

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { connections, MIGRATIONS } from "./connect.js";
import { makeCatalog } from "../../lib/connector-presets/index.js";
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
    hasServer: async name => servers.has(name),
    removeServer: async name => { servers.delete(name); },
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
  return { c, db, items, saved, servers, events, lines, out, keep, leak };
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
  await assert.rejects(r.c.persist({ item: "notion-auth", fields: { hosts: "evil.example" } }), /not a sign-in field/);
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
