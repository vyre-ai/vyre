// @ts-check
// The mail module on a small module context: its real tools, its real table, the real IMAP and
// SMTP client against the fake mail servers and the real Apps Script client against the fake web
// app. The other modules it calls (the vault's connections and values, the Gate, google, mcp) are
// small fakes here that record what they were asked, since the vault's connections model lands
// in another branch. What it proves: the vault's list decides which accounts a caller sees; every
// send is held, through the right sender, filed under the chat or agent that asked; nothing
// reaches SMTP or the web app before the Gate releases it; a missing credential says so; the
// Capsule gets one row per account; no value ever comes back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import mail from "./index.js";
import { startFakeMail } from "./testing/fake-imap.js";
import { startFakeAppsScript } from "./testing/fake-apps-script.js";

const PASSWORD = "fixture-imap-pass-7f3a91c2";
const TOKEN = "fixture-script-token-b81e44d09a";

const DANA = { uid: 11, from: "Dana Reyes <dana@northwind-bakery.example>", to: "alex@harlow.example", subject: "Order for Friday",
  date: "2026-09-20T09:00:00Z", body: "Can we move the Friday order to 40 loaves?", unread: true };

/**
 * A module context whose ctx.call goes to handlers the test gives, and a vault that answers
 * connections per caller and values per granted item.
 */
async function world(t, { connections, items = {}, handlers = {} }) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const tools = new Map(), calls = [], events = [], logs = [], held = new Map();
  let n = 0;
  const base = {
    "vault.connections.list": ({ caller }) => connections.filter(c => {
      if (["cli", "local", "deck"].includes(caller)) return true;
      const s = caller === "capsule" ? "capsule" : /^mcp:agent:/.test(caller) ? "agents" : caller.startsWith("mcp") ? "chat" : null;
      return s && c.surfaces.includes(s);
    }).map(({ surfaces, ...c }) => c),
    "vault.connections.get": ({ id }) => { const c = connections.find(x => x.id === id); if (!c) return null; const { surfaces, ...row } = c; return row; },
    "gate.offer": () => ({ offered: true }),
    "gate.held": () => [...held.values()].filter(i => i.state === "held"),
    "gate.request": input => { const id = `g${++n}`; held.set(id, { id, state: "held", ...input }); return { id, message: "held" }; },
    "gate.get": ({ id }) => held.get(id) || null,
  };
  const all = { ...base, ...handlers };
  const ctx = {
    config: { mail: { timeout: 3000 } },
    store: { db, migrate: steps => { for (const s of steps) db.exec(s); } },
    log: m => logs.push(String(m)),
    events: { emit: (type, payload) => events.push({ type, payload }) },
    vault: {
      fetch: async (name, { field } = {}) => {
        const it = items[name];
        if (!it) throw new Error(`no item named ${name}`);
        if (!it.granted) throw new Error(`${name} is not granted to mail · vyre vault grant ${name} mail`);
        const v = it.fields[field || "value"];
        if (v === undefined) throw new Error(`${name} has no field ${field}`);
        return v;
      },
    },
    tool: (name, def) => tools.set(name, def),
    call: async (tool, input) => {
      calls.push({ tool, input });
      const h = all[tool];
      if (!h) return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
      try { return { data: await h(input) }; } catch (e) { return { error: { code: e.code || "failed", message: e.message } }; }
    },
  };
  const mod = await mail.start(ctx);
  t.after(() => mod.stop());
  /** Call a mail tool as `caller`, with the meta vyred would give; errors come back like the registry's. */
  const as = (caller, meta = {}) => async (name, input = {}) => {
    const def = tools.get(name);
    if (!def) return { error: { code: "no_such_tool" } };
    if (def.callers && !def.callers.some(c => caller === c || caller.startsWith(c + ":"))) return { error: { code: "denied" } };
    if (def.internal && !caller.startsWith("module:")) return { error: { code: "no_such_tool" } };
    try { return { data: await def.run(input, { caller, ...meta }) }; } catch (e) { return { error: { code: e.code, message: e.message, detail: e.detail } }; }
  };
  /** The Gate approving an item: it marks it sending and calls the sender's tool as module:gate. */
  const approve = async (id, edit = {}) => {
    const it = held.get(id);
    it.state = "sending";
    const r = await as("module:gate")("mail.release", { id, to: edit.to || it.to, content: { ...it.content, ...(edit.content || {}) } });
    it.state = r.error ? "failed" : "sent";
    return r;
  };
  return { tools, calls, events, logs, held, as, approve, db };
}

