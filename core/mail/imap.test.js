// @ts-check
// The imap adapter against the in-process fake (core/mail/testing/fake-imap.js): the config rules,
// the read-only guarantees (nothing marked read, no MAIL FROM from a test), MIME reading, the
// send path with Bcc kept out of the headers, and that no error ever carries the password.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { imapAdapter, smtpData, searchCriteria } from "./imap.js";
import { parseQuery } from "../connectors/message.js";
import { startFakeMail } from "./testing/fake-imap.js";

const PASS = "correct horse battery";
const pw = (v = PASS) => async () => v;
const NOW = Date.UTC(2026, 8, 27, 12);
const day = n => new Date(NOW - n * 86_400_000).toISOString();
const DANA = "Dana Reyes <dana@northwind-bakery.example>";
const ORDERS = "Northwind Orders <orders@northwind-bakery.example>";

const inbox = () => [
  { uid: 3, from: DANA, subject: "Sourdough order for Friday", date: day(20), body: "Two loaves, please.", unread: false },
  { uid: 7, from: ORDERS, subject: "Invoice 1042", date: day(5), body: "Your invoice for the croissants is attached.", unread: true },
  { uid: 9, from: DANA, to: "alex@harlow.example, orders@northwind-bakery.example", subject: "Rye question", date: day(1), body: "Do you still want the rye on Tuesday?", unread: true },
  { uid: 12, from: ORDERS, subject: "Delivery window", date: day(0.5), body: "We deliver between 7 and 9.", unread: false },
];

const b64body = data => {
  const i = data.indexOf("\r\n\r\n");
  return Buffer.from(data.slice(i + 4).replace(/\r\n/g, ""), "base64").toString("utf8");
};

// ---------------------------------------------------------------- check

test("check: defaults pass, TLS is required except to loopback, hosts are plain names", () => {
  const a = imapAdapter();
  const base = { address: "alex@harlow.example", imap: { host: "imap.harlow.example" }, smtp: { host: "smtp.harlow.example" }, auth: { item: "mail-alex" } };
  assert.equal(a.check(base), null);
  assert.equal(a.check({ ...base, smtp: { host: "smtp.harlow.example", port: 587 } }), null);
  assert.match(String(a.check({ ...base, imap: { host: "imap.harlow.example", tls: "none" } })), /TLS/);
  assert.match(String(a.check({ ...base, smtp: { host: "smtp.harlow.example", port: 25, tls: "none" } })), /TLS/);
  for (const host of ["127.0.0.1", "localhost", "::1"]) assert.equal(a.check({ ...base, imap: { host, port: 1143, tls: "none" }, smtp: { host, port: 1025, tls: "none" } }), null);
  for (const host of ["imaps://imap.harlow.example", "imap.harlow.example/inbox", "imap.harlow.example:993", "", "bad host"]) {
    assert.match(String(a.check({ ...base, imap: { host } })), /imap\.host/, host);
  }
  assert.match(String(a.check({ ...base, imap: { host: "imap.harlow.example", tls: "maybe" } })), /tls/);
  assert.match(String(a.check({ ...base, imap: { host: "imap.harlow.example", port: 70000 } })), /port/);
  assert.match(String(a.check({ ...base, address: "alex" })), /address/);
  assert.match(String(a.check({ ...base, auth: {} })), /auth\.item/);
  assert.match(String(a.check({ ...base, username: "a\r\nb" })), /username/);
  assert.deepEqual(a.items(base), ["mail-alex"]);
});

