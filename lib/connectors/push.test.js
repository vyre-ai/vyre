// @ts-check
// One Google consent for the hosted MCP and mail push, and the push manager, against the fake
// OAuth server and a fake IMAP server. What these prove: one authorize call asks for the hosted
// scopes and the IMAP scope together, stores one token set bound to Google's issuer and the hosted
// MCP resources, and records the broader scope so the card can say it; the credential library
// refuses that token for any other URL (P21); new mail becomes a vault.push event with ids and
// sender only and no value anywhere; an expired refresh token (Google's 7 day Testing limit) or a
// refused mail scope becomes one vault.push.reconsent event and a state a person can see, never a
// silent dead connection; drops are lost and resumed; and grants follow the {projects, agents} shape.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { googleConnector, IMAP_SCOPE, HOSTED_SCOPES, HOSTED_RESOURCES, SCOPE_NOTE } from "./google.js";
import { pushManager, pushTools, normalizeScope } from "./push.js";
import { Credentials } from "./auth.js";
import { startFakeAuthServer } from "./testing/fake-oauth.js";
import { startFakeImap } from "./testing/fake-imap.js";
import { allowLoopbackForTests } from "../http.js";
allowLoopbackForTests();   // this file runs its fakes on loopback

const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error("timed out waiting"); };
const PERSON = { person: true };

/** Sign in through the fake authorization server and give back everything a push test needs. */
async function signedIn(t, { imap = true, imapOpts = {} } = {}) {
  const auth = await startFakeAuthServer(t, {});
  const client = auth.registerClient("client-secret-value");
  const items = new Map([["oauth-client", client]]);
  const rows = [], events = [];
  const g = googleConnector({
    fetchItem: async (item, field) => { const v = items.get(item); if (!v || !(field in v)) throw new Error("no such field"); return v[field]; },
    save: async (item, fields) => { items.set(item, fields); },
    record: row => { rows.push(row); },
    emit: (type, p) => events.push({ type, p }),
    authUri: `${auth.origin}/authorize`, tokenUri: `${auth.origin}/token`, issuer: auth.origin,
  });
  t.after(() => g.stop());
  const started = await g.start({ name: "home", client: "oauth-client" });
  // What the person unticks on Google's consent screen: drop the IMAP scope from what is granted.
  const url = imap ? started.url : started.url.replace(encodeURIComponent(IMAP_SCOPE), "x");
  const res = await fetch(auth.consent(url));
  assert.equal(res.status, 200);
  const creds = new Credentials({ fetchItem: async (item, field) => { const v = items.get(item); if (!v || !(field in v) || !v[field]) throw new Error("no such field"); return v[field]; } });
  const item = items.get("google-home");
  const fake = await startFakeImap(t, { token: () => lastToken(), ...imapOpts });
  let last = "";
  function lastToken() { return last; }
  // The IMAP server accepts whatever access token the fake OAuth server minted last.
  const realToken = creds.token.bind(creds);
  creds.token = async (a, o) => (last = await realToken(a, o));
  return { auth, items, item, rows, events, creds, fake, started, g, startUrl: started.url };
}

function manager(t, env, extra = {}) {
  const events = [];
  const account = async c => c === "cn_gone" ? null : ({ email: "alex@harlowlegal.com", auth: { type: "oauth", item: "google-home" }, imap: env.rows[0]?.imap ?? true });
  const m = pushManager({
    creds: env.creds, account, emit: (type, p) => events.push({ type, p }),
    connect: async () => net.connect(env.fake.port, "127.0.0.1"),
    backoffMs: 5, maxBackoffMs: 30, noopFloorMs: 0, ...extra,
  });
  t.after(() => m.close());
  return { m, events };
}

test("google: one consent asks for the hosted scopes and the IMAP scope, stores one bound token set, and says so", async t => {
  const env = await signedIn(t);
  const q = new URL(env.startUrl).searchParams;
  const asked = q.get("scope").split(" ");
  for (const s of [...HOSTED_SCOPES, IMAP_SCOPE, "openid", "email"]) assert.ok(asked.includes(s), `asks for ${s}`);
  assert.equal(q.has("resource"), false, "Google's authorize call takes no resource parameter");
  assert.equal(env.rows.length, 1);
  const row = env.rows[0];
  assert.equal(row.email, "alex@harlowlegal.com");
  assert.equal(row.imap, true);
  assert.equal(row.broad, true);
  assert.equal(row.scope_note, SCOPE_NOTE);
  assert.match(SCOPE_NOTE, /all of your Gmail/);
  assert.equal(row.issuer, env.auth.origin);
  assert.deepEqual(row.resources, HOSTED_RESOURCES);
  // One item holds the whole token set with its binding.
  assert.equal(env.item.issuer, env.auth.origin);
  assert.equal(env.item.resource, HOSTED_RESOURCES.join(" "));
  assert.ok(env.item.refresh_token && env.item.scope.includes(IMAP_SCOPE));
  assert.ok(!JSON.stringify([env.rows, env.events]).includes(env.item.refresh_token), "no token reaches a row or an event");
});

