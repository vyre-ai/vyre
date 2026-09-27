// @ts-check
// The google module inside a real vyred, in a temp home, with the real vault and the real Gate,
// against the fake Google (core/connectors/testing/fake-google.js). Never real Google.
//
// What these prove: reads mint read-only tokens; a draft goes nowhere; a send and an invite with
// attendees are held until the person approves, and then go out with exactly what was approved,
// under the narrowest scope; "Sign in with Google" ends in an account that works, and only a
// person can start it; nothing secret reaches a result, an event, a log line or the table.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";
import { startFakeGoogle } from "../connectors/testing/fake-google.js";

// "today" and "tomorrow" are this machine's days; pin them so the fake's times land predictably.
process.env.TZ = "UTC";

const S = "https://www.googleapis.com/auth/";
const ME = "alex@example.com";

/** A vyred in a temp home with the file keystore, and helpers to call it as each kind of caller. */
async function vyred(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const lines = [];
  const d = await start({ root, presence: present, log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  t.after(() => d.stop());
  const as = caller => (tool, input = {}) => call(tool, input, { root, caller });
  // A model's call, with the thread vyred verified for it, the way the harness MCP server makes one.
  const model = (tool, input = {}) => d.registry.call(tool, input, "mcp", { thread: "t-1" });
  const results = [];
  const keep = fn => async (tool, input) => { const r = await fn(tool, input); results.push(r); return r; };
  return { root, d, lines, results, cli: keep(as("cli")), local: keep(as("local")), mcp: keep(as("mcp")), model: keep(model) };
}

/** Put a vault item and grant it to google, as a person does once. */
async function item(v, name, kind, fields) {
  assert.ok((await v.cli("vault.put", { name, kind, fields })).data, `vault.put ${name}`);
  assert.equal((await v.cli("vault.grant", { name, module: "google" })).data.grant.status, "active");
}

/** Every value that must never leave: keys, client secrets, refresh tokens, access tokens. */
function secretsOf(fake, extra) {
  return [...extra, ...fake.tokens.keys()];
}

function assertNoLeak(v, values) {
  const db = v.d.registry.deps.db;
  const everything = JSON.stringify([v.results, v.lines, v.d.registry.deps.events.since(0, { limit: 5000 }),
    db.prepare("SELECT * FROM google_accounts").all(), db.prepare("SELECT * FROM gate_items").all()]);
  for (const s of values) {
    assert.ok(!everything.includes(s), `a secret leaked: ${s.slice(0, 12)}...`);
    for (const line of String(s).split("\n")) if (line.length >= 24 && !line.startsWith("-----")) assert.ok(!everything.includes(line), "a key line leaked");
  }
}

const readScopes = new Set([S + "calendar.readonly", S + "gmail.readonly"]);
const ADMIN_SCOPES = [S + "calendar.readonly", S + "calendar.events", S + "gmail.readonly", S + "gmail.compose", S + "gmail.send"].join(",");

/** TCP listeners in this process: the fakes' and, while a sign-in is open, the loopback's. */
const tcp = () => process.getActiveResourcesInfo().filter(x => x === "TCPServerWrap").length;
/** Wait until the count settles at `n` (a closed listener's handle goes on the next turn). */
async function tcpIs(n) {
  for (let i = 0; i < 100 && tcp() !== n; i++) await new Promise(r => setTimeout(r, 10));
  return tcp();
}
const listening = port => new Promise(resolve => {
  const s = net.connect(port, "127.0.0.1");
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("error", () => resolve(false));
});

test("google: a DWD service account reads with read-only tokens, holds sends and invites, and leaks nothing", async t => {
  const fake = await startFakeGoogle(t);
  const v = await vyred(t);
  assert.equal(v.d.registry.status().find(m => m.name === "google")?.state, "running");
  const sa = fake.serviceAccount(ME);
  await item(v, "work-google", "secret", { value: sa });

  // A model cannot connect an account; a person can.
  const auth = { type: "service-account", item: "work-google" };
  assert.equal((await v.mcp("google.add", { name: "work", email: ME, auth, base: fake.base })).error.code, "denied");
  const added = await v.cli("google.add", { name: "work", email: ME, auth, base: fake.base });
  assert.deepEqual(added.data.auth, { type: "service-account", item: "work-google", subject: ME });
  assert.match((await v.cli("google.add", { name: "evil", email: ME, auth, base: "https://example.org" })).error.message, /loopback/);
  assert.deepEqual((await v.mcp("google.accounts")).data.map(a => a.name), ["work"]);
  assert.ok((await v.local("gate.senders")).data.some(s => s.name === "google:work" && s.type === "module"));

  const tested = await v.cli("google.test", { name: "work" });
  assert.equal(tested.data.ok, true, JSON.stringify(tested));
  assert.deepEqual(tested.data.scopes, { "calendar.readonly": true, "calendar.events": true, "gmail.readonly": true, "gmail.compose": true, "gmail.send": true });
  // The domain-wide-delegation helper: the key's public client ID and the admin console's line,
  // and nothing else from the key.
  const saKey = JSON.parse(sa);
  assert.deepEqual(Object.keys(tested.data).sort(), ["account", "admin_scopes", "client_id", "ok", "scopes"]);
  assert.equal(tested.data.client_id, saKey.client_id);
  assert.equal(tested.data.admin_scopes, ADMIN_SCOPES);
  for (const k of ["client_email", "project_id", "private_key_id"]) assert.ok(!JSON.stringify(tested).includes(saKey[k]), `google.test returned the key's ${k}`);
  fake.calls.length = 0;

  // Reads.
  const next = (await v.model("google.calendar.next", {})).data;
  assert.deepEqual(next.events.map(e => e.id), ["evharlow1", "evnorthwind1"]);
  assert.deepEqual(Object.keys(next.events[0]).sort(), ["account", "attendees", "end", "id", "start", "title", "url", "where"]);
  assert.equal(next.events[0].title, "Harlow Legal check-in");
  assert.deepEqual(next.events[0].attendees, [ME, "dana@harlowlegal.com"]);
  assert.equal(next.events[0].account, "work");
  const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
  assert.equal((await v.model("google.calendar.list", { from: new Date().toISOString(), to: later })).data.events.length, 2);
  assert.deepEqual((await v.model("google.calendar.search", { q: "tasting" })).data.events.map(e => e.id), ["evnorthwind1"]);

  const found = (await v.model("google.mail.search", { q: "from:dana" })).data.messages;
  assert.deepEqual(found.map(m => m.id), ["mharlow1"]);
  assert.deepEqual(Object.keys(found[0]).sort(), ["account", "date", "from", "id", "snippet", "subject", "thread_id", "to", "url"]);
  const read = (await v.model("google.mail.read", { id: "mharlow1" })).data;
  assert.match(read.body, /engagement letter is attached/);
  assert.equal(read.message_id, "<mharlow1@mail.example.com>");
  const thread = (await v.model("google.mail.read", { thread_id: "tharlow" })).data;
  assert.equal(thread.messages.length, 2);
  assert.equal((await v.model("google.mail.read", { id: "nope" })).error.code, "not_found");

  // Every read so far used a read-only token for alex, and nothing else.
  const api = fake.apiCalls();
  assert.ok(api.length > 0);
  for (const c of api) {
    assert.equal(c.method, "GET", `${c.method} ${c.path}`);
    assert.equal(c.subject, ME);
    assert.equal(c.scopes?.length, 1);
    assert.ok(readScopes.has(c.scopes[0]), c.scopes[0]);
  }

  // A draft goes nowhere.
  const draft = await v.model("google.mail.draft", { to: "dana@harlowlegal.com", subject: "Engagement letter", body: "Signed copy attached tomorrow." });
  assert.ok(draft.data.draft_id, JSON.stringify(draft));
  assert.equal(fake.mail.drafts.length, 1);
  assert.equal(fake.mail.sent.length, 0);
  assert.deepEqual(fake.calls.find(c => c.path.endsWith("/drafts"))?.scopes, [S + "gmail.compose"]);
  assert.match((await v.model("google.mail.draft", { to: "dana@harlowlegal.com", subject: "a\r\nBcc: x@example.com", body: "b" })).error.message, /line break/);

  // A send is held, filed under the model's thread; nothing reaches Gmail.
  const held = await v.model("google.mail.send", { to: "dana@harlowlegal.com", cc: "juno@northwindbakery.com", subject: "Re: Harlow Legal engagement letter",
    body: "Hi Dana, signed and attached. Alex", in_reply_to: "<mharlow1@mail.example.com>", thread_id: "tharlow", why: "Dana asked for the signed letter" });
  const id = held.data.held;
  assert.ok(id, JSON.stringify(held));
  assert.equal(fake.mail.sent.length, 0);
  const pending = (await v.local("gate.held", { thread: "t-1" })).data;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].via, "google:work");
  assert.equal(pending[0].summary, "Re: Harlow Legal engagement letter");

  // A model cannot release it itself.
  assert.equal((await v.model("google.release", { id, to: ["dana@harlowlegal.com"], content: {} })).error.code, "no_such_tool");
  assert.match((await v.d.registry.call("google.release", { id, to: ["x@example.com"], content: { subject: "s", body: "b" } }, "module:courier")).error.message, /only the Gate/);

  // The person approves with a new subject: exactly that goes out, with gmail.send alone.
  const out = await v.cli("gate.approve", { id, edited: { subject: "Signed: Harlow Legal engagement letter" } });
  assert.equal(out.data.state, "sent", JSON.stringify(out));
  assert.equal(fake.mail.sent.length, 1);
  const sent = fake.mail.sent[0];
  assert.equal(sent.headers.Subject, "Signed: Harlow Legal engagement letter");
  assert.equal(sent.headers.To, "dana@harlowlegal.com");
  assert.equal(sent.headers.Cc, "juno@northwindbakery.com");
  assert.equal(sent.headers.From, ME);
  assert.equal(sent.headers["In-Reply-To"], "<mharlow1@mail.example.com>");
  assert.equal(sent.threadId, "tharlow");
  assert.equal(Buffer.from(sent.text.replace(/\r\n/g, ""), "base64").toString("utf8"), "Hi Dana, signed and attached. Alex");
  const sendCall = fake.calls.find(c => c.path.endsWith("/messages/send"));
  assert.deepEqual(sendCall?.scopes, [S + "gmail.send"]);
  assert.deepEqual(fake.tokens.get([...fake.tokens.entries()].find(([, tk]) => tk.scopes.includes(S + "gmail.send"))?.[0] ?? "")?.scopes, [S + "gmail.send"]);

  // A rejected send sends nothing.
  const again = (await v.model("google.mail.send", { to: "dana@harlowlegal.com", subject: "Second thoughts", body: "Never mind." })).data.held;
  assert.equal((await v.cli("gate.reject", { id: again })).data.state, "rejected");
  assert.equal(fake.mail.sent.length, 1);

  // An event with no attendees is written at once, and nobody is told.
  const quiet = await v.model("google.calendar.create", { title: "Focus: Northwind Bakery menu", start: "2026-10-01T09:00:00Z", end: "2026-10-01T10:00:00Z" });
  assert.ok(quiet.data.event.id, JSON.stringify(quiet));
  const quietEv = fake.calendar.events.find(e => e.id === quiet.data.event.id);
  assert.equal(quietEv._sendUpdates, "none");
  assert.deepEqual(fake.calls.find(c => c.method === "POST" && c.path.endsWith("/events"))?.scopes, [S + "calendar.events"]);
  const moved = await v.model("google.calendar.update", { id: quiet.data.event.id, where: "Northwind Bakery" });
  assert.equal(moved.data.event.where, "Northwind Bakery");
  assert.equal(fake.calendar.invites.length, 0);

  // An event with attendees is held; approval creates it with sendUpdates=all.
  const before = fake.calendar.events.length;
  const invite = await v.model("google.calendar.create", { title: "Harlow Legal signing", start: "2026-10-02T15:00:00Z", where: "Zoom", attendees: ["dana@harlowlegal.com"] });
  const inviteId = invite.data.held;
  assert.ok(inviteId, JSON.stringify(invite));
  assert.equal(fake.calendar.events.length, before);
  assert.equal(fake.calendar.invites.length, 0);
  const got = (await v.local("gate.get", { id: inviteId })).data;
  assert.deepEqual(got.to, ["dana@harlowlegal.com"]);
  assert.equal(got.summary, "Harlow Legal signing");
  const released = await v.cli("gate.approve", { id: inviteId, edited: { to: ["dana@harlowlegal.com", "kit@northwindbakery.com"] } });
  assert.equal(released.data.state, "sent", JSON.stringify(released));
  assert.equal(fake.calendar.events.length, before + 1);
  assert.deepEqual(fake.calendar.invites, [{ eventId: released.data.result.event_id, to: ["dana@harlowlegal.com", "kit@northwindbakery.com"], sendUpdates: "all" }]);

  // Changing attendees on an existing event is held too.
  const upd = await v.model("google.calendar.update", { id: "evnorthwind1", attendees: ["kit@northwindbakery.com"] });
  assert.ok(upd.data.held);
  assert.equal(fake.calendar.invites.length, 1);

  // The Capsule.
  const find = async q => (await v.local("google.find", { q, limit: 4 })).data.rows;
  assert.deepEqual((await find("what's next")).map(r => r.id), ["google:work:event:evharlow1", "google:work:event:evnorthwind1", `google:work:event:${quiet.data.event.id}`, `google:work:event:${released.data.result.event_id}`]);
  assert.equal((await find("next meeting"))[0].name, "Harlow Legal check-in");
  assert.ok((await find("tomorrow")).some(r => r.id === "google:work:event:evnorthwind1"));
  const soon = new Date(Date.now() + 30 * 60_000);
  if (soon.getUTCDate() === new Date().getUTCDate()) assert.ok((await find("today")).some(r => r.id === "google:work:event:evharlow1"));
  const fromDana = await find("email from dana");
  assert.deepEqual(fromDana.map(r => r.id), ["google:work:mail:mharlow1"]);
  assert.equal(fromDana[0].kind, "email");
  assert.match(fromDana[0].sub, /Dana Reyes/);
  assert.deepEqual((await find("mail from dana")).map(r => r.id), ["google:work:mail:mharlow1"]);
  assert.deepEqual((await find("email about sourdough")).map(r => r.id), ["google:work:mail:mnorthwind1"]);
  const both = await find("northwind");
  assert.ok(both.some(r => r.kind === "event") && both.some(r => r.kind === "email"), JSON.stringify(both));

  const opened = (await v.local("google.open", { id: "google:work:event:evharlow1" })).data;
  assert.equal(opened.url, `https://calendar.google.com/calendar/event?eid=${Buffer.from(`evharlow1 ${ME}`).toString("base64url")}`);
  assert.match(opened.said, /Harlow Legal check-in/);
  const openedMail = (await v.local("google.open", { id: "google:work:mail:mharlow1" })).data;
  assert.equal(openedMail.url, `https://mail.google.com/mail/?authuser=${encodeURIComponent(ME)}#all/tharlow`);
  const drafts = fake.mail.drafts.length;
  const reply = (await v.local("google.open", { id: "google:work:mail:mharlow1", as: "reply" })).data;
  assert.match(reply.said, /drafts/);
  assert.equal(fake.mail.drafts.length, drafts + 1);
  const rd = fake.mail.drafts.at(-1).message;
  assert.equal(rd.headers.To, "dana@harlowlegal.com");
  assert.equal(rd.headers.Subject, "Re: Harlow Legal engagement letter");
  assert.equal(rd.headers["In-Reply-To"], "<mharlow1@mail.example.com>");
  assert.equal(rd.threadId, "tharlow");
  assert.equal(fake.mail.sent.length, 1, "a reply draft sent nothing");

  // Events say what happened, never with content.
  const events = v.d.registry.deps.events.since(0, { limit: 5000 }).filter(e => e.type.startsWith("google."));
  assert.deepEqual([...new Set(events.map(e => e.type))].sort(), ["google.added", "google.drafted", "google.scheduled", "google.sent"]);
  assert.ok(!JSON.stringify(events).includes("engagement"), "an event carried content");

  const key = JSON.parse(sa);
  assertNoLeak(v, secretsOf(fake, [sa, key.private_key, key.private_key_id]));

  assert.deepEqual((await v.cli("google.remove", { name: "work" })).data, { removed: true });
  assert.equal((await v.mcp("google.remove", { name: "work" })).error.code, "denied");
});