const conn = (id, source, provider, ref, account, surfaces = ["capsule", "chat"], capabilities = ["send_mail", "read_mail"]) =>
  ({ id, source, provider, ref, account, label: account, capabilities, surfaces });

async function imapWorld(t, extra = {}) {
  const fake = await startFakeMail(t, { user: "alex@harlow.example", password: PASSWORD, messages: [DANA] });
  const fields = { imap_host: "127.0.0.1", imap_port: String(fake.imap.port), smtp_host: "127.0.0.1", smtp_port: String(fake.smtp.port),
    username: "alex@harlow.example", password: PASSWORD, from: "alex@harlow.example", security: "none" };
  const connections = [conn("cn_imap_alex", "vault", "imap-smtp", "mail-alex", "alex@harlow.example"), ...(extra.connections || [])];
  const w = await world(t, { connections, items: { "mail-alex": { granted: extra.granted ?? true, fields }, ...(extra.items || {}) }, handlers: extra.handlers });
  return { ...w, fake };
}

const secretsNowhere = (w, values) => {
  const everything = JSON.stringify([w.events, w.logs, w.calls, w.db.prepare("SELECT * FROM mail_maps").all(), [...w.held.values()]]);
  for (const v of values) assert.ok(!everything.includes(v), "a credential leaked");
};

test("mail: an IMAP account searches and reads, and a send waits for the Gate before SMTP sees it", async t => {
  const w = await imapWorld(t);
  const chat = w.as("mcp", { thread: "t-1" });

  const accts = (await chat("mail.accounts")).data;
  assert.deepEqual(accts.map(a => [a.account, a.adapter, a.address]), [["cn_imap_alex", "imap", "alex@harlow.example"]]);

  const found = await chat("mail.search", { q: "from:dana" });
  assert.equal(found.data.messages.length, 1, JSON.stringify(found));
  assert.equal(found.data.messages[0].account, "cn_imap_alex");
  const read = await chat("mail.read", { account: "cn_imap_alex", id: found.data.messages[0].id });
  assert.match(read.data.body, /40 loaves/);
  assert.deepEqual(w.fake.seenChanges, [], "reading left the mail unread");

  const sent = await chat("mail.send", { to: "dana@northwind-bakery.example", subject: "Re: Order for Friday", body: "Yes, 40 loaves.", why: "Dana asked" });
  assert.equal(sent.data.via, "mail:cn_imap_alex", JSON.stringify(sent));
  assert.equal(w.fake.sent.length, 0, "nothing reaches SMTP before approval");
  const it = w.held.get(sent.data.held);
  assert.equal(it.thread, "t-1", "filed under the chat's thread");
  assert.deepEqual(it.to, ["dana@northwind-bakery.example"]);
  assert.ok(w.events.some(e => e.type === "mail.held" && e.payload.account === "cn_imap_alex"));

  // The person edits the body at the Gate and approves; exactly that goes out, once.
  const r = await w.approve(sent.data.held, { content: { body: "Yes, 40 loaves, rye not spelt." } });
  assert.ok(r.data && r.data.sent, JSON.stringify(r));
  assert.equal(w.fake.sent.length, 1);
  assert.deepEqual(w.fake.sent[0].rcpt, ["dana@northwind-bakery.example"]);
  assert.match(Buffer.from(w.fake.sent[0].data.split("\r\n\r\n")[1].replace(/\s/g, ""), "base64").toString(), /rye not spelt/);
  assert.ok(w.events.some(e => e.type === "mail.sent"));

  // A second release of the same item is refused: it is no longer being sent.
  assert.equal((await w.as("module:gate")("mail.release", { id: sent.data.held, to: ["dana@northwind-bakery.example"], content: w.held.get(sent.data.held).content })).error.code, "denied");
  // Only the Gate releases.
  assert.equal((await w.as("module:mail")("mail.release", { id: "g1", to: [], content: {} })).error.code, "denied");
  assert.equal(w.fake.sent.length, 1);
  secretsNowhere(w, [PASSWORD]);
});

