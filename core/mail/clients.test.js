// @ts-check
// The SMTP and IMAP clients against the fakes in testing/fakes.js, on 127.0.0.1 only. Never a
// real server, never a real address.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import * as smtp from "./smtp.js";
import { Imap, searchCriteria, decodeWords, parse } from "./imap.js";
import { readMessage, stripHtml } from "./mime.js";
import { fakeSmtp, fakeImap, testCert, hasOpenssl } from "./testing/fakes.js";

const skip = !hasOpenssl && "openssl is needed to make a test certificate";
const ME = "alex@harlow.example";
// A quote in it makes IMAP LOGIN send it as a literal.
const PW = `pw-${crypto.randomBytes(8).toString("hex")}"x`;
const users = { [ME]: PW };
const acct = (port, security, extra = {}) => ({ host: "127.0.0.1", port, security, username: ME, password: PW, ca: testCert().cert, timeout: 5000, ...extra });

/** Unfold and split a message's headers. @param {string} raw */
const headersOf = raw => Object.fromEntries(raw.split("\r\n\r\n")[0].replace(/\r\n[ \t]+/g, " ").split("\r\n").map(l => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
/** Quoted-printable back to text. @param {string} s */
const unQp = s => Buffer.from(s.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");

test("smtp: STARTTLS then AUTH PLAIN, and a correct RFC 5322 message", { skip }, async t => {
  const fake = await fakeSmtp(t, { mode: "starttls", users });
  const msg = smtp.buildMessage({ from: ME, to: ["dana@harlow.example"], cc: ["juno@northwind.example"], subject: "Café menu for Northwind Bakery",
    body: "Hi Dana,\nthe menu is attached.\nAlex", in_reply_to: "<letter1@harlow.example>", references: "<letter0@harlow.example>", date: new Date(Date.UTC(2026, 8, 27, 10)) });
  const out = await smtp.send(acct(fake.port, "starttls"), { from: ME, to: ["dana@harlow.example", "juno@northwind.example"], raw: msg.raw });
  assert.deepEqual(out.accepted, ["dana@harlow.example", "juno@northwind.example"]);
  assert.equal(fake.messages.length, 1);
  const got = fake.messages[0];
  assert.equal(got.secure, true);
  assert.deepEqual(got.to, ["dana@harlow.example", "juno@northwind.example"]);
  assert.deepEqual(fake.authed, [{ user: ME, mech: "PLAIN" }]);
  // STARTTLS came before any AUTH, and the client said hello again after it.
  const c = fake.transcript.filter(l => l.startsWith("C: ")).map(l => l.slice(3).split(" ")[0]);
  assert.deepEqual(c.slice(0, 4), ["EHLO", "STARTTLS", "EHLO", "AUTH"]);
  assert.equal(c.at(-1), "QUIT");
  const h = headersOf(got.data);
  assert.equal(h.From, ME);
  assert.equal(h.To, "dana@harlow.example");
  assert.equal(h.Cc, "juno@northwind.example");
  assert.match(h.Subject, /^=\?UTF-8\?B\?/);
  assert.equal(decodeWords(h.Subject.replace(/\?=\s+=\?/g, "?==?")), "Café menu for Northwind Bakery");
  assert.equal(h.Date, "Sun, 27 Sep 2026 10:00:00 +0000");
  assert.match(h["Message-ID"], /^<[0-9a-f]{24}@harlow\.example>$/);
  assert.equal(h["MIME-Version"], "1.0");
  assert.equal(h["Content-Type"], "text/plain; charset=utf-8");
  assert.equal(h["Content-Transfer-Encoding"], "quoted-printable");
  assert.equal(h["In-Reply-To"], "<letter1@harlow.example>");
  assert.equal(h.References, "<letter0@harlow.example> <letter1@harlow.example>");
  assert.equal(unQp(got.data.split("\r\n\r\n").slice(1).join("\r\n\r\n")).replace(/\r\n/g, "\n"), "Hi Dana,\nthe menu is attached.\nAlex", "the final CRLF is the one before the dot");
});

test("smtp: implicit TLS with AUTH LOGIN", { skip }, async t => {
  const fake = await fakeSmtp(t, { mode: "tls", users, mechs: ["LOGIN"] });
  const { raw } = smtp.buildMessage({ from: ME, to: ["kit@harlow.example"], subject: "Tasting", body: "Thursday at ten." });
  await smtp.send(acct(fake.port, "tls"), { from: ME, to: ["kit@harlow.example"], raw });
  assert.deepEqual(fake.authed, [{ user: ME, mech: "LOGIN" }]);
  assert.equal(fake.messages[0].secure, true);
  assert.ok(!fake.transcript.some(l => /STARTTLS/.test(l)));
  assert.deepEqual(await smtp.probe(acct(fake.port, "tls")), { ok: true });
});

test("smtp: a refused login says so and never carries the password", { skip }, async t => {
  const fake = await fakeSmtp(t, { mode: "starttls", users: { [ME]: "something-else" } });
  const { raw } = smtp.buildMessage({ from: ME, to: ["kit@harlow.example"], subject: "s", body: "b" });
  const err = await smtp.send(acct(fake.port, "starttls"), { from: ME, to: ["kit@harlow.example"], raw }).then(() => null, e => e);
  assert.ok(err);
  assert.equal(err.code, "auth");
  assert.match(err.message, /refused the login for alex@harlow\.example: 535/);
  for (const s of [PW, Buffer.from(PW).toString("base64"), Buffer.from(`\0${ME}\0${PW}`).toString("base64")]) assert.ok(!String(err.message + err.stack).includes(s));
  assert.equal(fake.messages.length, 0);
});

test("smtp: STARTTLS that is not offered refuses rather than logging in in the clear", async t => {
  const server = net.createServer(s => {
    s.write("220 plain.harlow.example ESMTP\r\n");
    s.on("data", d => { if (/^EHLO/i.test(String(d))) s.write("250-plain.harlow.example\r\n250 AUTH PLAIN\r\n"); });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  const port = /** @type {any} */ (server.address()).port;
  const err = await smtp.probe({ host: "127.0.0.1", port, security: "starttls", username: ME, password: PW, timeout: 2000 }).then(() => null, e => e);
  assert.equal(err?.code, "tls");
  assert.match(err.message, /does not offer STARTTLS/);
});

test("smtp: a silent server times out with a clear error", async t => {
  const server = net.createServer(() => {});
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => { server.close(() => r(undefined)); }));
  const port = /** @type {any} */ (server.address()).port;
  const err = await smtp.probe({ host: "127.0.0.1", port, security: "starttls", username: ME, password: PW, timeout: 300 }).then(() => null, e => e);
  assert.equal(err?.code, "timeout");
  assert.match(err.message, /SMTP server did not answer/);
});

test("smtp: dot-stuffing doubles a leading dot and the server gets the text back", { skip }, async t => {
  assert.equal(smtp.dotStuff("a\n.b\n..c\n."), "a\r\n..b\r\n...c\r\n..\r\n");
  assert.equal(smtp.dotStuff(".start"), "..start\r\n");
  const fake = await fakeSmtp(t, { mode: "tls", users });
  const { raw } = smtp.buildMessage({ from: ME, to: ["kit@harlow.example"], subject: "Dots", body: "one\n.hidden line\n.\ntwo" });
  await smtp.send(acct(fake.port, "tls"), { from: ME, to: ["kit@harlow.example"], raw });
  const m = fake.messages[0];
  assert.match(m.wire, /\r\n\.\.hidden line\r\n\.\.\r\ntwo/);
  assert.match(m.data, /\r\n\.hidden line\r\n\.\r\ntwo/);
  assert.equal(unQp(m.data.split("\r\n\r\n")[1]).replace(/\r\n/g, "\n"), "one\n.hidden line\n.\ntwo");
});

test("smtp: a line break in any header is refused, and long or non-ASCII text is encoded", () => {
  const base = { from: ME, to: ["kit@harlow.example"], subject: "s", body: "b" };
  for (const bad of [{ subject: "Hi\r\nBcc: juno@northwind.example" }, { subject: "Hi\nX: y" }, { to: ["kit@harlow.example\r\nBcc: juno@northwind.example"] },
    { cc: ["juno@northwind.example\n"] }, { from: `${ME}\r\nX: y` }, { in_reply_to: "<a@b.example>\r\nBcc: x@harlow.example" }]) {
    assert.throws(() => smtp.buildMessage({ ...base, ...bad }), /line break|not an email/, JSON.stringify(bad));
  }
  assert.throws(() => smtp.buildMessage({ ...base, to: ["not an address"] }), /not an email address/);
  assert.throws(() => smtp.buildMessage({ ...base, to: [] }), /at least one recipient/);
  const long = "Ω".repeat(80);
  const enc = smtp.encodeWord(long);
  for (const line of enc.split("\r\n")) assert.ok(line.length <= 76, line);
  assert.equal(decodeWords(enc.replace(/\?=\r\n =\?/g, "?==?")), long);
  const qp = smtp.quotedPrintable("x".repeat(200) + " end \nçà=");
  for (const line of qp.split("\r\n")) assert.ok(line.length <= 76, line);
  assert.equal(unQp(qp).replace(/\r\n/g, "\n"), "x".repeat(200) + " end \nçà=");
});

test("imap: the search mapping", () => {
  const lit = v => ({ literal: Buffer.from(v) });
  assert.deepEqual(searchCriteria(""), { criteria: ["ALL"], utf8: false });
  assert.deepEqual(searchCriteria("from:dana subject:\"engagement letter\" since:2026-09-01 unseen menu"),
    { criteria: ["FROM", "\"dana\"", "SUBJECT", "\"engagement letter\"", "SINCE", "1-Sep-2026", "UNSEEN", "TEXT", "\"menu\""], utf8: false });
  assert.deepEqual(searchCriteria("café \"two words\""), { criteria: ["TEXT", lit("café"), "TEXT", "\"two words\""], utf8: true });
  assert.deepEqual(searchCriteria("label:work"), { criteria: ["TEXT", "\"label:work\""], utf8: false });
  assert.throws(() => searchCriteria("since:yesterday"), /date such as 2026-09-01/);
});

test("imap: parse reads literals, quoted strings, NIL and sections", () => {
  const v = parse(["* 3 FETCH (UID 15 FLAGS (\\Seen) ENVELOPE (\"d\" {5}", Buffer.from("a \"b\""), " NIL) BODY[HEADER.FIELDS (SUBJECT)] \"x\\\"y\")"]);
  assert.equal(v[0], "*");
  const list = /** @type {any[]} */ (v[3]);
  assert.deepEqual(list.slice(0, 3), ["UID", "15", "FLAGS"]);
  assert.deepEqual(list[3], ["\\Seen"]);
  assert.equal(String(list[5][1]), "a \"b\"");
  assert.equal(list[5][2], null);
  assert.equal(list[6], "BODY[HEADER.FIELDS (SUBJECT)]");
  assert.equal(list[7], "x\"y");
});

test("imap: TLS, LOGIN with a literal password, EXAMINE, search, envelopes and a read", { skip }, async t => {
  const fake = await fakeImap(t, { mode: "tls", users });
  const c = await Imap.open(acct(fake.port, "tls"));
  assert.deepEqual(fake.logins, [{ user: ME, how: "LOGIN" }]);
  assert.deepEqual(await c.examine("INBOX"), { exists: 3, uidvalidity: "7" });
  assert.deepEqual(await c.search("from:dana"), [11]);
  assert.deepEqual(await c.search("unseen"), [12, 15]);
  assert.deepEqual(await c.search("since:2026-09-20 from:kit"), [15]);
  assert.deepEqual(await c.search("menu"), [15]);
  assert.deepEqual(await c.search(""), [11, 12, 15]);
  const rows = await c.envelopes([11, 12, 15]);
  assert.deepEqual(rows.map(r => r.uid), [15, 12, 11]);
  assert.equal(rows[0].envelope.subject, "Quote \"test\" and more", "the subject came as a literal");
  assert.deepEqual(rows[0].envelope.cc, ["juno@northwind.example"]);
  assert.equal(rows[1].envelope.subject, "Order “sourdough” ready");
  assert.deepEqual(rows[2].envelope.from, ["Dana Harlow <dana@harlow.example>"]);
  assert.equal(rows[2].envelope.message_id, "<letter1@harlow.example>");
  assert.deepEqual(rows[2].flags, ["\\Seen"]);
  const raw = await c.body(11);
  assert.ok(raw);
  assert.match(readMessage(raw).body, /Café at ten\?/);
  await c.logout();
  assert.ok(fake.commands.includes("EXAMINE \"INBOX\""));
  assert.ok(!fake.commands.some(x => /^SELECT|STORE/.test(x)), "never opened read-write");
  assert.ok(fake.commands.includes("UID FETCH 11 (UID BODY.PEEK[])"));
  assert.ok(fake.commands.some(x => x.startsWith("UID SEARCH SINCE 20-Sep-2026 FROM")));
});

test("imap: STARTTLS and AUTHENTICATE PLAIN, and a refused login", { skip }, async t => {
  const fake = await fakeImap(t, { mode: "starttls", users, authPlain: true });
  const c = await Imap.open(acct(fake.port, "starttls"));
  assert.deepEqual(fake.logins, [{ user: ME, how: "AUTHENTICATE PLAIN" }]);
  await c.logout();
  assert.deepEqual(fake.commands.slice(0, 3), ["CAPABILITY", "STARTTLS", "CAPABILITY"]);
  const bad = await fakeImap(t, { mode: "tls", users: { [ME]: "other" } });
  const err = await Imap.open(acct(bad.port, "tls")).then(() => null, e => e);
  assert.equal(err?.code, "auth");
  assert.match(err.message, /refused the login for alex@harlow\.example: \[AUTHENTICATIONFAILED\]/);
  assert.ok(!String(err.message + err.stack).includes(PW));
});

test("mime: plain text, html only, nested multipart with an attachment", async () => {
  const { sampleMailbox } = await import("./testing/fakes.js");
  const [a, b, c] = sampleMailbox();
  const one = readMessage(a.raw);
  assert.equal(one.from, "Dana Harlow <dana@harlow.example>");
  assert.equal(one.subject, "Engagement letter");
  assert.equal(one.message_id, "<letter1@harlow.example>");
  assert.equal(one.body, "Hi Alex,\n\nThe engagement letter is attached. Café at ten?\n\nDana\n");
  assert.equal(one.format, "text");
  const two = readMessage(b.raw);
  assert.equal(two.subject, "Order “sourdough” ready");
  assert.equal(two.format, "html");
  assert.equal(two.body, "Your order is ready.\nPick up & enjoy");
  assert.equal(two.references, "<order6@northwind.example>");
  const three = readMessage(c.raw);
  assert.equal(three.body, "Menu draft for Northwind Bakery.\n");
  assert.deepEqual(three.attachments, ["menu.pdf"]);
  assert.equal(three.cc, "juno@northwind.example");
  assert.equal(stripHtml("<style>p{}</style><p>a&nbsp;&#233;&#x41;</p><br>b"), "a éA\n\nb");
});