test("google: OAuth refreshes, retries once on an expired token, and reads merge across accounts", async t => {
  const home = await startFakeGoogle(t);
  const work = await startFakeGoogle(t);
  const v = await vyred(t);
  const oauth = home.oauthItem();
  await item(v, "home-google", "env-set", oauth);
  const sa = work.serviceAccount(ME);
  await item(v, "work-google", "secret", { value: sa });
  assert.ok((await v.cli("google.add", { name: "home", email: ME, auth: { type: "oauth", item: "home-google" }, base: home.base })).data);
  assert.ok((await v.cli("google.add", { name: "work", email: ME, auth: { type: "service-account", item: "work-google" }, base: work.base })).data);

  const first = (await v.model("google.calendar.next", { limit: 10 })).data.events;
  assert.equal(first.length, 4);
  assert.deepEqual(first.map(e => e.account).slice(0, 2).sort(), ["home", "work"], "both accounts' next event comes first");
  const refreshes = () => home.calls.filter(c => c.path === "/token" && c.body.grant_type === "refresh_token").length;
  assert.equal(refreshes(), 1);

  // Google stops taking the token: the module refreshes once and the call still answers.
  home.expireTokens();
  const again = (await v.model("google.calendar.next", { account: "home" })).data.events;
  assert.equal(again.length, 2);
  assert.equal(refreshes(), 2);
  // Only this test's reads: the planner's calendar mirror reads a window (timeMax) on google.added.
  const statuses = home.apiCalls().filter(c => c.path.includes("/events") && !("timeMax" in c.query)).length;
  assert.equal(statuses, 3, "one call, one 401, one retry");

  // Writes need one account.
  assert.match((await v.model("google.mail.draft", { to: "dana@harlowlegal.com", subject: "s", body: "b" })).error.message, /say which account/);
  assert.ok((await v.model("google.mail.draft", { account: "home", to: "dana@harlowlegal.com", subject: "s", body: "b" })).data.draft_id);
  assert.equal(home.mail.drafts.length, 1);
  assert.equal(work.mail.drafts.length, 0);

  // Mail search merges, and the rows name their account when there are two.
  const rows = (await v.local("google.find", { q: "from:dana" })).data.rows;
  assert.deepEqual(rows.map(r => r.id).sort(), ["google:home:mail:mharlow1", "google:work:mail:mharlow1"]);
  assert.ok(rows.every(r => /home|work/.test(r.sub)));

  const homeTest = (await v.cli("google.test", { name: "home" })).data;
  assert.equal(homeTest.ok, true);
  assert.ok(!("client_id" in homeTest) && !("admin_scopes" in homeTest), "an OAuth account gets no delegation helper");
  assert.equal(home.mail.sent.length, 0, "google.test sends nothing");
  assert.equal(home.mail.drafts.length, 1, "google.test drafts nothing");

  assertNoLeak(v, secretsOf(home, [oauth.client_secret, oauth.refresh_token, JSON.parse(sa).private_key, ...work.tokens.keys()]));
});

