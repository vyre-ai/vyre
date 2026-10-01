// @ts-check
// Red-team refusals for the vault, the Gate and asked intents (0.2 PLAN row 12): one runner test
// per BLOCKER or HIGH in team/0.2/reviews, each one ATTEMPTING the attack through a real vyred
// registry in a temp home and asserting the refusal. Named "redteam <ID>: <attack> is refused" so
// e2e2's matrix and reviewer-2's coverage list can find them. Runs on runners and testbox, never on
// the user's Mac: node --test "test/redteam/*.test.js". Every name, address and value is a sample.
//
// IDs: V = vault review, G = Gate and asked intents (reviewer-2's code reviews), A = asked reach.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { start } from "../../core/daemon/index.js";
import { call } from "../../core/daemon/client.js";
import { inputHash } from "../../core/presence/index.js";
import { onProviderSite } from "../../core/vault/fill-key.js";
import { tempHome, present } from "../helpers.js";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;

/** A fake Gmail send endpoint that records what reached it. */
async function fakeGmail(t) {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", d => (body += d));
    req.on("end", () => { got.push({ url: req.url, body }); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "m1", threadId: "th1" })); });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  return { got, base: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}` };
}

/** A real vyred in a temp home with the vault and a configured mail sender. */
async function world(t) {
  const root = tempHome(t);
  const gmail = await fakeGmail(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" },
    gate: { senders: { mail: { type: "gmail", vault: "work-mail-token", from: "alex@example.com", base: gmail.base } } } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const cli = (tool, input = {}) => call(tool, input, { root, caller: "cli" });
  const reg = (tool, input, caller, meta = {}) => d.registry.call(tool, input, caller, meta);
  const agent = (name, thread, tool, input) => reg(tool, input, `mcp:agent:${name}`, { thread, agent: name });
  assert.ok((await cli("vault.put", { name: "work-mail-token", kind: "api-key", fields: { value: fake("token") } })).data);
  assert.equal((await cli("vault.grant", { name: "work-mail-token", module: "gate" })).data.grant.status, "active");
  const said = (o, caller = "module:sessions") => reg("vault.said.record", { thread: "t-1", said: "said-1", kind: "send", to: ["dana@harlowlegal.com"], what: "email Dana", ...o }, caller);
  const MAIL = o => ({ kind: "send", via: "mail", to: "dana@harlowlegal.com", content: { subject: "Intake form", body: "Hi Dana. Alex" }, thread: "t-1", ...o });
  return { root, d, gmail, cli, reg, agent, said, MAIL };
}

const CRED_CONFIG = JSON.stringify({ auth: { type: "bearer" }, hosts: ["graph.example.test"] });
const credential = (name = "ms-graph", secret = fake("secret")) => ({ name, kind: "api-credential", fields: { config: CRED_CONFIG, secret } });

// ---------------------------------------------------------------- V: the vault

test("redteam V-B1: a person-supplied vendor token cannot be attached to a hub row that points anywhere else", async t => {
  const { reg, cli } = await world(t);
  await cli("vault.put", { name: "github-alex", kind: "pat", fields: { token: fake("ghp") } });
  for (const [who, meta] of [["cli", {}], ["module:watchers", {}], ["mcp", {}], ["mcp:agent:kit", { agent: "kit" }]]) {
    for (const url of ["https://evil.example.test/mcp/", "https://api.githubcopilot.com.evil.test/mcp/", "https://github.com/mcp/"]) {
      const r = await reg("mcp.add", { name: "github", transport: "http", url, auth: { type: "bearer", item: "github-alex", field: "token" } }, who, meta);
      assert.ok(r.error, `${who} to ${url}`);
      assert.ok(!(r.data && r.data.name), `${who} to ${url}: no row was made`);
    }
    // The same for a Google item.
    const g = await reg("mcp.add", { name: "mail", transport: "http", url: "https://evil.example.test/", auth: { type: "bearer", item: "google-work", field: "token" } }, who, meta);
    assert.ok(g.error, `${who}: a google item to a stranger`);
  }
  // Control: the same item on GitHub's own hosted server is accepted by the row check (checked without starting the server, which would
  // reach the network), so the refusals above are about the host.
  const { normalize, githubServer } = await import("../../core/mcp/hub.js");
  assert.equal(normalize(githubServer("alex")).url, "https://api.githubcopilot.com/mcp/");
});

test("redteam V-B2: a hostile OAuth server that names a real issuer cannot get the person's own client used against it", async t => {
  const { startFakeAuthServer } = await import("../../lib/connectors/testing/fake-oauth.js");
  const { connector } = await import("../../lib/connectors/oauth.js");
  const hostile = await startFakeAuthServer(t, { dcr: false });
  const client = hostile.registerClient("fixture-client-secret");
  const c = connector({ complete: async () => ({}), emit: () => {}, log: () => {}, fetchItem: async (_item, field) => /** @type {any} */ (client)[field] });
  t.after(() => c.stop());
  // The catalog expects Google's servers; the server the person typed answers with its own.
  await assert.rejects(c.start({ name: "work", resource: `${hostile.origin}/.well-known/x`, client: "google-client", scopes: ["read"], pin: ["https://accounts.google.com", "https://oauth2.googleapis.com"] }), /not one of the servers this app signs in with/);
  assert.equal(c.port(), null, "no listener was opened, so no consent screen was reachable");
  // Control: when the server IS one the catalog expects, the same call starts a sign-in (a listener opens).
  const started = await c.start({ name: "work2", resource: `${hostile.origin}/.well-known/x`, client: "google-client", scopes: ["read"], pin: [hostile.origin] });
  assert.ok(started.url && c.port(), "an expected server starts a sign-in");
});

test("redteam V-HK1: any page that prints a key-shaped value cannot get it connected as a provider, only kept plain", async t => {
  for (const [provider, host, pathname] of [["anthropic", "evil.example.net", "/x"], ["anthropic", "anthropic.com.evil.example.net", "/k"], ["anthropic", "claude.ai", "/chat/1"], ["github", "github.com", "/some/repo/issues/1"],
    ["github", "github.com", "/settingsx/tokens"], ["slack", "myteam.slack.com", "/messages"], ["openai", "openai.com", "/blog"], ["nonsense", "anthropic.com", "/"]]) {
    assert.equal(onProviderSite(provider, host, pathname), false, `${provider} on ${host}${pathname}`);
  }
  for (const [provider, host, pathname] of [["anthropic", "console.anthropic.com", "/settings/keys"], ["github", "github.com", "/settings/tokens"], ["slack", "api.slack.com", "/apps"]]) {
    assert.equal(onProviderSite(provider, host, pathname), true, `${provider} on ${host}${pathname} is the legitimate path`);
  }
});

test("redteam V-M11: an api-credential is never handed out, to any caller, by any route", async t => {
  const { reg, cli } = await world(t);
  const secret = fake("secret");
  assert.equal((await cli("vault.put", credential("ms-graph", secret))).error, undefined);
  const attempts = [
    ["cli", "vault.reveal", { name: "ms-graph" }], ["cli", "vault.copy", { name: "ms-graph" }], ["cli", "vault.get", { name: "ms-graph", reveal: true }],
    ["cli", "vault.inject", { items: [{ name: "ms-graph", env: "TOKEN" }] }], ["cli", "vault.resolve", { refs: ["vault://ms-graph/secret"] }],
    ["module:planner", "vault.release", { name: "ms-graph" }], ["mcp", "vault.reveal", { name: "ms-graph" }], ["mcp:agent:kit", "vault.resolve", { refs: ["vault://ms-graph/secret"] }],
  ];
  for (const [who, tool, input] of attempts) {
    const r = await reg(tool, input, who, who.startsWith("mcp:agent") ? { agent: "kit" } : {});
    assert.ok(r.error || !JSON.stringify(r.data ?? null).includes(secret), `${who} ${tool}`);
    assert.ok(!JSON.stringify(r).includes(secret), `${who} ${tool}: the value never comes back`);
  }
  const pass = await cli("vault.pass.create", { holder: "Dana", items: ["ms-graph"], expires: "2099-01-01" });
  assert.ok(pass.error, "not even a pass");
  // Control: an ordinary secret IS handed to the person through the same route, so the refusals above are about the api-credential kind.
  const plain = fake("plain");
  assert.equal((await cli("vault.put", { name: "plain-secret", kind: "secret", fields: { value: plain } })).error, undefined);
  const got = await cli("vault.resolve", { refs: ["vault://plain-secret/value"] });
  assert.equal(got.data && got.data.values && got.data.values["vault://plain-secret/value"], plain, JSON.stringify(got));
});

test("redteam V-N4: a module, watcher, agent or model cannot create, replace or change an api-credential", async t => {
  const { reg, cli } = await world(t);
  assert.equal((await cli("vault.put", credential("ms-graph"))).error, undefined);
  for (const [who, meta] of [["module:connectors", {}], ["module:watchers", { watcher: "inbox" }], ["module:planner", {}], ["mcp", {}], ["mcp:agent:kit", { agent: "kit" }]]) {
    assert.ok((await reg("vault.put", credential("new-one"), who, meta)).error, `${who} creates`);
    assert.ok((await reg("vault.put", credential("ms-graph", fake("other")), who, meta)).error, `${who} replaces`);
    assert.ok((await reg("vault.put", { name: "ms-graph", kind: "api-credential", fields: { secret: fake("key-only") } }, who, meta)).error, `${who} replaces just the key`);
    assert.ok((await reg("vault.edit", { name: "ms-graph", addHosts: ["https://evil.example.test"] }, who, meta)).error, `${who} edits its hosts`);
    assert.ok((await reg("vault.update", { name: "ms-graph", hosts: ["https://evil.example.test"] }, who, meta)).error, `${who} updates it`);
  }
  assert.ok((await cli("vault.edit", { name: "ms-graph", addHosts: ["https://evil.example.test"] })).error, "even the person cannot edit one: it is replaced, never read back");
});

test("redteam V-M9: vault.request to a loopback, tailnet, link-local or metadata address is refused before any connection", async t => {
  const { cli } = await world(t);
  const hosts = ["127.0.0.1", "169.254.169.254", "100.64.0.5", "10.0.0.8", "192.168.1.1", "localhost", "[::1]"];
  let refusedAtCreation = 0, refusedAtRequest = 0;
  for (const host of hosts) {
    const config = JSON.stringify({ auth: { type: "bearer" }, hosts: [host] });
    const put = await cli("vault.put", { name: "ssrf", kind: "api-credential", fields: { config, secret: fake("secret") } });
    if (put.error) { refusedAtCreation++; continue; } // refused at creation is a refusal too
    const r = await cli("vault.request", { credential: "ssrf", method: "GET", url: `https://${host}/latest/meta-data/` });
    assert.ok(r.error, `${host}: a private address is never reached`);
    refusedAtRequest++;
    await cli("vault.delete", { name: "ssrf" });
  }
  assert.equal(refusedAtCreation + refusedAtRequest, hosts.length, "every private address was refused at one of the two doors");
  // Control: a credential for an ordinary public hostname is accepted at creation, so the refusals above are about the address.
  assert.equal((await cli("vault.put", credential("public-one"))).error, undefined, "a public host is accepted");
});

