// @ts-check
// An oauth api-credential (Microsoft Graph, Google's REST APIs and anything with a sign-in and no
// hosted MCP), with fakes only: a fake DNS lookup, a fake transport and a controllable clock.
// What these prove: a credential that was never signed in says so; only the connectors module stores
// a sign-in and only when its token endpoint is the one the person's config names; a stored access
// token is used while it is good and refreshed at the config's own token endpoint after that, with the
// client from its vault item; a rotated refresh token is sealed before the call goes on; a refused
// refresh says how to sign in again; and no response, error or audit row carries a token.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import * as saidTools from "./said.js";
import { register } from "./request.js";
import { SCRATCH } from "../../test/scratch.mjs";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const json = (status, body) => ({ status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) });
const TOKEN_URI = "https://login.example-idp.test/oauth2/token";
const CONFIG = { auth: { type: "oauth", client: { item: "graph-app" }, authorize_uri: "https://login.example-idp.test/oauth2/authorize", token_uri: TOKEN_URI, scopes: ["Mail.ReadWrite", "offline_access"] },
  hosts: ["graph.microsoft.com"] };

async function mk(t) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-apioauth-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "harlow-box", vault: { keystore: "file" } }, emit: () => {}, log: () => {} });
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  let clock = 1_800_000_000_000;
  const net = { calls: /** @type {any[]} */ ([]), script: /** @type {(r: any) => any} */ (() => json(200, { ok: true })) };
  const lookup = async () => [{ address: "203.0.113.10", family: 4 }];
  const transport = async r => { net.calls.push({ host: r.url.hostname, path: r.url.pathname, method: r.method, headers: r.headers, body: r.body }); return net.script(r); };
  const tools = new Map();
  const tool = (name, callers, description, input, run) => tools.set(name, { callers, run });
  const internal = (name, description, input, run) => tools.set(name, { callers: null, internal: true, run });
  const said = saidTools.register({ vault: v, internal });
  register({ vault: v, tool, internal, call: async () => ({ error: { code: "no_such_tool", message: "x" } }), said, deps: { lookup, transport, now: () => clock } });
  const run = (name, input, caller = "cli") => tools.get(name).run(input, { caller });
  const client = fake("secret");
  await v.put({ name: "graph-app", kind: "env-set", fields: { client_id: "client-abc-123", client_secret: client } }, "cli");
  await v.put({ name: "graph", kind: "api-credential", fields: { config: JSON.stringify(CONFIG) } }, "cli");
  return { v, net, run, client, advance: ms => { clock += ms; }, now: () => clock,
    secret: async () => JSON.parse((await v.apiCredential("graph")).secret || "null"),
    ask: () => run("vault.request", { credential: "graph", method: "GET", url: "https://graph.microsoft.com/v1.0/me/messages" }) };
}

test("a credential that was never signed in says how to", async t => {
  const m = await mk(t);
  await assert.rejects(m.ask(), /not signed in yet/);
  assert.equal(m.net.calls.length, 0);
});

test("only the connectors module stores a sign-in, and only from the token endpoint the config names", async t => {
  const m = await mk(t);
  const tokens = { access_token: fake("at"), refresh_token: fake("rt"), expires_in: 3600, token_uri: TOKEN_URI };
  for (const who of ["cli", "mcp", "module:mcp", "module:sessions", "module:watchers"]) {
    await assert.rejects(m.run("vault.credential.tokens", { name: "graph", tokens }, who), /only the connectors module/, who);
  }
  await assert.rejects(m.run("vault.credential.tokens", { name: "graph", tokens: { ...tokens, token_uri: "https://evil.example/token" } }, "module:connectors"), /did not come from the token endpoint/);
  await assert.rejects(m.run("vault.credential.tokens", { name: "graph-app", tokens }, "module:connectors"), /not an api-credential/);
  assert.deepEqual(await m.run("vault.credential.tokens", { name: "graph", tokens }, "module:connectors"), { stored: true });
  assert.equal((await m.secret()).refresh_token, tokens.refresh_token);
  // a bearer credential has no sign-in to store
  await m.v.put({ name: "plain", kind: "api-credential", fields: { config: JSON.stringify({ auth: { type: "bearer" }, hosts: ["api.example.test"] }), secret: fake("s") } }, "cli");
  await assert.rejects(m.run("vault.credential.tokens", { name: "plain", tokens }, "module:connectors"), /not an oauth credential/);
});