test("google: google.test names the scopes domain-wide delegation refuses", async t => {
  const fake = await startFakeGoogle(t, { allowedScopes: [S + "calendar.readonly", S + "calendar.events", S + "gmail.readonly", S + "gmail.compose"] });
  const v = await vyred(t);
  await item(v, "work-google", "secret", { value: fake.serviceAccount(ME) });
  assert.ok((await v.cli("google.add", { name: "work", email: ME, auth: { type: "service-account", item: "work-google" }, base: fake.base })).data);
  const r = (await v.cli("google.test", {})).data;
  assert.equal(r.ok, false);
  assert.deepEqual(r.scopes, { "calendar.readonly": true, "calendar.events": true, "gmail.readonly": true, "gmail.compose": true, "gmail.send": false });
  assert.match(r.error, /gmail\.send/);
  assert.match(r.error, /admin console/);
  assert.match(r.client_id, /^\d+$/);
  assert.equal(r.admin_scopes, ADMIN_SCOPES);

  // A held send that the admin console will refuse fails at release, stays held, and says why.
  const id = (await v.model("google.mail.send", { to: "dana@harlowlegal.com", subject: "s", body: "b" })).data.held;
  const out = (await v.cli("gate.approve", { id })).data;
  assert.equal(out.state, "failed");
  assert.match(out.error, /domain-wide delegation/);
  assert.equal(fake.mail.sent.length, 0);
});