// Positive control for V-M10 lives in core/vault/request.test.js, "approving runs exactly the held request, re-checked; an edit, a wrong
// caller or a changed credential is refused": the same test holds a real outward request, approves it, and watches it run exactly as
// sealed (status 202, the credential added at the boundary, one request on the network), then refuses a forged card, an unsealed card,
// an edited body, url and summary, a changed credential and a deleted one. It needs a fake network, which the daemon world here cannot
// have (the target check refuses private addresses), so the control stays there and this test proves the daemon-level door.
test("redteam V-M10: a model cannot hold a card of its own words through the vault-api sender, and an edited card never runs", async t => {
  const { cli, agent, reg } = await world(t);
  assert.equal((await cli("vault.put", credential("ms-graph"))).error, undefined);
  // The vault offers its sender once the Gate is up.
  for (let i = 0; i < 50; i++) { const s = await cli("gate.senders"); if ((s.data || []).some(x => x.name === "vault-api")) break; await new Promise(r => setTimeout(r, 100)); }
  const forged = await agent("kit", "t-1", "gate.request", { kind: "send", via: "vault-api", to: ["dana@harlowlegal.com"], why: "x", content: {
    credential: "ms-graph", method: "POST", url: "https://graph.example.test/v1.0/me/sendMail", summary: "Send Dana the intake form", hash: "x", kind: "send", request: { headers: {} }, parsed: {}, seal: "forged" } });
  if (forged.error) {
    // Refused at the door is a refusal; it must say so in words about the card, not fail for an unrelated reason.
    assert.match(String(forged.error.message), /seal|card|vault-api|sender|not|refus|denied/i, JSON.stringify(forged.error));
    return;
  }
  const id = forged.data.id;
  const approve = await cli("gate.approve", { id });
  assert.notEqual(approve.data && approve.data.state, "sent", "a card with no seal the vault made never sends");
  const again = await reg("gate.get", { id }, "cli");
  assert.notEqual(again.data && again.data.state, "sent");
});