test("a stored access token is used while good; after that it is refreshed at the config's token endpoint, and a rotation is sealed first", async t => {
  const m = await mk(t);
  const first = { access_token: fake("at1"), refresh_token: fake("rt1"), expires_in: 3600, token_uri: TOKEN_URI };
  await m.run("vault.credential.tokens", { name: "graph", tokens: first }, "module:connectors");

  const r1 = await m.ask();
  assert.equal(m.net.calls.length, 1, "no refresh: the stored token is good");
  assert.equal(m.net.calls[0].headers.authorization, `Bearer ${first.access_token}`);
  assert.equal(r1.status, 200);

  // an hour later the stored token has ended: refresh, with the client from its vault item
  m.advance(3600_000);
  const second = { access_token: fake("at2"), refresh_token: fake("rt2") };
  m.net.script = r => r.url.hostname === "login.example-idp.test" ? json(200, { access_token: second.access_token, refresh_token: second.refresh_token, expires_in: 3600 })
    : json(200, { echoed: r.headers.authorization, leaked: second.access_token });
  const r2 = await m.ask().catch(e => { void 0; throw e; });
  const tokenCall = m.net.calls.find(c => c.host === "login.example-idp.test");
  assert.ok(tokenCall, "it went to the config's own token endpoint");
  const body = new URLSearchParams(tokenCall.body);
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), first.refresh_token);
  assert.equal(body.get("client_id"), "client-abc-123");
  assert.equal(body.get("client_secret"), m.client);
  assert.equal(body.get("scope"), "Mail.ReadWrite offline_access");
  assert.equal(m.net.calls.at(-1).headers.authorization, `Bearer ${second.access_token}`);
  // the new refresh token is sealed, and the response never carries a token
  const sealed = await m.secret();
  assert.equal(sealed.refresh_token, second.refresh_token);
  assert.equal(sealed.access_token, second.access_token);
  const shown = JSON.stringify(r2);
  for (const v of [first.access_token, first.refresh_token, second.access_token, second.refresh_token, m.client]) assert.ok(!shown.includes(v), "a token leaked into the response");
  // the next call reuses it: no second refresh
  const before = m.net.calls.length;
  await m.ask();
  assert.equal(m.net.calls.length, before + 1);
  // and no audit row carries a value
  const trail = JSON.stringify(m.v.auditTrail({ limit: 500 }).entries);
  for (const v of [first.access_token, second.access_token, second.refresh_token, m.client]) assert.ok(!trail.includes(v));
});

test("a refused refresh says how to sign in again and carries no token", async t => {
  const m = await mk(t);
  const first = { access_token: fake("at1"), refresh_token: fake("rt1"), expires_in: 60, token_uri: TOKEN_URI };
  await m.run("vault.credential.tokens", { name: "graph", tokens: first }, "module:connectors");
  m.advance(3600_000);
  m.net.script = () => json(400, { error: "invalid_grant", error_description: `The refresh token ${first.refresh_token} has expired` });
  const err = await m.ask().catch(e => e);
  assert.match(err.message, /invalid_grant/);
  assert.match(err.message, /sign in again/);
  assert.ok(!err.message.includes(first.refresh_token));
});

test("no refresh token and an ended access token asks for a new sign-in", async t => {
  const m = await mk(t);
  await m.run("vault.credential.tokens", { name: "graph", tokens: { access_token: fake("at"), expires_in: 60, token_uri: TOKEN_URI } }, "module:connectors");
  m.advance(3600_000);
  await assert.rejects(m.ask(), /sign-in has ended/);
});

test("two calls that both find the access token ended share one refresh, so a rotating vendor sees one", async t => {
  const m = await mk(t);
  const first = { access_token: fake("at1"), refresh_token: fake("rt1"), expires_in: 60, token_uri: TOKEN_URI };
  await m.run("vault.credential.tokens", { name: "graph", tokens: first }, "module:connectors");
  m.advance(3600_000);
  let refreshes = 0;
  const used = new Set();
  m.net.script = async r => {
    if (r.url.hostname !== "login.example-idp.test") return json(200, { ok: true });
    refreshes++;
    const rt = new URLSearchParams(r.body).get("refresh_token");
    if (used.has(rt)) return json(400, { error: "invalid_grant", error_description: "already used" });
    used.add(rt);
    await new Promise(res => setTimeout(res, 20));
    return json(200, { access_token: fake("at2"), refresh_token: fake("rt2"), expires_in: 3600 });
  };
  const results = await Promise.all([m.ask(), m.ask(), m.ask()]);
  assert.equal(refreshes, 1, "one refresh for three concurrent calls");
  assert.ok(results.every(r => r.status === 200));
  assert.ok((await m.secret()).refresh_token.includes("rt2"), "the rotated token was sealed");
});