test("google: with no account, reads say how to add one and the Capsule shows nothing", async t => {
  const v = await vyred(t);
  assert.equal((await v.model("google.calendar.next", {})).error.code, "no_account");
  assert.deepEqual((await v.local("google.find", { q: "what's next" })).data, { rows: [] });
});

test("google: Sign in with Google over the loopback adds an account that works, and only a person can start it", async t => {
  const fake = await startFakeGoogle(t);
  const v = await vyred(t);
  const client = fake.oauthClient();
  await item(v, "google-client", "env-set", client);
  const idle = tcp();

  // A model cannot start, finish or cancel a sign-in.
  for (const [tool, input] of [["google.connect", { name: "home", client: "google-client" }], ["google.connect.finish", { id: "gc_x", url: "http://127.0.0.1/" }], ["google.connect.cancel", { id: "gc_x" }]]) {
    assert.equal((await v.model(tool, input)).error.code, "denied", tool);
    assert.equal((await v.mcp(tool, input)).error.code, "denied", tool);
  }
  assert.equal(tcp(), idle, "nothing listens before a sign-in");
  assert.match((await v.cli("google.connect", { name: "home", client: "google-client", base: "https://example.org" })).error.message, /loopback/);

  const started = (await v.cli("google.connect", { name: "home", client: "google-client", base: fake.base })).data;
  assert.ok(started?.id && started.url && started.redirect, JSON.stringify(started));
  assert.equal(tcp(), idle + 1, "one listener while the sign-in is open");
  const port = Number(new URL(started.redirect).port);

  const back = fake.consent(started.url);
  const page = await fetch(back);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /go back to Vyre/);
  assert.equal(await tcpIs(idle), idle, "the listener closes when the sign-in ends");
  assert.equal(await listening(port), false);

  const accts = (await v.mcp("google.accounts")).data;
  assert.deepEqual(accts.map(a => [a.name, a.email, a.auth]), [["home", ME, { type: "oauth", item: "google-home" }]]);
  const vitem = (await v.cli("vault.list", { filter: "google-home" })).data.items.find(x => x.name === "google-home");
  assert.equal(vitem.origin, "module:google");
  assert.equal(vitem.kind, "env-set");
  assert.deepEqual(vitem.fields.sort(), ["client_id", "client_secret", "refresh_token", "token_uri"]);
  assert.deepEqual(vitem.grants, [{ module: "google" }]);

  const tested = (await v.cli("google.test", { name: "home" })).data;
  assert.equal(tested.ok, true, JSON.stringify(tested));
  assert.ok(!("client_id" in tested));
  assert.deepEqual((await v.model("google.calendar.next", {})).data.events.map(e => e.id), ["evharlow1", "evnorthwind1"]);

  const events = v.d.registry.deps.events.since(0, { limit: 5000 }).filter(e => e.type.startsWith("google."));
  assert.deepEqual(events.map(e => e.type), ["google.added", "google.connected"]);
  assert.deepEqual(events[1].payload ?? events[1].data, { id: started.id, name: "home", email: ME });

  // The name is taken now.
  assert.match((await v.cli("google.connect", { name: "home", client: "google-client" })).error.message, /already connected/);
  assert.equal(tcp(), idle);
  assertNoLeak(v, [client.client_secret, ...fake.issued.keys(), ...fake.tokens.keys(), new URL(back).searchParams.get("code") || ""]);
});

