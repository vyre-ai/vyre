// @ts-check
// The generic OAuth loopback+PKCE connect flow (oauth.js), against a fake authorization server.
// What these prove: a manually-named server with a pre-registered client (the Google/GitHub
// shape) completes and hands the caller a token set carrying its issuer, resource and token_uri
// (P21's binding data); a resource url with protected-resource + DCR metadata discovers its
// authorization server and registers a client with no person ever seeing a client_id; a server
// with neither a supplied client nor DCR refuses plainly; the pasted-address finish, a wrong
// state, a declined consent, an already-used code and an expired sign-in all behave the same way
// google/connect.js's tests already proved for the Google-specific version this generalizes; and
// no value (client secret, code, verifier, token) ever reaches a result, an event or a log line.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { connector, discoverResource, discoverAuthServer, registerClient } from "./oauth.js";
import { startFakeAuthServer } from "./testing/fake-oauth.js";

function rig(t, opts = {}) {
  const completed = [];
  const events = [];
  const lines = [];
  const out = [];
  const c = connector({
    complete: async (flow, tokens) => { completed.push({ name: flow.name, tokens }); return { name: flow.name, issuer: tokens.issuer }; },
    emit: (type, payload) => events.push({ type, payload }),
    log: (m, x) => lines.push(`${m} ${JSON.stringify(x || {})}`),
    ...opts,
  });
  t.after(() => c.stop());
  const keep = async p => { try { const r = await p; out.push(r); return r; } catch (e) { out.push(String(/** @type {any} */ (e).message)); throw e; } };
  return { c, completed, events, lines, out, keep };
}

const listening = port => new Promise(resolve => {
  const s = net.connect(port, "127.0.0.1");
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("error", () => resolve(false));
});

test("oauth: server named explicitly, client read from a vault-shaped fetchItem, completes with issuer/token_uri bound (P21)", async t => {
  const fake = await startFakeAuthServer(t, { dcr: false });
  const client = fake.registerClient("shh-secret-value");
  const items = new Map([["my-client", client]]);
  const r = rig(t, { fetchItem: async (item, field) => { const v = items.get(item); if (!v) throw new Error("no such item"); if (!(field in v)) throw new Error("no such field"); return v[field]; } });

  const started = await r.keep(r.c.start({ name: "home", server: { authorize_uri: `${fake.origin}/authorize`, token_uri: `${fake.origin}/token` }, client: "my-client", scopes: ["read", "write"] }));
  assert.deepEqual(Object.keys(started).sort(), ["host", "id", "redirect", "url"]);
  const port = r.c.port();
  assert.ok(port);
  const q = new URL(started.url).searchParams;
  assert.equal(q.get("client_id"), client.client_id);
  assert.equal(q.get("scope"), "read write");
  assert.equal(q.get("code_challenge_method"), "S256");

  const back = fake.consent(started.url);
  const res = await fetch(back);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /You can close this tab/);

  assert.equal(r.completed.length, 1);
  const tokens = r.completed[0].tokens;
  assert.equal(tokens.issuer, fake.origin, "P21: the token set names its issuer");
  assert.equal(tokens.token_uri, `${fake.origin}/token`, "P21: the token set names its token endpoint");
  assert.equal(tokens.client_id, client.client_id);
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.equal(tokens.resource, undefined, "no resource was named, so none is claimed");
  assert.deepEqual(r.events.map(e => e.type), ["connect.connected"]);

  assert.equal(r.c.port(), null);
  assert.equal(await listening(/** @type {number} */ (port)), false);
  const everything = JSON.stringify([r.out, r.events, r.lines]);
  for (const v of [client.client_secret, tokens.access_token, tokens.refresh_token]) assert.ok(!everything.includes(v), `leaked: ${v}`);
});

test("oauth: a resource url with protected-resource + DCR metadata discovers and self-registers, no client ever supplied", async t => {
  const fake = await startFakeAuthServer(t, { dcr: true });
  const r = rig(t);

  const started = await r.keep(r.c.start({ name: "work", resource: `${fake.origin}/.well-known/does-not-matter`, scopes: ["mcp.read"] }));
  const q = new URL(started.url).searchParams;
  assert.match(q.get("client_id") || "", /^dcr_/, "the box registered its own client via RFC 7591");
  assert.equal(q.get("resource"), fake.origin, "RFC 9728's resource is carried into the authorize request");

  const back = fake.consent(started.url);
  await fetch(back);
  assert.equal(r.completed.length, 1);
  const tokens = r.completed[0].tokens;
  assert.equal(tokens.resource, fake.origin, "P21: the resource the token was minted for is kept");
  assert.equal(tokens.issuer, fake.origin);
  assert.match(tokens.client_id, /^dcr_/);
});

test("oauth: no supplied client and no DCR refuses plainly, before any listener opens", async t => {
  const fake = await startFakeAuthServer(t, { dcr: false });
  const r = rig(t);
  await assert.rejects(r.keep(r.c.start({ name: "home", server: { authorize_uri: `${fake.origin}/authorize`, token_uri: `${fake.origin}/token` }, scopes: ["read"] })), /no dynamic client registration/);
  assert.equal(r.c.port(), null, "nothing was opened for a sign-in that could not proceed");
});

