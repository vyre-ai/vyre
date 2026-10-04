// @ts-check
// Unit tests for capsule.js: what the Capsule's words mean for mail, and the row ids that carry
// them (ADR 0016 decision 8). Pure.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, composeId, parseComposeId, messageId, parseMessageId } from "./capsule.js";

test("capsule: words that mean a message to write", () => {
  assert.deepEqual(parse("send an email"), { kind: "compose" });
  assert.deepEqual(parse("  Send a message  "), { kind: "compose" });
  assert.deepEqual(parse("email dana@northwind-bakery.example about the order"),
    { kind: "compose", to: "dana@northwind-bakery.example", subject: "The order" });
  assert.deepEqual(parse("write to dana saying the rota is ready"), { kind: "compose", name: "dana", body: "the rota is ready" });
  assert.deepEqual(parse("send an email to dana@northwind-bakery.example"), { kind: "compose", to: "dana@northwind-bakery.example" });
  assert.deepEqual(parse("email Dana Reyes about the tasting saying Thursday works"),
    { kind: "compose", name: "Dana Reyes", subject: "The tasting", body: "Thursday works" });
  // Words that are neither an address nor a plain name fill nothing.
  assert.deepEqual(parse("email the whole Northwind Bakery team"), { kind: "compose" });
});

test("capsule: words that mean a search", () => {
  assert.deepEqual(parse("email from dana"), { kind: "search", q: "from:dana" });
  assert.deepEqual(parse("mail about invoices"), { kind: "search", q: "invoices" });
  assert.deepEqual(parse("emails from Dana Reyes"), { kind: "search", q: "from:\"Dana Reyes\"" });
  assert.deepEqual(parse("messages to alex@harlow.example"), { kind: "search", q: "to:alex@harlow.example" });
});

test("capsule: words that are not mail's", () => {
  for (const q of ["what's next", "", "northwind", "next meeting", "emailing is hard"]) assert.deepEqual(parse(q), { kind: "none" }, q);
  assert.deepEqual(parse(/** @type {any} */ (undefined)), { kind: "none" });
});

test("capsule: compose ids round-trip what the words said, and bad ids are null", () => {
  const fill = { to: "dana@northwind-bakery.example", subject: "The order", body: "Is Thursday fine?", name: "", extra: "dropped" };
  const id = composeId("cn_AbC-12_x", fill);
  assert.match(id, /^compose:cn_AbC-12_x:[A-Za-z0-9_-]+$/);
  assert.deepEqual(parseComposeId(id), { account: "cn_AbC-12_x", fill: { to: "dana@northwind-bakery.example", subject: "The order", body: "Is Thursday fine?" } });
  assert.deepEqual(parseComposeId(composeId("cn_AbC-12_x", {})), { account: "cn_AbC-12_x", fill: {} });

  const payload = id.split(":")[2];
  for (const bad of [
    "", "compose:", `compose:cn bad:${payload}`, `compose:${"a".repeat(65)}:${payload}`, `compose:cn_AbC-12_x:${payload}=`,
    `compose:cn_AbC-12_x:${Buffer.from("not json").toString("base64url")}`, `msg:cn_AbC-12_x:${payload}`, "compose:cn_AbC-12_x",
  ]) assert.equal(parseComposeId(bad), null, bad);
  assert.equal(parseComposeId(/** @type {any} */ (null)), null);
  // A field of the wrong type is left out, never trusted.
  const odd = `compose:cn_1:${Buffer.from(JSON.stringify({ to: 42, subject: "ok" })).toString("base64url")}`;
  assert.deepEqual(parseComposeId(odd), { account: "cn_1", fill: { subject: "ok" } });
});

test("capsule: message ids round-trip", () => {
  const id = messageId("cn_AbC-12_x", "<m1@mail.example>");
  assert.deepEqual(parseMessageId(id), { account: "cn_AbC-12_x", id: "<m1@mail.example>" });
  assert.equal(parseMessageId("msg:cn_1:"), null);
  assert.equal(parseMessageId("compose:cn_1:abc"), null);
});