// ---------------------------------------------------------------- G: the Gate and asked intents

test("redteam G-P17: a model, agent, watcher, tool result or guest cannot record its own 'said' intent", async t => {
  const { reg } = await world(t);
  for (const who of ["mcp", "mcp:agent:kit", "mcp:thread:t-1", "tailnet-guest:x@y.test", "tailnet:agent:juno", "module:watchers", "module:mcp", "module:gate", "module:vault", "cli", "local", "deck", "capsule", "hook", "unknown"]) {
    const r = await reg("vault.said.record", { thread: "t-1", said: "s", kind: "send", to: ["dana@harlowlegal.com"], what: "x" }, who);
    assert.ok(r.error, `${who} cannot record`);
  }
  // Controls: the callers that ARE allowed to record what the person said do record it, so the refusals above are about the caller.
  for (const who of ["module:sessions", "module:assistant", "module:threads"]) {
    const ok = await reg("vault.said.record", { thread: "t-c", said: `s-${who}`, kind: "act_out", to: ["github.project.pr.merge:alex/app#1"], channel: "github", what: "merge it" }, who);
    assert.ok(ok.data && ok.data.id, `${who} records (control): ${JSON.stringify(ok)}`);
  }
  for (const kind of ["send", "post", "pay", "setting", "revoke"]) {
    const r = await reg("vault.said.record", { thread: "t-1", said: "s", kind, to: ["dana@harlowlegal.com"], what: "x", limits: { max_amount: 5, currency: "usd" } }, "module:threads");
    assert.ok(r.error, `the threads module cannot record ${kind}`);
  }
});