test("google: leaving the IMAP scope unticked records no broad scope and no note", async t => {
  const env = await signedIn(t, { imap: false });
  assert.equal(env.rows[0].imap, false);
  assert.equal(env.rows[0].broad, false);
  assert.equal(env.rows[0].scope_note, "");
});

test("P21: the token is injected only into Google's own hosted MCP addresses", async t => {
  const env = await signedIn(t);
  const auth = { type: "oauth", item: "google-home" };
  const ok = await env.creds.headers(auth, { url: "https://gmailmcp.googleapis.com/mcp/v1" });
  assert.match(ok.authorization, /^Bearer at_/);
  await env.creds.headers(auth, { url: "https://calendarmcp.googleapis.com/anything" });
  for (const bad of ["https://evil.example/mcp", "https://gmailmcp.googleapis.com.evil.example/mcp", "http://gmailmcp.googleapis.com/mcp", "https://oauth2.googleapis.com/token", "not a url"]) {
    await assert.rejects(env.creds.headers(auth, { url: bad }), e => { assert.equal(e.code, "bound"); assert.ok(!e.message.includes(env.item.refresh_token)); return true; }, bad);
  }
  // A caller that names no url gets the old behavior (the hub passes it once it is wired).
  assert.ok((await env.creds.headers(auth)).authorization);
  // An item with no recorded binding is unbound, as every item was before.
  const plain = new Credentials({ fetchItem: async (item, f) => ({ client_id: "c", client_secret: "s", refresh_token: "r", token_uri: `${env.auth.origin}/token` })[f] ?? Promise.reject(new Error("no field")) });
  await assert.rejects(plain.headers({ type: "oauth", item: "x" }, { url: "https://evil.example/" }), e => e.code !== "bound");
});

test("push: new mail becomes a vault.push event with ids and sender only, and no value anywhere", async t => {
  const env = await signedIn(t);
  const { m, events } = manager(t, env);
  const st = await m.start({ connection: "cn_home", scope: { projects: ["harlow"], agents: "*" } }, PERSON);
  assert.equal(st.state, "connecting");
  await until(() => env.fake.idlers() === 1);
  assert.equal((await m.status({}, PERSON))[0].state, "idle");
  env.fake.deliver({ id: "inv1@mail.example", from: "Northwind Bakery <orders@northwind.example>", subject: "Secret plans, do not repeat" });
  await until(() => events.some(e => e.type === "vault.push"));
  const e = events.find(x => x.type === "vault.push");
  assert.equal(e.p.kind, "mail.new");
  assert.equal(e.p.connection, "cn_home");
  assert.deepEqual(e.p.ids, ["<inv1@mail.example>"]);
  assert.deepEqual(e.p.scope, { projects: ["harlow"], agents: "*" });
  assert.equal(typeof e.p.at, "number");
  assert.deepEqual(Object.keys(e.p.meta[0]).sort(), ["date", "from", "uid"]);
  const wire = JSON.stringify(events) + JSON.stringify(await m.status({}, PERSON));
  assert.ok(!/Secret plans/.test(wire), "no subject");
  for (const v of env.creds.secrets()) assert.ok(!wire.includes(v), "no token in an event or status");
  assert.equal(env.fake.state.connections, 1, "one connection for the account");
  await m.start({ connection: "cn_home" }, PERSON);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(env.fake.state.connections, 1, "starting again keeps the one socket");
  await m.stop({ connection: "cn_home" }, PERSON);
  await until(() => env.fake.live() === 0);
  assert.deepEqual(await m.status({}, PERSON), []);
});

test("push: a drop is lost, then resumed, and mail from the gap still arrives", async t => {
  const env = await signedIn(t);
  const { m, events } = manager(t, env);
  await m.start({ connection: "cn_home" }, PERSON);
  await until(() => env.fake.idlers() === 1);
  env.fake.dropAll();
  await until(() => events.some(e => e.type === "vault.push.lost"));
  env.fake.deliver({ id: "gap@mail.example" });
  await until(() => events.some(e => e.type === "vault.push.resumed"));
  await until(() => events.some(e => e.type === "vault.push"));
  assert.equal(events.find(x => x.type === "vault.push.lost").p.reason, "closed");
  assert.deepEqual(events.find(x => x.type === "vault.push").p.ids, ["<gap@mail.example>"]);
});

test("push (reviewer H1): an expired refresh token found while the socket is up is one reconsent event, not silence", async t => {
  const env = await signedIn(t);
  const { m, events } = manager(t, env, { checkMs: 60 });
  await m.start({ connection: "cn_home" }, PERSON);
  await until(() => env.fake.idlers() === 1);
  env.auth.expireRefreshTokens();
  await until(() => events.some(e => e.type === "vault.push.reconsent"));
  await new Promise(r => setTimeout(r, 200));
  const re = events.filter(e => e.type === "vault.push.reconsent");
  assert.equal(re.length, 1, "said once");
  assert.equal(re[0].p.reason, "expired");
  assert.match(re[0].p.message, /7 days/);
  const st = (await m.status({}, PERSON))[0];
  assert.equal(st.state, "needs-consent");
  assert.equal(st.reconsent, "expired");
  await until(() => env.fake.live() === 0);
  for (const v of env.creds.secrets()) assert.ok(!JSON.stringify(events).includes(v));
});

