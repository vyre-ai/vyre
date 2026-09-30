// @ts-check
// Unit tests for accounts.js: the caller mail asks the vault about, where a held item is filed,
// which adapter serves a connection, IMAP settings, and which account a send goes from (ADR 0016
// decision 8). Pure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { callerFor, filingFor, adapterOf, imapConfig, pickFor, view } from "./accounts.js";

test("accounts: callerFor comes from what vyred verified", () => {
  assert.equal(callerFor("capsule", {}), "capsule");
  assert.equal(callerFor("mcp", { thread: "t-1" }), "mcp:thread:t-1");
  assert.equal(callerFor("mcp", {}), "mcp");
  assert.equal(callerFor("mcp"), "mcp");
  assert.equal(callerFor("mcp:agent:kit", {}), "mcp:agent:kit");
  assert.equal(callerFor("tailnet:agent:juno", {}), "tailnet:agent:juno");
  assert.equal(callerFor("mcp", { agent: "kit", thread: "t-k" }), "mcp:agent:kit", "the verified agent wins over the thread");
  assert.equal(callerFor("cli", {}), "cli");
  assert.equal(callerFor("local", {}), "local");
  // A model's or a person's on_behalf is never heard.
  assert.equal(callerFor("mcp", { thread: "t-1" }, { surface: "chat", thread: "t-9" }), "mcp:thread:t-1");
  assert.equal(callerFor("mcp:agent:kit", {}, { surface: "agent", agent: "juno" }), "mcp:agent:kit");
  assert.equal(callerFor("cli", {}, { surface: "capsule" }), "cli");
  assert.equal(callerFor("capsule", {}, { surface: "agent", agent: "kit" }), "capsule");
});

test("accounts: callerFor from a module names the surface it acts for", () => {
  const m = b => callerFor("module:mail", { firstParty: true }, b);
  assert.equal(m({ surface: "capsule" }), "capsule");
  assert.equal(m({ surface: "agent", agent: "kit" }), "mcp:agent:kit");
  assert.equal(m({ surface: "agent" }), "module:mail", "an agent surface with no agent is the module itself");
  assert.equal(m({ surface: "agent", agent: "" }), "module:mail");
  assert.equal(m({ surface: "chat", thread: "t-9" }), "mcp:thread:t-9");
  assert.equal(m({ surface: "chat" }), "mcp");
  assert.equal(m({ surface: "phone" }), "mobile");
  assert.equal(m({ surface: "elsewhere" }), "module:mail");
  assert.equal(m(undefined), "module:mail");
  assert.equal(m("capsule"), "module:mail");
  // A module that is not Vyre's own speaks for no one.
  assert.equal(callerFor("module:bakery-helper", {}, { surface: "capsule" }), "module:bakery-helper");
});

test("accounts: filingFor", () => {
  assert.deepEqual(filingFor("mcp", { thread: "t-1" }), { thread: "t-1" });
  assert.deepEqual(filingFor("mcp:agent:kit", {}), { agent: "kit" });
  assert.deepEqual(filingFor("mcp:agent:kit", { agent: "kit", thread: "t-kit" }), { thread: "t-kit", agent: "kit" });
  assert.deepEqual(filingFor("tailnet:agent:juno", {}), { agent: "juno" });
  assert.deepEqual(filingFor("module:mail", { firstParty: true }, { surface: "agent", agent: "kit", thread: "t-9" }), { thread: "t-9", agent: "kit" });
  assert.deepEqual(filingFor("module:mail", { firstParty: true }, { surface: "chat", thread: "t-9" }), { thread: "t-9" });
  assert.deepEqual(filingFor("module:bakery-helper", {}, { surface: "chat", thread: "t-9" }), {});
  // Only a module's on_behalf is heard.
  assert.deepEqual(filingFor("mcp", { thread: "t-1" }, { surface: "agent", agent: "kit", thread: "t-9" }), { thread: "t-1" });
  for (const c of ["capsule", "mcp", "cli", "mobile", "module:mail"]) assert.deepEqual(filingFor(c, {}), {}, c);
});