test("google: a sign-in finished by the pasted address works once, and a cancelled one closes the listener", async t => {
  const fake = await startFakeGoogle(t);
  const v = await vyred(t);
  const client = fake.oauthClient();
  await item(v, "google-client", "env-set", client);
  const idle = tcp();

  const s = (await v.cli("google.connect", { name: "phone", client: "google-client", base: fake.base })).data;
  const back = fake.consent(s.url, { email: "kit@northwindbakery.com" });
  const done = await v.cli("google.connect.finish", { id: s.id, url: back });
  assert.deepEqual(done.data, { name: "phone", email: "kit@northwindbakery.com", item: "google-phone" });
  assert.match((await v.cli("google.connect.finish", { id: s.id, url: back })).error.message, /already used/);
  assert.equal(await tcpIs(idle), idle);
  assert.equal((await v.cli("google.test", { name: "phone" })).data.ok, true);

  const c = (await v.cli("google.connect", { name: "other", client: "google-client", base: fake.base })).data;
  assert.equal(tcp(), idle + 1);
  assert.deepEqual((await v.local("google.connect.cancel", { id: c.id })).data, { cancelled: true });
  assert.equal(await tcpIs(idle), idle, "the listener closes after cancel");
  assert.equal(await listening(Number(new URL(c.redirect).port)), false);
  assert.equal((await v.cli("google.accounts")).data.length, 1);

  // A missing refresh token fails in plain words, with nothing saved.
  const n = (await v.cli("google.connect", { name: "again", client: "google-client", base: fake.base })).data;
  const noRefresh = await v.cli("google.connect.finish", { id: n.id, url: fake.consent(n.url, { refresh: false }) });
  assert.match(noRefresh.error.message, /myaccount\.google\.com\/permissions/);
  assert.ok(!(await v.cli("vault.list", { filter: "google-again" })).data.items.some(x => x.name === "google-again"));
  const types = v.d.registry.deps.events.since(0, { limit: 5000 }).filter(e => e.type.startsWith("google.")).map(e => e.type);
  assert.deepEqual(types, ["google.added", "google.connected", "google.connect-failed", "google.connect-failed"]);
  assertNoLeak(v, [client.client_secret, ...fake.issued.keys(), ...fake.tokens.keys(), new URL(back).searchParams.get("code") || ""]);
});