test("mail: a rejected send never reaches SMTP, and an ungranted item answers needs_credential", async t => {
  const w = await imapWorld(t, { granted: false });
  const chat = w.as("mcp", { thread: "t-2" });
  const r = await chat("mail.search", { q: "order" });
  assert.equal(r.error.code, "needs_credential", JSON.stringify(r));
  assert.deepEqual(r.error.detail, { module: "mail", need: "imap", account: "cn_imap_alex" });
  assert.ok(w.events.some(e => e.type === "mail.needs-credential" && e.payload.item === "mail-alex"));
  assert.ok(!JSON.stringify(r).includes(PASSWORD));

  // A send is still only held: it needs no value until release.
  const held = await chat("mail.send", { to: "dana@northwind-bakery.example", subject: "Hello", body: "Hi" });
  assert.ok(held.data.held);
  w.held.get(held.data.held).state = "rejected";
  assert.equal((await w.as("module:gate")("mail.release", { id: held.data.held, to: ["dana@northwind-bakery.example"], content: { subject: "Hello", body: "Hi" } })).error.code, "denied");
  assert.equal(w.fake.sent.length, 0);
});

test("mail: surfaces come from the vault's list for the verified caller, and a send never guesses", async t => {
  const g = conn("cn_google_work", "google", "google-oauth", "work", "alex@harlow.example", ["capsule", "chat", "agents"]);
  const w = await imapWorld(t, { connections: [g], handlers: {
    "google.mail.send": input => ({ held: "gg1", message: "held", input }),
    "google.mail.search": () => ({ messages: [] }),
  } });
  const ids = async (caller, meta) => ((await w.as(caller, meta)("mail.accounts")).data || []).map(a => a.account);

  assert.deepEqual(await ids("cli"), ["cn_imap_alex", "cn_google_work"]);
  assert.deepEqual(await ids("capsule"), ["cn_imap_alex", "cn_google_work"]);
  assert.deepEqual(await ids("mcp:agent:kit"), ["cn_google_work"], "agents only where granted");
  assert.deepEqual(await ids("mcp", { agent: "juno", thread: "t-5" }), ["cn_google_work"]);
  assert.deepEqual(await ids("tailnet-guest:someone"), [], "an unknown caller sees nothing");

  // Two accounts and none named: a question, listing both.
  const amb = await w.as("capsule")("mail.send", { to: "dana@northwind-bakery.example", subject: "Hi", body: "Hi" });
  assert.equal(amb.error.code, "ambiguous");
  assert.deepEqual(amb.error.detail.accounts.map(a => a.account), ["cn_imap_alex", "cn_google_work"]);

  // An agent cannot name the account it may not use, and the refusal lists only its own.
  const agent = w.as("mcp:agent:kit", { agent: "kit", thread: "t-kit" });
  const no = await agent("mail.send", { account: "cn_imap_alex", to: "dana@northwind-bakery.example", subject: "Hi", body: "Hi" });
  assert.equal(no.error.code, "no_account");
  assert.ok(!no.error.message.includes("mail-alex"));

  // The agent's send goes through google, filed under its thread and agent.
  const ok = await agent("mail.send", { to: "dana@northwind-bakery.example", subject: "Hi", body: "Hi" });
  assert.equal(ok.data.via, "google:work", JSON.stringify(ok));
  const call = w.calls.find(c => c.tool === "google.mail.send");
  assert.deepEqual(call.input.on_behalf, { thread: "t-kit", agent: "kit" });
  assert.equal(call.input.account, "work");

  // A read-only connection never sends.
  const ro = await world(t, { connections: [conn("cn_ro", "google", "google-oauth", "archive", "archive@harlow.example", ["chat"], ["read_mail"])],
    handlers: { "google.mail.send": () => ({ held: "x" }) } });
  const r = await ro.as("mcp", { thread: "t-6" })("mail.send", { account: "cn_ro", to: "dana@northwind-bakery.example", subject: "Hi", body: "Hi" });
  assert.equal(r.error.code, "denied");
  assert.ok(!ro.calls.some(c => c.tool === "google.mail.send"));
});

