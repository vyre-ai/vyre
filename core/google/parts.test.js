// @ts-check
// The google module's small parts, without a vyred: what the Capsule's words mean, how a message
// is built, how HTML becomes text, and which accounts a call goes to.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, parseRowId, rowId } from "./find.js";
import { rfc822, htmlToText, bodyOf, addresses, checkMessage, addressOf, nameOf } from "./mail.js";
import { check, forRead, forWrite } from "./accounts.js";
import { when, defaultEnd, fieldsOf } from "./calendar.js";

test("google.find: phrases", () => {
  for (const q of ["what's next", "whats next?", "next", "next meeting", "What is next", "upcoming"]) assert.deepEqual(parse(q), { kind: "next" }, q);
  assert.deepEqual(parse("today"), { kind: "day", offset: 0 });
  assert.deepEqual(parse("meetings today"), { kind: "day", offset: 0 });
  assert.deepEqual(parse("what's on tomorrow"), { kind: "day", offset: 1 });
  assert.deepEqual(parse("tomorrow"), { kind: "day", offset: 1 });
  assert.deepEqual(parse("email from dana"), { kind: "mail", q: "from:dana" });
  assert.deepEqual(parse("mail from dana"), { kind: "mail", q: "from:dana" });
  assert.deepEqual(parse("from dana"), { kind: "mail", q: "from:dana" });
  assert.deepEqual(parse("emails from Dana Reyes"), { kind: "mail", q: "from:\"dana reyes\"" });
  assert.deepEqual(parse("email about invoice"), { kind: "mail", q: "invoice" });
  assert.deepEqual(parse("unread"), { kind: "mail", q: "is:unread" });
  assert.deepEqual(parse("Northwind tasting"), { kind: "both", q: "Northwind tasting" });
});

test("google.find: row ids carry account, kind and id", () => {
  assert.equal(rowId("work", "event", "ev1"), "google:work:event:ev1");
  assert.deepEqual(parseRowId("google:work:mail:m1"), { account: "work", kind: "mail", id: "m1" });
  assert.deepEqual(parseRowId("work:event:abc_123"), { account: "work", kind: "event", id: "abc_123" });
  assert.equal(parseRowId("google:work:file:x"), null);
  assert.equal(parseRowId("google:work:mail:../x"), null);
});

test("mail: the RFC 822 builder encodes headers and refuses line breaks", () => {
  const raw = rfc822({ from: "alex@example.com", to: ["dana@harlowlegal.com"], cc: ["kit@northwindbakery.com"], subject: "Café menu", body: "Hello\nthere",
    in_reply_to: "<m1@mail.example.com>", references: "<m0@mail.example.com>" });
  const text = Buffer.from(raw, "base64url").toString("utf8");
  assert.match(text, /^From: alex@example.com\r\nTo: dana@harlowlegal.com\r\nCc: kit@northwindbakery.com\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(text, /In-Reply-To: <m1@mail.example.com>\r\nReferences: <m0@mail.example.com> <m1@mail.example.com>\r\n/);
  assert.equal(Buffer.from(text.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8"), "Hello\nthere");
  assert.throws(() => rfc822({ to: ["a@example.com"], subject: "x\nBcc: y@example.com", body: "" }), /line break/);
  assert.throws(() => checkMessage(["a@example.com"], { subject: "ok", body: "b", in_reply_to: "<x>\r\nBcc: y@example.com" }), /Message-ID/);
  assert.throws(() => checkMessage([], { subject: "s", body: "b" }), /at least one/);
  assert.throws(() => addresses("dana@harlowlegal.com, not an address", "to"), /not one/);
  assert.deepEqual(addresses("dana@harlowlegal.com, kit@northwindbakery.com", "to"), ["dana@harlowlegal.com", "kit@northwindbakery.com"]);
  assert.equal(addressOf("Dana Reyes <dana@harlowlegal.com>"), "dana@harlowlegal.com");
  assert.equal(nameOf("\"Dana Reyes\" <dana@harlowlegal.com>"), "Dana Reyes");
  assert.equal(nameOf("dana@harlowlegal.com"), "dana@harlowlegal.com");
});

test("mail: HTML-only bodies become text, attachments are named, not read", () => {
  assert.equal(htmlToText("<style>p{}</style><p>Hi&nbsp;Alex,</p><p>Tarts &amp; bread<br>&#8364;5</p><ul><li>one</li></ul>"), "Hi Alex,\nTarts & bread\n€5\n- one");
  const enc = s => Buffer.from(s).toString("base64url");
  const payload = { mimeType: "multipart/mixed", parts: [
    { mimeType: "text/html", body: { data: enc("<div>Your <b>order</b> is ready.</div>") } },
    { mimeType: "application/pdf", filename: "invoice.pdf", body: { attachmentId: "a1" } },
  ] };
  assert.deepEqual(bodyOf(payload), { text: "Your order is ready.", files: ["invoice.pdf"] });
});

test("accounts: names, auth, loopback-only base, and which account a call goes to", () => {
  const ok = { name: "work", email: "alex@example.com", auth: { type: "service-account", item: "work-google" } };
  assert.equal(check(ok), null);
  assert.match(String(check({ ...ok, name: "Work" })), /lowercase/);
  assert.match(String(check({ ...ok, auth: { type: "bearer", item: "x" } })), /oauth or service-account/);
  assert.match(String(check({ ...ok, auth: { type: "oauth", item: "x", subject: "a@example.com" } })), /service account/);
  assert.equal(check({ ...ok, base: "http://127.0.0.1:9999" }), null);
  assert.match(String(check({ ...ok, base: "https://googleapis.example.org" })), /loopback/);
  const all = [{ name: "work" }, { name: "home" }];
  assert.equal(forRead(all).length, 2);
  assert.deepEqual(forRead(all, "home"), [{ name: "home" }]);
  assert.throws(() => forWrite(all), /say which account/);
  assert.deepEqual(forWrite([{ name: "work" }]), { name: "work" });
  assert.throws(() => forRead([]), /no Google account/);
});

test("calendar: times, all-day dates and default ends", () => {
  assert.deepEqual(when("2026-10-01"), { date: "2026-10-01" });
  assert.deepEqual(when("2026-10-01T09:00:00-07:00", "America/Los_Angeles"), { dateTime: "2026-10-01T09:00:00-07:00", timeZone: "America/Los_Angeles" });
  assert.throws(() => when("next tuesday"), /not a time/);
  assert.deepEqual(defaultEnd({ date: "2026-10-01" }), { date: "2026-10-02" });
  assert.deepEqual(defaultEnd({ dateTime: "2026-10-01T09:00:00Z" }), { dateTime: "2026-10-01T10:00:00.000Z" });
  assert.throws(() => fieldsOf({ start: "2026-10-01" }, { create: true }), /title/);
  assert.deepEqual(fieldsOf({ where: "Zoom" }, { create: false }), { location: "Zoom" });
});
