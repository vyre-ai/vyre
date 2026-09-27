// @ts-check
// The mail module inside a real vyred, in a temp home, with the real vault and the real Gate,
// against the fake IMAP and SMTP servers (testing/fakes.js). Never a real server.
//
// What these prove: every tool asks vault.connections.allowed first and refuses on anything but
// yes, a missing check included; reads work over IMAP; a send is held at the Gate and goes out
// over SMTP only once the person approves, with exactly what they approved; a header injection is
// refused before anything is held; the password reaches no result, event, log line or table.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";
import { fakeSmtp, fakeImap, testCert, hasOpenssl } from "./testing/fakes.js";

const skip = !hasOpenssl && "openssl is needed to make a test certificate";
const ME = "alex@harlow.example";
const PW = `pw-${crypto.randomBytes(8).toString("hex")}"x`;
const ITEM = "harlow-mail";

async function vyred(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const lines = [];
  const d = await start({ root, presence: present, log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  t.after(() => d.stop());
  const results = [];
  const keep = fn => async (tool, input = {}) => { const r = await fn(tool, input); results.push(r); return r; };
  return { root, d, lines, results,
    cli: keep((tool, input) => call(tool, input, { root, caller: "cli" })),
    local: keep((tool, input) => call(tool, input, { root, caller: "local" })),
    // A model's call from a Vyre-owned thread, as the harness MCP server makes one.
    model: keep((tool, input) => d.registry.call(tool, input, "mcp:thread:t-1", { thread: "t-1" })),
  };
}

/**
 * Stand in for the vault's vault.connections.allowed (another team builds it): a module-only
 * tool that answers from `policy`, and records what it was asked.
 */
function fakeAllowed(v, policy) {
  const asked = [];
  v.d.registry.tools.set("vault.connections.allowed", { module: "vault", description: "test stand-in", input: { type: "object" }, internal: true, callers: null, hook: false, presence: false,
    run: async input => { asked.push(input); return policy(input); } });
  return asked;
}

test("mail: allowed-first, reads, a held send released over SMTP, and no password anywhere", { skip }, async t => {
  const imap = await fakeImap(t, { mode: "tls", users: { [ME]: PW } });
  const smtpd = await fakeSmtp(t, { mode: "starttls", users: { [ME]: PW } });
  const v = await vyred(t);
  assert.equal(v.d.registry.status().find(m => m.name === "mail")?.state, "running");
  const fields = { imap_host: "127.0.0.1", imap_port: String(imap.port), smtp_host: "127.0.0.1", smtp_port: String(smtpd.port),
    username: ME, password: PW, from: ME, security: "tls", tls_ca: testCert().cert };
  // IMAP on implicit TLS here; the second test runs both sides on STARTTLS.
  assert.ok((await v.cli("vault.put", { name: ITEM, kind: "env-set", fields, details: { provider: "imap-smtp" } })).data);
  assert.equal((await v.cli("vault.grant", { name: ITEM, module: "mail" })).data.grant.status, "active");

  // No vault.connections.allowed at all: every tool refuses, nothing connects.
  v.d.registry.tools.delete("vault.connections.allowed");
  const missing = await v.model("mail.search", { account: ITEM, query: "from:dana" });
  assert.equal(missing.error?.code, "denied");
  assert.match(missing.error.message, /not running/);
  assert.equal(imap.logins.length, 0);

  // The check errors: refused too.
  fakeAllowed(v, () => { throw new Error("vault locked"); });
  assert.match((await v.model("mail.read", { account: ITEM, id: "INBOX/11" })).error.message, /could not check.*vault locked/);

  // allowed=false: refused, and nothing is held.
  let allow = false;
  const asked = fakeAllowed(v, () => ({ allowed: allow }));
  const no = await v.model("mail.send", { account: ITEM, to: "dana@harlow.example", subject: "Hi", body: "b" });
  assert.equal(no.error?.code, "denied");
  assert.match(no.error.message, /not granted to this surface/);
  assert.deepEqual(asked[0], { source: "vault", ref: ITEM, caller: "mcp:thread:t-1" });
  assert.deepEqual((await v.model("mail.accounts")).data, [], "a surface sees only what it may use");
  assert.equal(imap.logins.length, 0);
  assert.equal((await v.local("gate.held", {})).data.length, 0);

  allow = true;
  // Accounts: names and hosts, never the password.
  const accounts = (await v.model("mail.accounts")).data;
  assert.deepEqual(accounts, [{ name: ITEM, imap_host: "127.0.0.1", imap_port: imap.port, smtp_host: "127.0.0.1", smtp_port: smtpd.port, from: ME }]);

  // mail.test is a person's: a model cannot run it.
  assert.equal((await v.model("mail.test", { account: ITEM })).error?.code, "denied");

  // Reads.
  const found = (await v.model("mail.search", { account: ITEM, query: "from:dana" })).data;
  assert.equal(found.total, 1);
  assert.deepEqual(found.messages.map(m => m.id), ["INBOX/11"]);
  assert.deepEqual(Object.keys(found.messages[0]).sort(), ["date", "from", "id", "message_id", "subject", "to", "unseen"]);
  const all = (await v.model("mail.search", { account: ITEM, limit: 2 })).data;
  assert.equal(all.total, 3);
  assert.deepEqual(all.messages.map(m => m.id), ["INBOX/15", "INBOX/12"], "newest first, limited");
  assert.deepEqual(all.messages.map(m => m.unseen), [true, true]);
  const read = (await v.model("mail.read", { account: ITEM, id: "INBOX/12" })).data;
  assert.equal(read.body, "Your order is ready.\nPick up & enjoy");
  assert.equal(read.format, "html");
  assert.equal((await v.model("mail.read", { account: ITEM, id: "INBOX/99" })).error?.code, "not_found");
  assert.equal((await v.model("mail.read", { account: ITEM, id: "nope" })).error?.code, "bad_input");
  assert.equal((await v.model("mail.search", { account: "no-such", query: "x" })).error?.code, "no_account");

  // A header injection is refused before anything is held.
  const inj = await v.model("mail.send", { account: ITEM, to: "dana@harlow.example", subject: "Hi\r\nBcc: juno@northwind.example", body: "b" });
  assert.equal(inj.error?.code, "bad_input");
  assert.match(inj.error.message, /line break/);
  assert.equal((await v.local("gate.held", {})).data.length, 0);
  assert.equal(smtpd.messages.length, 0);
});

test("mail: a send is held, only the Gate releases it, and it goes out as approved", { skip }, async t => {
  const imap = await fakeImap(t, { mode: "starttls", users: { [ME]: PW }, authPlain: true });
  const smtpd = await fakeSmtp(t, { mode: "starttls", users: { [ME]: PW } });
  const v = await vyred(t);
  assert.ok((await v.cli("vault.put", { name: ITEM, kind: "env-set", details: { provider: "imap-smtp" }, fields: {
    imap_host: "127.0.0.1", imap_port: String(imap.port), smtp_host: "127.0.0.1", smtp_port: String(smtpd.port),
    username: ME, password: PW, from: ME, security: "starttls", tls_ca: testCert().cert } })).data);
  assert.equal((await v.cli("vault.grant", { name: ITEM, module: "mail" })).data.grant.status, "active");
  fakeAllowed(v, () => ({ allowed: true }));

  const tested = (await v.cli("mail.test", { account: ITEM })).data;
  assert.deepEqual(tested, { account: ITEM, imap: { ok: true }, smtp: { ok: true } });
  assert.equal(smtpd.messages.length, 0, "a test sends nothing");

  const held = await v.model("mail.send", { account: ITEM, to: "Dana <dana@harlow.example>", cc: "juno@northwind.example", subject: "Re: Engagement letter",
    body: "Signed and attached.\n.\nAlex", reply_to_id: "INBOX/11", why: "Dana asked for the signed letter" });
  const id = held.data?.held;
  assert.ok(id, JSON.stringify(held));
  assert.equal(smtpd.messages.length, 0, "nothing is sent from mail.send");
  const pending = (await v.local("gate.held", { thread: "t-1" })).data;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].via, `mail:${ITEM}`);
  assert.ok((await v.local("gate.senders")).data.some(s => s.name === `mail:${ITEM}`));

  // A model cannot release it, nor can another module.
  assert.equal((await v.model("mail.release", { id, to: ["dana@harlow.example"], content: {} })).error?.code, "no_such_tool");
  assert.match((await v.d.registry.call("mail.release", { id, to: ["x@harlow.example"], content: { subject: "s", body: "b" } }, "module:courier")).error.message, /only the Gate/);
  assert.equal(smtpd.messages.length, 0);

  // The person approves with a new subject: exactly that goes out.
  const out = await v.cli("gate.approve", { id, edited: { subject: "Signed: engagement letter" } });
  assert.equal(out.data?.state, "sent", JSON.stringify(out));
  assert.equal(smtpd.messages.length, 1);
  const sent = smtpd.messages[0];
  assert.deepEqual(sent.to, ["dana@harlow.example", "juno@northwind.example"]);
  const head = sent.data.split("\r\n\r\n")[0];
  assert.match(head, /^Subject: Signed: engagement letter$/m);
  assert.match(head, /^To: dana@harlow\.example$/m);
  assert.match(head, /^Cc: juno@northwind\.example$/m);
  assert.match(head, /^In-Reply-To: <letter1@harlow\.example>$/m);
  assert.match(head, /^References: <letter1@harlow\.example>$/m);
  assert.match(sent.wire, /\r\n\.\.\r\n/, "the lone dot line was stuffed");
  assert.ok(v.d.registry.deps.events.since(0, { limit: 5000 }).some(e => e.type === "mail.sent"));

  // A rejected send sends nothing.
  const again = (await v.model("mail.send", { account: ITEM, to: "kit@harlow.example", subject: "Second thoughts", body: "Never mind." })).data.held;
  assert.equal((await v.cli("gate.reject", { id: again })).data.state, "rejected");
  assert.equal(smtpd.messages.length, 1);

  // A wrong password: the error says so, and never carries it.
  const wrong = `pw-${crypto.randomBytes(8).toString("hex")}`;
  assert.ok((await v.cli("vault.put", { name: "harlow-wrong", kind: "env-set", details: { provider: "imap-smtp" }, fields: {
    imap_host: "127.0.0.1", imap_port: String(imap.port), smtp_host: "127.0.0.1", smtp_port: String(smtpd.port),
    username: ME, password: wrong, from: ME, security: "starttls", tls_ca: testCert().cert } })).data);
  await v.cli("vault.grant", { name: "harlow-wrong", module: "mail" });
  const bad = (await v.cli("mail.test", { account: "harlow-wrong" })).data;
  assert.equal(bad.imap.ok, false);
  assert.match(bad.imap.error, /refused the login for alex@harlow\.example/);
  assert.equal(bad.smtp.ok, false);
  assert.match(bad.smtp.error, /refused the login for alex@harlow\.example: 535/);

  // Nothing secret reached a result, a log line, an event or a table.
  const db = v.d.registry.deps.db;
  const everything = JSON.stringify([v.results, v.lines, v.d.registry.deps.events.since(0, { limit: 5000 }), db.prepare("SELECT * FROM gate_items").all()]);
  for (const p of [PW, wrong]) {
    for (const s of [p, Buffer.from(p).toString("base64"), Buffer.from(`\0${ME}\0${p}`).toString("base64")]) assert.ok(!everything.includes(s), "a password leaked");
  }
});