test("mail: an MCP account maps onto its server's tools, and its send is held with hold:true", async t => {
  const tools = [
    { server: "gmail-work", tool: "send_email", name: "gmail-work__send_email", outward: true, input: { type: "object", properties: { to: { type: "array" }, subject: { type: "string" }, body: { type: "string" } } } },
    { server: "gmail-work", tool: "search_emails", name: "gmail-work__search_emails", outward: false, input: { type: "object", properties: { query: { type: "string" }, max_results: { type: "integer" } } } },
    { server: "gmail-work", tool: "get_email", name: "gmail-work__get_email", outward: false, input: { type: "object", properties: { id: { type: "string" } } } },
    { server: "gmail-home", tool: "send_email", name: "gmail-home__send_email", outward: true, input: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } } } },
  ];
  const mcpCalls = [];
  const w = await world(t, {
    connections: [conn("cn_mcp_work", "mcp", "mcp", "gmail-work", "alex@harlow.example"), conn("cn_mcp_home", "mcp", "mcp", "gmail-home", "alex.home@northwind-bakery.example")],
    handlers: {
      "mcp.tools": () => tools,
      "mcp.test": () => ({ ok: true, tools: 3 }),
      "mcp.call": input => {
        mcpCalls.push(input);
        if (input.hold) return { held: `m${mcpCalls.length}`, message: "held" };
        if (input.tool === "search_emails") return { structuredContent: { messages: [{ id: "a1", from: "Dana Reyes <dana@northwind-bakery.example>", subject: "Rota", date: "2026-09-21T10:00:00Z" }] } };
        return { structuredContent: { id: input.arguments.id, from: "dana@northwind-bakery.example", subject: "Rota", body: "Ovens at six." } };
      },
    },
  });
  const chat = w.as("mcp", { thread: "t-3" });

  const s = await chat("mail.send", { account: "cn_mcp_work", to: "dana@northwind-bakery.example", subject: "Rota", body: "See you at six." });
  assert.equal(s.data.via, "mcp:gmail-work", JSON.stringify(s));
  const call = mcpCalls.at(-1);
  assert.equal(call.hold, true, "always held, whatever the tool's mode");
  assert.deepEqual(call.on_behalf, { thread: "t-3" });
  assert.deepEqual([call.server, call.tool, call.arguments.to], ["gmail-work", "send_email", ["dana@northwind-bakery.example"]]);

  // The other instance of the same server has its own map: `to` is a comma string there.
  await chat("mail.send", { account: "cn_mcp_home", to: ["dana@northwind-bakery.example", "alex@harlow.example"], subject: "Rota", body: "x" });
  assert.deepEqual([mcpCalls.at(-1).server, mcpCalls.at(-1).arguments.to], ["gmail-home", "dana@northwind-bakery.example, alex@harlow.example"]);

  // Search fans out; the home server has no search tool, which is an error entry, not a failure.
  const found = await chat("mail.search", { q: "rota" });
  assert.equal(found.data.messages[0].account, "cn_mcp_work");
  assert.deepEqual(found.data.errors.map(e => [e.account, e.code]), [["cn_mcp_home", "unsupported"]]);
  assert.equal((await chat("mail.read", { account: "cn_mcp_work", id: "a1" })).data.body, "Ovens at six.");

  // The person can see and correct the map; a model cannot.
  assert.equal((await chat("mail.map", { account: "cn_mcp_work" })).error.code, "denied");
  const shown = await w.as("deck")("mail.map", { account: "cn_mcp_work" });
  assert.equal(shown.data.map.send.tool, "send_email");
  const bad = await w.as("deck")("mail.map", { account: "cn_mcp_work", map: { send: { tool: "nope", to: "to", subject: "subject", body: "body" } } });
  assert.match(bad.error.message, /no tool nope/);
  assert.equal((await w.as("cli")("mail.test", { account: "cn_mcp_work" })).data.can.send, true);
});

