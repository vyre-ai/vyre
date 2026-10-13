// @ts-check
// A record's Email: the From choices, the one send call each choice makes, the two address searches merged into one newest-first list, and the plain words for a held send.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromChoices, sendCall, threadQueries, mergeThreads, heldWords, checkDraft } from "./record-email.js";

const creds = [
  { id: "cn_1", name: "Harlow Resend", provider: "sending-service", account: "hello@harlow.example", step: "comms.email" },
  { id: "cn_2", name: "Alex mail", provider: "imap-smtp", account: "alex@harlow.example", step: "comms.send" },
];

test("From choices: one per credential, named with the address, the sending service first", () => {
  const c = fromChoices(creds);
  assert.deepEqual(c.map((x) => x.id), ["cn_1", "cn_2"]);
  assert.equal(c[0].label, "Harlow Resend (hello@harlow.example)");
  assert.deepEqual(fromChoices([]), []);
  assert.deepEqual(fromChoices([{ nope: 1 }, null]), []);
});

test("the sending service sends with comms.email, a mail login with mail.send naming its account", () => {
  const d = { to: "dana@northwind-bakery.example", subject: "Hi", body: "Hello" };
  assert.deepEqual(sendCall(creds[0], d), { tool: "comms.email", input: { to: ["dana@northwind-bakery.example"], subject: "Hi", text: "Hello" } });
  assert.deepEqual(sendCall(creds[1], d), { tool: "mail.send", input: { to: ["dana@northwind-bakery.example"], subject: "Hi", body: "Hello", account: "cn_2" } });
});

test("a draft needs an address, a subject and words; the words say which", () => {
  assert.equal(checkDraft({ to: "a@x.example", subject: "s", body: "b" }), null);
  assert.match(String(checkDraft({ to: "nope", subject: "s", body: "b" })), /address/);
  assert.match(String(checkDraft({ to: "a@x.example", subject: " ", body: "b" })), /subject/);
  assert.match(String(checkDraft({ to: "a@x.example", subject: "s", body: " " })), /write/i);
});

test("threads: searched by the address as sender and as recipient, merged, no repeats, newest first", () => {
  assert.deepEqual(threadQueries("Dana@Northwind-Bakery.example"), ["from:dana@northwind-bakery.example", "to:dana@northwind-bakery.example"]);
  const a = [{ id: "m1", account: "cn_2", from: "dana@x", subject: "One", date: "2026-10-01T10:00:00Z" }, { id: "m2", account: "cn_2", subject: "Two", date: "2026-10-03T10:00:00Z" }];
  const b = [{ id: "m1", account: "cn_2", subject: "One", date: "2026-10-01T10:00:00Z" }, { id: "m3", account: "cn_2", subject: "Three", date: "2026-10-02T10:00:00Z" }, { nope: 1 }];
  assert.deepEqual(mergeThreads([a, b]).map((m) => m.id), ["m2", "m3", "m1"]);
  assert.deepEqual(mergeThreads([]), []);
});

test("a held send is said plainly; nothing claims it went out", () => {
  assert.match(heldWords({ held: "gi_1" }), /waiting for your yes/i);
  assert.doesNotMatch(heldWords({ held: "gi_1" }), /\bsent\b(?! out)/i);
  assert.match(heldWords({}), /did not/i);
});