test("accounts: adapterOf", () => {
  assert.equal(adapterOf({ source: "google" }), "google");
  assert.equal(adapterOf({ source: "mcp", provider: "gmail" }), "mcp");
  assert.equal(adapterOf({ source: "vault", provider: "imap-smtp" }), "imap");
  assert.equal(adapterOf({ source: "vault", provider: "google-apps-script" }), "apps-script");
  assert.equal(adapterOf({ source: "vault", provider: "slack" }), null);
  assert.equal(adapterOf({ source: "vault" }), null);
  assert.equal(adapterOf({ source: "other", provider: "imap-smtp" }), null);
  assert.deepEqual(view({ id: "cn_1", source: "vault", provider: "imap-smtp", account: "alex@harlow.example" }),
    { account: "cn_1", adapter: "imap", address: "alex@harlow.example", label: "alex@harlow.example", provider: "imap-smtp", source: "vault" });
});

test("accounts: imapConfig maps security and ports", () => {
  assert.deepEqual(imapConfig("harlow-mail", { security: "starttls", imap_host: "imap.harlow.example", imap_port: "143", smtp_host: "smtp.harlow.example",
    smtp_port: "587", username: "alex", from: "alex@harlow.example" }, "cn_1"), {
    address: "alex@harlow.example", username: "alex",
    imap: { host: "imap.harlow.example", port: 143, tls: "starttls" }, smtp: { host: "smtp.harlow.example", port: 587, tls: "starttls" },
    auth: { item: "harlow-mail", field: "password" },
  });
  // Anything but starttls or none is implicit TLS; a missing or odd port is left to the default.
  const implicit = imapConfig("harlow-mail", { security: "ssl", imap_host: "imap.harlow.example", imap_port: "nine", smtp_host: "smtp.harlow.example" }, "alex@harlow.example");
  assert.deepEqual(implicit, { address: "alex@harlow.example", imap: { host: "imap.harlow.example", tls: "implicit" },
    smtp: { host: "smtp.harlow.example", tls: "implicit" }, auth: { item: "harlow-mail", field: "password" } });
  assert.equal(imapConfig("x", {}, "cn_1").imap.tls, "implicit");
  const none = imapConfig("x", { security: "none", imap_port: "993", smtp_port: "465", username: "dana@northwind-bakery.example", from: "not an address" }, "cn_2");
  assert.deepEqual([none.imap.tls, none.smtp.tls, none.imap.port, none.smtp.port, none.address], ["none", "none", 993, 465, "dana@northwind-bakery.example"]);
  // The password is never in the config, only where to fetch it.
  assert.ok(!("password" in imapConfig("x", { password: "p" }, "cn_1")));
  assert.ok(!JSON.stringify(imapConfig("x", { password: "fixture-pw" }, "cn_1")).includes("fixture-pw"));
});

test("accounts: pickFor", () => {
  const home = { id: "cn_home", account: "alex@harlow.example" }, work = { id: "cn_work", account: "alex@northwind-bakery.example" };
  assert.equal(pickFor([home, work], "cn_work"), work);
  assert.equal(pickFor([home]), home);
  assert.throws(() => pickFor([home, work], "cn_other"),
    e => e.code === "no_account" && /no mail account cn_other/.test(e.message) && /cn_home \(alex@harlow\.example\), cn_work/.test(e.message));
  assert.throws(() => pickFor([], "cn_other"), e => e.code === "no_account" && !/the accounts are/.test(e.message));
  assert.throws(() => pickFor([]), e => e.code === "no_account" && /Vault, Connections/.test(e.message));
  assert.throws(() => pickFor([home, work]), e => {
    assert.equal(e.code, "ambiguous");
    assert.match(e.message, /say which account/);
    assert.deepEqual(e.detail, { accounts: [{ account: "cn_home", address: "alex@harlow.example" }, { account: "cn_work", address: "alex@northwind-bakery.example" }] });
    return true;
  });
});