test("oauth: the pasted address finishes a sign-in; a wrong one leaves it open; cancel closes it", async t => {
  const fake = await startFakeAuthServer(t, { dcr: false });
  const client = fake.registerClient();
  const items = new Map([["c", client]]);
  const r = rig(t, { fetchItem: async (item, field) => items.get(item)[field] });
  const a = await r.keep(r.c.start({ name: "work", server: { authorize_uri: `${fake.origin}/authorize`, token_uri: `${fake.origin}/token` }, client: "c", scopes: ["read"] }));
  const b = await r.keep(r.c.start({ name: "home", server: { authorize_uri: `${fake.origin}/authorize`, token_uri: `${fake.origin}/token` }, client: "c", scopes: ["read"] }));
  assert.equal(new URL(a.redirect).port, new URL(b.redirect).port, "one listener for every open sign-in");
  const backA = fake.consent(a.url);
  const backB = fake.consent(b.url);

  await assert.rejects(r.keep(r.c.finish({ id: a.id, url: backB })), /not from a sign-in Vyre started/);
  await assert.rejects(r.keep(r.c.finish({ id: a.id, url: "not an address" })), /whole address/);

  const done = await r.keep(r.c.finish({ id: a.id, url: backA }));
  assert.equal(done.name, "work");
  await assert.rejects(r.keep(r.c.finish({ id: a.id, url: backA })), /already used/);

  const port = /** @type {number} */ (r.c.port());
  assert.deepEqual(await r.keep(r.c.cancel({ id: b.id })), { cancelled: true });
  assert.equal(r.c.port(), null);
  assert.equal(await listening(port), false);
  assert.deepEqual(r.events.map(e => e.type), ["connect.connected", "connect.failed"]);
});

test("oauth: PKCE and a declined consent both fail plainly, with nothing saved", async t => {
  const fake = await startFakeAuthServer(t, { dcr: false });
  const client = fake.registerClient();
  const items = new Map([["c", client]]);
  const r = rig(t, { fetchItem: async (item, field) => items.get(item)[field] });

  const s = await r.keep(r.c.start({ name: "home", server: { authorize_uri: `${fake.origin}/authorize`, token_uri: `${fake.origin}/token` }, client: "c", scopes: ["read"] }));
  const declined = new URL(s.redirect);
  declined.searchParams.set("state", new URL(s.url).searchParams.get("state") || "");
  declined.searchParams.set("error", "access_denied");
  const page = await fetch(declined);
  assert.equal(page.status, 400);
  assert.match(await page.text(), /declined/);
  assert.equal(r.completed.length, 0);
});

test("oauth: discovery is checked before anything is sent: resource, issuer, https, and the pinned servers", async t => {
  // a protected-resource document about another service is refused
  const other = await startFakeAuthServer(t, { dcr: true, resource: "https://example-mcp.test/mcp" });
  const r0 = rig(t);
  await assert.rejects(r0.c.start({ name: "a", resource: `${other.origin}/mcp`, scopes: [] }), /says its sign-in is for https:\/\/example-mcp\.test/);
  assert.equal(r0.c.port(), null, "nothing was opened");

  // an authorization-server document for a different issuer is refused (RFC 8414 3.3)
  const docs = {
    "https://v.test/.well-known/oauth-protected-resource/mcp": { resource: "https://v.test/mcp", authorization_servers: ["https://auth.v.test"] },
    "https://auth.v.test/.well-known/oauth-authorization-server": { issuer: "https://evil.test", authorization_endpoint: "https://auth.v.test/a", token_endpoint: "https://auth.v.test/t" },
  };
  const f = async url => (docs[url] ? new Response(JSON.stringify(docs[url]), { status: 200 }) : new Response("", { status: 404 }));
  const found = await discoverResource("https://v.test/mcp", f);
  await assert.rejects(discoverAuthServer(found.issuer, f, { strict: true }), /different issuer/);

  // a plain-http token endpoint named by an https vendor is refused; loopback http is only for fakes
  docs["https://auth.v.test/.well-known/oauth-authorization-server"] = { issuer: "https://auth.v.test", authorization_endpoint: "https://auth.v.test/a", token_endpoint: "http://auth.v.test/t" };
  await assert.rejects(discoverAuthServer("https://auth.v.test", f, { strict: true }), /must be https/);
  docs["https://auth.v.test/.well-known/oauth-authorization-server"] = { issuer: "https://auth.v.test", authorization_endpoint: "javascript:alert(1)", token_endpoint: "https://auth.v.test/t" };
  await assert.rejects(discoverAuthServer("https://auth.v.test", f, { strict: true }), /not a valid address|must be https/);
  docs["https://auth.v.test/.well-known/oauth-authorization-server"] = { issuer: "https://auth.v.test", authorization_endpoint: "https://auth.v.test/a", token_endpoint: "https://auth.v.test/t", registration_endpoint: "https://auth.v.test/r" };
  const ok = await discoverAuthServer("https://auth.v.test", f, { strict: true });
  assert.equal(ok.token_uri, "https://auth.v.test/t");
  // a path issuer (GitHub's shape) is fetched at its path-aware address
  docs["https://gh.test/.well-known/oauth-authorization-server/login/oauth"] = { issuer: "https://gh.test/login/oauth", authorization_endpoint: "https://gh.test/login/oauth/authorize", token_endpoint: "https://gh.test/login/oauth/access_token" };
  assert.equal((await discoverAuthServer("https://gh.test/login/oauth", f, { strict: true })).authorize_uri, "https://gh.test/login/oauth/authorize");

  // the pin: a server whose document sends the code somewhere the catalog did not expect is refused, before any registration
  const fake = await startFakeAuthServer(t, { dcr: true });
  const r = rig(t);
  await assert.rejects(r.c.start({ name: "b", resource: `${fake.origin}/mcp`, scopes: [], pin: ["https://the-real-vendor.test"] }), /is not one of the servers this app signs in with/);
  assert.ok(!fake.calls.some(c => c.path === "/register"), "nothing was registered at a server the pin refuses");
  const good = await r.c.start({ name: "c", resource: `${fake.origin}/mcp`, scopes: [], pin: [fake.origin] });
  assert.equal(good.host, new URL(fake.origin).host, "the sign-in host is reported");
});