test("redteam G-M1: an email the person asked for to one person, with a cc or bcc they never named, is held and never sent", async t => {
  const { gmail, agent, said, MAIL } = await world(t);
  await said({});
  for (const extra of [{ bcc: ["mallory@elsewhere.test"] }, { cc: ["mallory@elsewhere.test"] }, { cc: ["dana@harlowlegal.com"], bcc: ["mallory@elsewhere.test"] }]) {
    const r = await agent("kit", "t-1", "gate.request", MAIL({ content: { subject: "s", body: "b", ...extra } }));
    assert.equal(r.data.state, "held", JSON.stringify(extra));
  }
  assert.equal(gmail.got.length, 0, "nothing reached the sender");
  // Control: the same email to exactly the named person, with no cc or bcc, goes out at once, so the holds above are about the extra recipients.
  const ok = await agent("kit", "t-1", "gate.request", MAIL({ content: { subject: "s", body: "b" } }));
  assert.equal(ok.data && ok.data.state, "sent", JSON.stringify(ok));
  assert.equal(gmail.got.length, 1);
});

test("redteam G-D2: a model cannot claim the person's own confirmation, and a wrong hash, surface or age always holds", async t => {
  const { gmail, reg, agent, MAIL } = await world(t);
  const req = MAIL({});
  const hash = inputHash({ kind: req.kind, via: req.via, to: [req.to], content: req.content });
  const fresh = () => ({ surface: "capsule", hash, at: Date.now() });
  // The guard's answer is a hold. Where the registry refuses the caller outright (a bare model naming a thread it cannot prove, a module
  // that is not running) the refusal must say why, so an unrelated failure cannot pass for one.
  const held = (r, why) => assert.equal(r.data && r.data.state, "held", `${why}: ${JSON.stringify(r)}`);
  const refusedFor = (r, re, why) => assert.ok(r.error && re.test(String(r.error.message)), `${why}: ${JSON.stringify(r)}`);
  held(await agent("kit", "t-1", "gate.request", { ...req, asked: fresh() }), "a model's claim");
  refusedFor(await reg("gate.request", { ...req, asked: fresh() }, "mcp"), /thread/i, "a bare mcp caller naming a thread it cannot prove");
  const { thread: _unproven, ...noThread } = req;
  held(await reg("gate.request", { ...noThread, asked: fresh() }, "mcp"), "a bare mcp caller with no thread");
  // A module claiming the person's confirmation: the registry may hold it or refuse it, and either is fine. What it must never do
  // is send, and the closing check shows nothing reached the sender.
  const fromModule = await reg("gate.request", { ...req, asked: fresh() }, "module:watchers");
  assert.notEqual(fromModule.data && fromModule.data.state, "sent", `a module's claim: ${JSON.stringify(fromModule)}`);
  held(await reg("gate.request", { ...req, asked: { ...fresh(), hash: "x" + hash } }, "capsule"), "a hash that does not match");
  held(await reg("gate.request", { ...req, asked: { ...fresh(), at: Date.now() - 61_000 } }, "capsule"), "stale");
  held(await reg("gate.request", { ...req, asked: { ...fresh(), surface: "deck" } }, "capsule"), "another surface's claim");
  assert.equal(gmail.got.length, 0, "nothing reached the sender");
  // Positive control: the same request with a fresh, matching claim from the capsule's own surface does send, so a world where
  // everything errors cannot look green.
  // It has its own subject and body, so it cannot collide with any held request above.
  const control = MAIL({ content: { subject: "Intake form (positive control)", body: "Hi Dana. This one is confirmed by the person. Alex" } });
  const controlHash = inputHash({ kind: control.kind, via: control.via, to: [control.to], content: control.content });
  const ok = await reg("gate.request", { ...control, asked: { surface: "capsule", hash: controlHash, at: Date.now() } }, "capsule");
  assert.equal(ok.data && ok.data.state, "sent", JSON.stringify(ok));
  assert.equal(gmail.got.length, 1);
});