test("check: default ports and TLS modes reach connect", async () => {
  const seen = [];
  const connect = o => {
    seen.push(o);
    const s = Object.assign(new EventEmitter(), { write() {}, destroy() {} });
    setImmediate(() => s.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" })));
    return /** @type {any} */ (s);
  };
  const a = imapAdapter({ connect });
  const cfg = { address: "alex@harlow.example", imap: { host: "imap.harlow.example" }, smtp: { host: "smtp.harlow.example" }, auth: { item: "i" } };
  const r = await a.test(cfg, pw());
  assert.equal(r.ok, false);
  assert.equal(r.code, "network");
  await a.test({ ...cfg, smtp: { host: "smtp.harlow.example", port: 587 } }, pw());
  assert.deepEqual(seen.map(o => [o.host, o.port, o.tls]), [
    ["imap.harlow.example", 993, true], ["smtp.harlow.example", 465, true],
    ["imap.harlow.example", 993, true], ["smtp.harlow.example", 587, false],
  ]);
  assert.equal(seen[0].servername, "imap.harlow.example");
});

// ---------------------------------------------------------------- test()

test("test(): logs in on both protocols and never starts a message", async t => {
  const fake = await startFakeMail(t, { messages: inbox() });
  const r = await imapAdapter().test(fake.config(), pw());
  assert.deepEqual(r, { ok: true, can: { search: true, read: true, send: true } });
  assert.equal(fake.mailFromCount, 0);
  assert.equal(fake.sent.length, 0);
  assert.deepEqual(fake.logins.map(l => [l.proto, l.ok]), [["imap", true], ["smtp", true]]);
  assert.ok(fake.commands.some(c => / EXAMINE INBOX$/.test(c)));
  assert.ok(!fake.commands.some(c => / SELECT /.test(c)));
});

test("test(): a wrong password is code auth, and the password never appears, even when the server echoes it", async t => {
  const fake = await startFakeMail(t, { echo: true });
  const wrong = "hunter2-wrong-password";
  const r = await imapAdapter().test(fake.config(), pw(wrong));
  assert.equal(r.ok, false);
  assert.equal(r.code, "auth");
  assert.deepEqual(r.can, { search: false, read: false, send: false });
  assert.ok(!String(r.error).includes(wrong), r.error);
  assert.ok(!String(r.error).includes(Buffer.from(wrong).toString("base64")), r.error);
  assert.ok(!String(r.error).includes(Buffer.from(`\0alex@harlow.example\0${wrong}`).toString("base64")), r.error);
  assert.equal(fake.mailFromCount, 0);
});

test("a password that needs an IMAP literal logs in", async t => {
  const odd = "pässwörd \"quoted\" \\ 9";
  const fake = await startFakeMail(t, { password: odd });
  const r = await imapAdapter().test(fake.config(), pw(odd));
  assert.equal(r.ok, true, r.error);
  assert.ok(fake.commands.some(c => /LOGIN "alex@harlow.example" \{\}/.test(c)));
});

test("LOGINDISABLED falls back to AUTHENTICATE PLAIN", async t => {
  const fake = await startFakeMail(t, { loginDisabled: true, messages: inbox() });
  const r = await imapAdapter().test(fake.config(), pw());
  assert.equal(r.ok, true, r.error);
  assert.equal(fake.logins[0].mech, "PLAIN");
});

// ---------------------------------------------------------------- search

test("search: each query part becomes its IMAP key", () => {
  const q = s => searchCriteria(parseQuery(s), NOW).map(p => (typeof p === "string" ? p : `{${p.lit.toString()}}`)).join(" ");
  assert.equal(q(""), "ALL");
  assert.equal(q("from:dana"), 'FROM "dana"');
  assert.equal(q("to:orders@northwind-bakery.example"), 'TO "orders@northwind-bakery.example"');
  assert.equal(q('subject:"sourdough order"'), 'SUBJECT "sourdough order"');
  assert.equal(q("rye tuesday"), 'TEXT "rye" TEXT "tuesday"');
  assert.equal(q("newer_than:7d"), "SINCE 20-Sep-2026");
  assert.equal(q("is:unread"), "UNSEEN");
  assert.equal(q("from:dana is:unread newer_than:2d rye"), 'FROM "dana" TEXT "rye" SINCE 25-Sep-2026 UNSEEN');
  assert.equal(q("croissant café"), 'CHARSET UTF-8 TEXT "croissant" TEXT {café}');
});

test("search: results are newest first, limited, with snippets, and nothing is marked read", async t => {
  const fake = await startFakeMail(t, { messages: inbox() });
  const a = imapAdapter({ now: () => NOW });
  const cfg = fake.config();

  const all = await a.search(cfg, pw(), { query: parseQuery(""), limit: 10 });
  assert.deepEqual(all.map(m => m.id), ["INBOX.1712.12", "INBOX.1712.9", "INBOX.1712.7", "INBOX.1712.3"]);
  assert.equal(all[1].from, DANA);
  assert.equal(all[1].to, "alex@harlow.example, orders@northwind-bakery.example");
  assert.equal(all[1].subject, "Rye question");
  assert.equal(all[1].snippet, "Do you still want the rye on Tuesday?");
  assert.ok(all[1]._at > all[2]._at);
  assert.equal(all[1]._at, Date.parse(day(1)));

  const two = await a.search(cfg, pw(), { query: parseQuery(""), limit: 2 });
  assert.deepEqual(two.map(m => m.id), ["INBOX.1712.12", "INBOX.1712.9"]);

  const ids = async q => (await a.search(cfg, pw(), { query: parseQuery(q), limit: 10 })).map(m => Number(m.id.split(".").pop()));
  assert.deepEqual(await ids("from:dana"), [9, 3]);
  assert.deepEqual(await ids("to:orders@northwind-bakery.example"), [9]);
  assert.deepEqual(await ids("subject:invoice"), [7]);
  assert.deepEqual(await ids("croissants"), [7]);
  assert.deepEqual(await ids("newer_than:7d"), [12, 9, 7]);
  assert.deepEqual(await ids("is:unread"), [9, 7]);
  assert.deepEqual(await ids("from:dana is:unread"), [9]);
  assert.deepEqual(await ids("from:nobody"), []);

  // Unread mail stays unread after all that.
  assert.deepEqual(await ids("is:unread"), [9, 7]);
  assert.deepEqual(fake.seenChanges, []);
  assert.ok(fake.commands.every(c => !/ SELECT /.test(c)));
  assert.ok(fake.commands.filter(c => / FETCH /.test(c)).every(c => /BODY\.PEEK\[HEADER\.FIELDS/.test(c) && !/ BODY\[/.test(c)));
});

test("search: a snippet from a multipart message skips the MIME scaffolding", async t => {
  const fake = await startFakeMail(t, { messages: [{ uid: 1, from: DANA, subject: "Menu", body: "Plain menu text here.", html: "<p>HTML menu</p>" }] });
  const [m] = await imapAdapter().search(fake.config(), pw(), { query: parseQuery(""), limit: 5 });
  assert.equal(m.snippet, "Plain menu text here.");
});

// ---------------------------------------------------------------- read

const RAW = {
  html: [
    "From: Dana Reyes <dana@northwind-bakery.example>", "To: alex@harlow.example", "Subject: Specials",
    "Date: Fri, 25 Sep 2026 09:00:00 +0000", "Message-ID: <specials@northwind-bakery.example>", "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="alt"', "", "--alt", "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64", "", Buffer.from("<html><body><p>Today: <b>rye</b> &amp; seeded</p><p>Second line</p></body></html>").toString("base64"),
    "--alt--", "",
  ].join("\r\n"),
  latin1: [
    "From: =?iso-8859-1?Q?Andr=E9_Dupont?= <orders@northwind-bakery.example>", "To: alex@harlow.example",
    `Subject: =?UTF-8?B?${Buffer.from("Croissants \u{1F950}").toString("base64")}?= =?UTF-8?Q?_for_Andr=C3=A9?=`, "Date: Thu, 24 Sep 2026 08:00:00 +0000",
    "Content-Type: text/plain; charset=iso-8859-1", "Content-Transfer-Encoding: quoted-printable", "",
    "Caf=E9 cr=E8me, =",
    "tr=E8s bien.", "",
  ].join("\r\n"),
  attach: [
    "From: Northwind Orders <orders@northwind-bakery.example>", "To: alex@harlow.example", "Cc: dana@northwind-bakery.example",
    "Subject: Invoice 1042", "Date: Wed, 23 Sep 2026 08:00:00 +0000", "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="mix"', "", "preamble", "--mix", 'Content-Type: multipart/alternative; boundary="alt"', "",
    "--alt", "Content-Type: text/plain; charset=utf-8", "", "Invoice attached.", "--alt", "Content-Type: text/html", "", "<p>Invoice attached (html).</p>", "--alt--",
    "--mix", 'Content-Type: application/pdf; name="invoice-1042.pdf"', 'Content-Disposition: attachment; filename="invoice-1042.pdf"',
    "Content-Transfer-Encoding: base64", "", Buffer.from("%PDF-1.4 fake").toString("base64"),
    "--mix", "Content-Type: text/csv", "Content-Disposition: attachment; filename*=utf-8''bestellung%20m%C3%A4rz.csv", "", "a,b",
    "--mix--", "",
  ].join("\r\n"),
};

test("read: a plain message, whole, and nothing marked read", async t => {
  const fake = await startFakeMail(t, { messages: inbox() });
  const m = await imapAdapter().read(fake.config(), pw(), { id: "INBOX.1712.9" });
  assert.equal(m.id, "INBOX.1712.9");
  assert.equal(m.from, DANA);
  assert.equal(m.subject, "Rye question");
  assert.equal(m.body, "Do you still want the rye on Tuesday?");
  assert.equal(m.message_id, "<9.fake@northwind-bakery.example>");
  assert.ok(m.date.includes("2026"));
  assert.equal(m.truncated, undefined);
  assert.equal(m.attachments, undefined);
  assert.deepEqual(fake.seenChanges, []);
  assert.ok(fake.commands.some(c => /UID FETCH 9 \(.*BODY\.PEEK\[\]/.test(c)));
});

test("read: multipart/alternative with only HTML becomes text", async t => {
  const fake = await startFakeMail(t, { messages: [{ uid: 1, raw: RAW.html }] });
  const m = await imapAdapter().read(fake.config(), pw(), { id: "INBOX.1712.1" });
  assert.equal(m.body, "Today: rye & seeded\nSecond line");
  assert.equal(m.message_id, "<specials@northwind-bakery.example>");
});

test("read: quoted-printable Latin-1 and RFC 2047 headers (B and Q)", async t => {
  const fake = await startFakeMail(t, { messages: [{ uid: 1, raw: RAW.latin1 }] });
  const m = await imapAdapter().read(fake.config(), pw(), { id: "INBOX.1712.1" });
  assert.equal(m.subject, "Croissants \u{1F950} for André");
  assert.equal(m.from, "André Dupont <orders@northwind-bakery.example>");
  assert.equal(m.body, "Café crème, très bien.\n");
});

test("read: attachments are named, the text part wins, cc comes through", async t => {
  const fake = await startFakeMail(t, { messages: [{ uid: 1, raw: RAW.attach }] });
  const m = await imapAdapter().read(fake.config(), pw(), { id: "INBOX.1712.1" });
  assert.equal(m.body, "Invoice attached.");
  assert.deepEqual(m.attachments, ["invoice-1042.pdf", "bestellung märz.csv"]);
  assert.equal(m.cc, "dana@northwind-bakery.example");
});

test("read: the body is capped at 20000 characters", async t => {
  const fake = await startFakeMail(t, { messages: [{ uid: 1, subject: "Long", body: "crumb ".repeat(5000) }] });
  const m = await imapAdapter().read(fake.config(), pw(), { id: "INBOX.1712.1" });
  assert.equal(m.body.length, 20000);
  assert.equal(m.truncated, true);
});

test("read: an id from an old UIDVALIDITY is stale, a bad id is bad_input, a gone one is not_found", async t => {
  const fake = await startFakeMail(t, { messages: inbox(), uidvalidity: 2000 });
  const a = imapAdapter();
  await assert.rejects(a.read(fake.config(), pw(), { id: "INBOX.1712.9" }), e => e.code === "stale");
  await assert.rejects(a.read(fake.config(), pw(), { id: "Sent.2000.9" }), e => e.code === "bad_input");
  await assert.rejects(a.read(fake.config(), pw(), { id: "INBOX.2000.99" }), e => e.code === "not_found");
  assert.ok(fake.commands.filter(c => /LOGOUT/.test(c)).length >= 2);
});

// ---------------------------------------------------------------- send

test("send: headers, Bcc only in RCPT TO, body intact", async t => {
  const fake = await startFakeMail(t);
  const a = imapAdapter({ now: () => NOW });
  const r = await a.send(fake.config(), pw(), {
    to: "dana@northwind-bakery.example", cc: ["orders@northwind-bakery.example"], bcc: "alex+archive@harlow.example",
    subject: "Friday order", body: "Two sourdough loaves.\n.\nThanks, Alex", in_reply_to: "<9.fake@northwind-bakery.example>",
  });
  assert.equal(r.sent, true);
  assert.match(r.message_id, /^<[0-9a-z.]+@harlow\.example>$/);
  assert.equal(fake.sent.length, 1);
  const s = fake.sent[0];
  assert.equal(s.from, "alex@harlow.example");
  assert.deepEqual(s.rcpt, ["dana@northwind-bakery.example", "orders@northwind-bakery.example", "alex+archive@harlow.example"]);
  const head = s.data.slice(0, s.data.indexOf("\r\n\r\n"));
  assert.match(head, /^From: alex@harlow\.example$/m);
  assert.match(head, /^To: dana@northwind-bakery\.example$/m);
  assert.match(head, /^Cc: orders@northwind-bakery\.example$/m);
  assert.match(head, /^Subject: Friday order$/m);
  assert.match(head, /^Date: Sun, 27 Sep 2026 12:00:00 \+0000$/m);
  assert.ok(head.includes(`Message-ID: ${r.message_id}`));
  assert.match(head, /^In-Reply-To: <9\.fake@northwind-bakery\.example>$/m);
  assert.ok(!/^bcc:/im.test(head));
  assert.ok(!head.includes("archive"));
  assert.equal(b64body(s.data), "Two sourdough loaves.\n.\nThanks, Alex");
});

test("smtpData: CRLF line ends, dot-stuffing, the final dot", () => {
  assert.equal(smtpData("a\n.hidden\r\n.\rb"), "a\r\n..hidden\r\n..\r\nb\r\n.\r\n");
  assert.equal(smtpData("one\r\n"), "one\r\n.\r\n");
});

test("send: AUTH LOGIN when PLAIN is not offered", async t => {
  const fake = await startFakeMail(t, { smtpAuth: ["LOGIN"] });
  await imapAdapter().send(fake.config(), pw(), { to: "dana@northwind-bakery.example", subject: "Hi", body: "Hello" });
  assert.deepEqual(fake.logins.map(l => [l.proto, l.mech, l.ok]), [["smtp", "LOGIN", true]]);
  assert.equal(fake.sent.length, 1);
});

test("send: a refused RCPT is code smtp and names the step; nothing is sent", async t => {
  const fake = await startFakeMail(t, { refuseRcpt: ["orders@northwind-bakery.example"] });
  await assert.rejects(
    imapAdapter().send(fake.config(), pw(), { to: ["dana@northwind-bakery.example", "orders@northwind-bakery.example"], subject: "Hi", body: "Hello" }),
    e => e.code === "smtp" && /RCPT TO orders@northwind-bakery\.example/.test(e.message) && /550/.test(e.message));
  assert.equal(fake.sent.length, 0);
});

test("send: bad content never connects; a wrong password is auth and scrubbed", async t => {
  const fake = await startFakeMail(t, { echo: true, smtpAuth: ["PLAIN"] });
  const a = imapAdapter();
  await assert.rejects(a.send(fake.config(), pw(), { to: "dana", subject: "x", body: "y" }), e => e.code === "bad_input");
  await assert.rejects(a.send(fake.config(), pw(), { to: "dana@northwind-bakery.example", subject: "a\r\nBcc: x@harlow.example", body: "y" }), e => e.code === "bad_input");
  assert.equal(fake.logins.length, 0);
  const wrong = "not-the-password-77";
  await assert.rejects(a.send(fake.config(), pw(wrong), { to: "dana@northwind-bakery.example", subject: "x", body: "y" }), e => {
    assert.equal(e.code, "auth");
    assert.ok(!e.message.includes(Buffer.from(`\0alex@harlow.example\0${wrong}`).toString("base64")), e.message);
    assert.ok(!e.message.includes(wrong));
    return true;
  });
  assert.equal(fake.mailFromCount, 0);
});

// ---------------------------------------------------------------- timeouts

test("a server that never answers times out", async t => {
  const fake = await startFakeMail(t, { silent: true });
  const a = imapAdapter({ timeout: 150 });
  const started = Date.now();
  await assert.rejects(a.search(fake.config(), pw(), { query: parseQuery(""), limit: 5 }), e => e.code === "timeout");
  await assert.rejects(a.send(fake.config(), pw(), { to: "dana@northwind-bakery.example", subject: "x", body: "y" }), e => e.code === "timeout");
  const r = await a.test(fake.config(), pw());
  assert.equal(r.code, "timeout");
  assert.ok(Date.now() - started < 3000);
});
