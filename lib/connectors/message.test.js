// @ts-check
// Unit tests for message.js, the pure email parts every mail path shares (ADR 0016 decisions 6
// and 8): the search language, the RFC 822 text, content checks and From headers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery, rfc822Text, checkContent, addressOf, nameOf, addresses, header } from "./message.js";

const empty = { words: [], from: [], to: [], subject: [], unread: false };

test("message: parseQuery reads each operator and quoted phrases", () => {
  assert.deepEqual(parseQuery(""), empty);
  assert.deepEqual(parseQuery(/** @type {any} */ (undefined)), empty);
  assert.deepEqual(parseQuery("invoice"), { ...empty, words: ["invoice"] });
  assert.deepEqual(parseQuery("from:dana"), { ...empty, from: ["dana"] });
  assert.deepEqual(parseQuery("FROM:Dana"), { ...empty, from: ["Dana"] });
  assert.deepEqual(parseQuery("to:alex@harlow.example"), { ...empty, to: ["alex@harlow.example"] });
  assert.deepEqual(parseQuery("subject:\"oven rota\""), { ...empty, subject: ["oven rota"] });
  assert.deepEqual(parseQuery("newer_than:7d"), { ...empty, days: 7 });
  assert.deepEqual(parseQuery("newer_than:14D"), { ...empty, days: 14 });
  assert.deepEqual(parseQuery("is:unread"), { ...empty, unread: true });
  assert.deepEqual(parseQuery("\"Northwind Bakery\""), { ...empty, words: ["Northwind Bakery"] });

  assert.deepEqual(parseQuery("from:dana to:alex@harlow.example subject:\"oven rota\" newer_than:7d is:unread \"Northwind Bakery\" order label:work"), {
    words: ["Northwind Bakery", "order", "label:work"], from: ["dana"], to: ["alex@harlow.example"], subject: ["oven rota"], days: 7, unread: true,
  });
  assert.deepEqual(parseQuery("from:dana from:\"Dana Reyes\""), { ...empty, from: ["dana", "Dana Reyes"] });

  // An operator it does not know, or a value it cannot use, is a plain word; an empty one is dropped.
  assert.deepEqual(parseQuery("newer_than:week is:read"), { ...empty, words: ["newer_than:week", "is:read"] });
  assert.deepEqual(parseQuery("from:\"\" \"\" subject:\"  \""), empty);
});