test("push (reviewer H1): a drop after the refresh token died is a reconsent event, not a retry loop", async t => {
  const env = await signedIn(t);
  const { m, events } = manager(t, env);
  await m.start({ connection: "cn_home" }, PERSON);
  await until(() => env.fake.idlers() === 1);
  env.auth.expireRefreshTokens();
  env.fake.dropAll();
  await until(() => events.some(e => e.type === "vault.push.reconsent"));
  assert.equal(events.find(e => e.type === "vault.push.reconsent").p.reason, "expired");
  assert.equal((await m.status({}, PERSON))[0].state, "needs-consent");
  const calls = env.auth.calls.filter(c => c.path === "/token").length;
  await new Promise(r => setTimeout(r, 150));
  assert.equal(env.auth.calls.filter(c => c.path === "/token").length, calls, "no further token requests");
});

test("push: a mail server that refuses the login is a reconsent event with the scope reason", async t => {
  const env = await signedIn(t);
  env.fake.state.refuse = true;
  const { m, events } = manager(t, env);
  await m.start({ connection: "cn_home" }, PERSON);
  await until(() => events.some(e => e.type === "vault.push.reconsent"));
  assert.equal(events.find(e => e.type === "vault.push.reconsent").p.reason, "scope");
  assert.equal(env.fake.state.authAttempts, 1);
  // The person fixes it and starts again: the connection comes up.
  env.fake.state.refuse = false;
  await m.start({ connection: "cn_home" }, PERSON);
  await until(() => env.fake.idlers() === 1);
});

test("push: a connection consented without the mail scope never opens a socket, and says why", async t => {
  const env = await signedIn(t, { imap: false });
  const { m, events } = manager(t, env);
  const st = await m.start({ connection: "cn_home" }, PERSON);
  assert.equal(st.state, "needs-consent");
  assert.equal(st.reconsent, "unavailable");
  assert.equal(events[0].type, "vault.push.reconsent");
  assert.equal(env.fake.state.connections, 0);
});

test("push: only a person starts or stops; status follows the { projects, agents } grant", async t => {
  const env = await signedIn(t);
  const { m } = manager(t, env, { agentProjects: async a => (a === "ivy" ? ["harlow"] : ["other"]), threadProject: async th => (th === "t1" ? "harlow" : null) });
  await assert.rejects(m.start({ connection: "cn_home" }, { agent: "ivy" }), e => e.code === "forbidden");
  await assert.rejects(m.start({ connection: "bad name" }, PERSON), e => e.code === "bad_input");
  await m.start({ connection: "cn_home", scope: { projects: ["harlow"], agents: ["ivy", "max"] } }, PERSON);
  const see = who => m.status({}, who).then(r => r.length);
  assert.equal(await see(PERSON), 1);
  assert.equal(await see({ agent: "ivy" }), 1, "an agent in the list, working on a granted project");
  assert.equal(await see({ agent: "max" }), 0, "in the list but not on a granted project");
  assert.equal(await see({ agent: "zed" }), 0, "not in the list");
  await m.start({ connection: "cn_home", scope: { projects: ["harlow"] } }, PERSON);
  assert.equal(await see({ thread: "t1" }), 1);
  assert.equal(await see({ thread: "t2" }), 0);
  assert.deepEqual(normalizeScope(undefined), { projects: "*", agents: "*" });
  assert.throws(() => normalizeScope({ projects: "harlow" }), e => e.code === "bad_input");
  assert.deepEqual(m.list(), [{ connection: "cn_home", scope: { projects: ["harlow"], agents: "*" } }]);
  await assert.rejects(m.stop({ connection: "cn_home" }, { agent: "ivy" }), e => e.code === "forbidden");
});

test("push: restore holds the connections that were held; pushTools names the three tools", async t => {
  const env = await signedIn(t);
  const { m } = manager(t, env);
  await m.restore([{ connection: "cn_home", scope: { projects: ["harlow"] } }, { connection: "cn_gone" }]);
  await until(() => env.fake.idlers() === 1);
  assert.equal(m.list().length, 1, "a connection that no longer exists is skipped");
  const tools = pushTools(m, meta => ({ person: meta.caller === "cli" }));
  assert.deepEqual(tools.map(x => x.name), ["connectors.push.start", "connectors.push.stop", "connectors.push.status"]);
  assert.equal((await tools[2].run({}, { caller: "cli" })).length, 1);
  assert.equal((await tools[1].run({ connection: "cn_home" }, { caller: "cli" })).stopped, "cn_home");
});