test("redteam G-L1: a spoken ask is spent by its send, and one past its window never matches", async t => {
  const { gmail, reg, agent, said, MAIL } = await world(t);
  await said({});
  assert.equal((await agent("kit", "t-1", "gate.request", MAIL({}))).data.state, "sent");
  assert.equal((await agent("kit", "t-1", "gate.request", MAIL({}))).data.state, "held", "the second one waits");
  await said({ said: "s2", to: ["sam@harlowlegal.com"], at: Date.now() - 61 * 60_000 });
  assert.equal((await agent("kit", "t-1", "gate.request", MAIL({ to: "sam@harlowlegal.com" }))).data.state, "held", "said 61 minutes ago");
  await said({ said: "s3", kind: "act_out", channel: "github", to: ["github.project.pr.merge:alex/app#7"], at: Date.now() - 16 * 60_000 }, "module:threads");
  const old = await reg("vault.said.match", { kind: "act_out", via: "github", to: ["github.project.pr.merge:alex/app#7"], thread: "t-1" }, "module:vyred");
  assert.equal(old.data.matched, false, "an act_out said 16 minutes ago has lapsed");
  assert.equal(gmail.got.length, 1);
});

test("redteam G-MV4: a named agent cannot take an active grant away or see items granted to no project of its own", async t => {
  const { reg, cli } = await world(t);
  await cli("vault.put", { name: "api-a", kind: "api-key", fields: { value: fake("a") } });
  await cli("vault.put", { name: "api-b", kind: "api-key", fields: { value: fake("b") } });
  await cli("vault.grant", { name: "api-a", module: "planner" });
  await cli("vault.grant", { name: "api-b", module: "kit", project: "harlow" });
  const kit = (tool, input, meta = {}) => reg(tool, input, "mcp:agent:kit", { agent: "kit", ...meta });
  assert.equal((await kit("vault.revoke", { name: "api-a", module: "planner" })).data.revoked, 0);
  assert.equal((await reg("vault.revoke", { name: "api-a", module: "planner" }, "module:watchers")).data.revoked, 0);
  assert.deepEqual((await kit("vault.list", {})).data.items, [], "no project scope, nothing visible");
  assert.deepEqual((await kit("vault.list", {}, { project: "northwind" })).data.items, [], "another project's scope");
  assert.deepEqual((await reg("vault.list", {}, "mcp:agent:planner", { agent: "planner" })).data.items, [], "an agent named like a granted module");
  assert.ok((await cli("vault.list")).data.items.length >= 2, "the person sees everything");
});