test("message: rfc822Text headers, RFC 2047 subject, Date and Message-ID", () => {
  const text = rfc822Text({
    from: "Alex <alex@harlow.example>", to: ["dana@northwind-bakery.example", "kit@harlow.example"], cc: ["juno@harlow.example"], bcc: ["alex@harlow.example"],
    subject: "Rota für Montag", body: "Hi Dana, the rota is ready.", in_reply_to: "<m1@mail.example>", references: "<m0@mail.example>",
    date: new Date(Date.UTC(2026, 8, 27, 9, 30, 0)), message_id: "<abc123@harlow.example>",
  });
  assert.ok(!/(^|[^\r])\n/.test(text), "a bare LF");
  const lines = text.split("\r\n");
  const blank = lines.indexOf("");
  assert.deepEqual(lines.slice(0, blank).filter(l => !l.startsWith("Date: ")), [
    "From: Alex <alex@harlow.example>",
    "To: dana@northwind-bakery.example, kit@harlow.example",
    "Cc: juno@harlow.example",
    "Bcc: alex@harlow.example",
    `Subject: =?UTF-8?B?${Buffer.from("Rota für Montag", "utf8").toString("base64")}?=`,
    "Message-ID: <abc123@harlow.example>",
    "In-Reply-To: <m1@mail.example>",
    "References: <m0@mail.example> <m1@mail.example>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ]);
  assert.match(lines.find(l => l.startsWith("Date: ")) || "", /^Date: [A-Z][a-z]{2}, 27 Sep 2026 09:30:00 \+0000$/);
  assert.equal(Buffer.from(lines.slice(blank + 1).join(""), "base64").toString("utf8"), "Hi Dana, the rota is ready.");

  // The least: no From, no Cc, an ASCII subject as is, no Date or Message-ID, an empty body.
  const bare = rfc822Text({ to: ["dana@northwind-bakery.example"], subject: "Oven rota", body: "" }).split("\r\n");
  assert.deepEqual(bare.slice(0, 2), ["To: dana@northwind-bakery.example", "Subject: Oven rota"]);
  assert.ok(!bare.some(l => /^(From|Cc|Bcc|Date|Message-ID|In-Reply-To|References):/.test(l)));
  assert.equal(bare.at(-1), "");

  // A long body wraps at 76, and a References with a break is dropped, not copied.
  const long = rfc822Text({ to: ["dana@northwind-bakery.example"], subject: "s", body: "z".repeat(1000), in_reply_to: "<m1@mail.example>", references: "<m0@mail.example>\r\nBcc: x@evil.example" });
  const ll = long.split("\r\n");
  assert.ok(ll.slice(ll.indexOf("") + 1).every(l => l.length <= 76));
  assert.ok(ll.includes("References: <m1@mail.example>"));
  assert.ok(!long.includes("evil.example"));
});

test("message: rfc822Text allows no line break in a header", () => {
  const base = { to: ["dana@northwind-bakery.example"], subject: "s", body: "b" };
  assert.throws(() => rfc822Text({ ...base, subject: "Oven rota\r\nBcc: x@evil.example" }), e => e.code === "bad_input" && /subject cannot contain a line break/.test(e.message));
  assert.throws(() => rfc822Text({ ...base, subject: "a\nb" }), /subject/);
  assert.throws(() => rfc822Text({ ...base, from: "alex@harlow.example\nBcc: x@evil.example" }), /from cannot contain a line break/);
  assert.throws(() => rfc822Text({ ...base, message_id: "<a@b.example>\r\nX: y" }), /message_id cannot contain a line break/);
  assert.throws(() => rfc822Text({ ...base, in_reply_to: "<a@b.example>\nX: y" }), /in_reply_to cannot contain a line break/);
  // A non-ASCII subject is one encoded word, so a line break inside it could not survive anyway.
  assert.equal(header("Café"), `=?UTF-8?B?${Buffer.from("Café").toString("base64")}?=`);
  assert.equal(header("Plain"), "Plain");
});

test("message: checkContent", () => {
  const ok = { subject: "Oven rota", body: "The rota is ready." };
  const to = ["dana@northwind-bakery.example"];
  assert.equal(checkContent(to, ok), undefined);
  assert.equal(checkContent(to, { ...ok, cc: "kit@harlow.example, juno@harlow.example", in_reply_to: "" }), undefined);
  assert.equal(checkContent(to, { ...ok, in_reply_to: "<m1@mail.example>" }), undefined);
  const refused = (t, c, re) => assert.throws(() => checkContent(t, c), e => e.code === "bad_input" && re.test(e.message), String(re));
  refused([], ok, /at least one address in to/);
  refused(["dana"], ok, /to must be email addresses; "dana" is not one/);
  refused(to, { ...ok, cc: "kit@harlow.example, not-an-address" }, /cc must be email addresses/);
  refused(to, { ...ok, bcc: ["Dana <dana@northwind-bakery.example>"] }, /bcc must be email addresses/);
  refused(to, { body: "b" }, /needs a subject/);
  refused(to, { subject: "s" }, /needs a body/);
  refused(to, { ...ok, subject: "Oven rota\nBcc: x@evil.example" }, /line break/);
  refused(to, { ...ok, in_reply_to: "m1@mail.example" }, /Message-ID/);
  refused(to, { ...ok, in_reply_to: "<m1@mail.example> <m2@mail.example>" }, /Message-ID/);
  assert.deepEqual(addresses("a@harlow.example, b@harlow.example ,", "to"), ["a@harlow.example", "b@harlow.example"]);
  assert.deepEqual(addresses(undefined, "to"), []);
});

test("message: addressOf and nameOf", () => {
  assert.equal(addressOf("Dana Reyes <dana@northwind-bakery.example>"), "dana@northwind-bakery.example");
  assert.equal(addressOf("\"Reyes, Dana\" <dana@northwind-bakery.example>"), "dana@northwind-bakery.example");
  assert.equal(addressOf("  dana@northwind-bakery.example "), "dana@northwind-bakery.example");
  assert.equal(addressOf("Dana Reyes"), "");
  assert.equal(addressOf(""), "");
  assert.equal(addressOf(/** @type {any} */ (undefined)), "");
  assert.equal(nameOf("Dana Reyes <dana@northwind-bakery.example>"), "Dana Reyes");
  assert.equal(nameOf("\"Harlow Legal\" <alex@harlow.example>"), "Harlow Legal");
  assert.equal(nameOf("<alex@harlow.example>"), "alex@harlow.example");
  assert.equal(nameOf("alex@harlow.example"), "alex@harlow.example");
  assert.equal(nameOf("Harlow Legal"), "Harlow Legal");
  assert.equal(nameOf(""), "");
});