test("mail: an Apps Script account searches and sends only on release, and its token goes nowhere", async t => {
  const fake = await startFakeAppsScript(t, { token: TOKEN, address: "alex@harlow.example" });
  const w = await world(t, {
    connections: [conn("cn_script", "vault", "google-apps-script", "script-alex", "alex@harlow.example")],
    items: { "script-alex": { granted: true, fields: { url: fake.url, token: TOKEN } } },
  });
  const cap = w.as("capsule");
  const found = await cap("mail.search", { q: "from:dana" });
  assert.ok(found.data.messages.length >= 1, JSON.stringify(found));
  const s = await cap("mail.send", { to: "dana@northwind-bakery.example", subject: "Friday", body: "40 loaves it is." });
  assert.equal(s.data.via, "mail:cn_script");
  assert.equal(fake.sent.length, 0);
  const r = await w.approve(s.data.held);
  assert.ok(r.data && r.data.sent, JSON.stringify(r));
  assert.equal(fake.sent.length, 1);
  const test1 = await w.as("cli")("mail.test", { account: "cn_script" });
  assert.equal(test1.data.ok, true, JSON.stringify(test1));
  secretsNowhere(w, [TOKEN, fake.url]);
  assert.ok(!JSON.stringify([found, s, r, test1]).includes(TOKEN));
});

test("mail: the Capsule offers every account that can send, prefills what the words said, and resolves a name", async t => {
  const g = conn("cn_google_work", "google", "google-oauth", "work", "alex@harlowlegal.example");
  const ro = conn("cn_readonly", "google", "google-oauth", "archive", "archive@harlow.example", ["capsule"], ["read_mail"]);
  const w = await imapWorld(t, { connections: [g, ro], handlers: {
    "google.mail.send": () => ({ held: "gg1", message: "held" }),
    "google.mail.search": () => ({ messages: [] }),
  } });
  const cap = w.as("capsule");

  const rows = (await cap("mail.find", { q: "send an email" })).data.rows;
  assert.deepEqual(rows.map(r => r.name), ["Send from alex@harlow.example", "Send from alex@harlowlegal.example"], "the read-only account is not offered");
  assert.equal((await cap("mail.find", { q: "what's next" })).data.rows.length, 0);

  const pre = (await cap("mail.find", { q: "email dana@northwind-bakery.example about the order" })).data.rows[0];
  assert.match(pre.sub, /to dana@northwind-bakery\.example about The order/);
  const h = await cap("mail.compose", { id: pre.id });
  assert.equal(h.data.kind, "held", JSON.stringify(h));
  const it = w.held.get(h.data.held);
  assert.deepEqual([it.to, it.content.subject, it.content.body], [["dana@northwind-bakery.example"], "The order", ""]);

  // "write to dana": the address comes from Dana's own mail in the account.
  const byName = (await cap("mail.find", { q: "write to dana saying the rota is ready" })).data.rows[0];
  const h2 = await cap("mail.compose", { id: byName.id });
  assert.deepEqual(w.held.get(h2.data.held).to, ["dana@northwind-bakery.example"], JSON.stringify(h2));
  assert.equal(w.held.get(h2.data.held).content.body, "the rota is ready");

  // "email from dana" gives message rows; opening one reads it.
  const msgs = (await cap("mail.find", { q: "email from dana" })).data.rows;
  assert.equal(msgs[0].kind, "email");
  assert.match((await cap("mail.compose", { id: msgs[0].id })).data.message.body, /40 loaves/);

  // An unknown name is a clear question, and nothing is held.
  const before = w.held.size;
  const unknown = await cap("mail.compose", { id: (await cap("mail.find", { q: "write to morgan" })).data.rows[0].id });
  assert.equal(unknown.error.code, "needs_to");
  assert.equal(w.held.size, before);
  assert.equal(w.fake.sent.length, 0);
  secretsNowhere(w, [PASSWORD]);
});

test("mail: after a restart, a held mail item's sender is offered again so it can still be approved", async t => {
  const w = await imapWorld(t);
  const s = await w.as("capsule")("mail.send", { to: "dana@northwind-bakery.example", subject: "Hi", body: "Hi" });
  assert.ok(s.data.held);
  // A fresh module on the same Gate: it offers mail:cn_imap_alex at start.
  const offers = w.calls.filter(c => c.tool === "gate.offer").length;
  const again = await world(t, { connections: [], handlers: { "gate.held": () => [...w.held.values()] } });
  assert.ok(again.calls.some(c => c.tool === "gate.offer" && c.input.name === "mail:cn_imap_alex"));
  assert.ok(offers >= 1);
});