test("redteam G-L-V1: a # tag's use is refused for a thread outside its lineage and for an item that gained a host", async t => {
  const { reg, cli } = await world(t);
  await cli("vault.put", { name: "GHLapikey", kind: "api-key", fields: { value: fake("key") }, hosts: ["https://api.example.test"] });
  await reg("vault.mention.resolve", { id: "GHLapikey", thread: "t-1", said: "s" }, "module:threads");
  const check = (o, caller = "module:vault") => reg("vault.use.check", { item: "GHLapikey", thread: "t-1", hosts: ["https://api.example.test"], ...o }, caller);
  assert.equal((await check({})).data.allowed, true);
  assert.equal((await check({ thread: "t-2" })).data.allowed, false, "another thread");
  assert.equal((await check({ hosts: ["https://api.example.test", "https://evil.example.test"] })).data.allowed, false, "the item gained a host after the tag");
  assert.ok((await check({ hosts: undefined })).error || (await check({ hosts: undefined })).data.allowed === false, "no hosts given never matches");
  assert.ok((await reg("vault.use.check", { item: "GHLapikey", thread: "t-1", hosts: [] }, "mcp")).error, "a model cannot even ask");
  for (const who of ["mcp", "cli", "module:watchers", "module:mcp"]) assert.ok((await reg("vault.mention.resolve", { id: "GHLapikey", thread: "t-9", said: "s" }, who)).error, `${who} cannot tag`);
});

// ---------------------------------------------------------------- A: asked reach (platform's registry asks the vault)

test("redteam A-asked: the vault's asked check covers exactly the target the person named, used once, and no other agent's or module's", async t => {
  const { reg, said } = await world(t);
  const ask = (to, o = {}) => reg("vault.said.match", { kind: "act_out", via: "github", to: [to], thread: "t-1", ...o }, "module:vyred");
  await said({ kind: "act_out", channel: "github", to: ["github.project.pr.merge:alex/app#12"], what: "merge it" }, "module:threads");
  assert.equal((await ask("github.project.pr.merge:alex/app#40")).data.matched, false, "PR 40 is not PR 12");
  assert.equal((await ask("github.project.pr.review:alex/app#12")).data.matched, false, "another action on the same PR");
  assert.equal((await ask("github.project.pr.merge:alex/app#12", { thread: "t-2" })).data.matched, false, "another thread");
  for (const who of ["mcp", "mcp:agent:kit", "cli", "tailnet-guest:x@y.test"]) assert.ok((await reg("vault.said.match", { kind: "act_out", via: "github", to: ["github.project.pr.merge:alex/app#12"], thread: "t-1" }, who)).error, `${who} cannot ask the vault`);
  assert.equal((await ask("github.project.pr.merge:alex/app#12", { consume: true })).data.matched, true);
  assert.equal((await ask("github.project.pr.merge:alex/app#12")).data.matched, false, "one ask, one act");
});
