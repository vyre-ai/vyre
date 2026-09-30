// @ts-check
// Presence declarations (ADR 0006, section 3): every tool that hands out, writes, moves or
// unlocks a value declares `presence` with a summary that names items and destinations and
// never a value. The module is started against a recording ctx, so the declarations are read
// straight off what index.js registers; a tool that loses its declaration fails here.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { recorded } from "./testing.js";
import { encodeTicket, encodeCard } from "./relay.js";
import { newIdentity } from "./crypto.js";

export const NEEDS_PRESENCE = [
  "vault.put", "vault.delete", "vault.import", "vault.import.preview", "vault.grant", "vault.approve", "vault.inject", "vault.totp",
  "vault.backup", "vault.restore", "vault.pass.create", "vault.pass.accept", "vault.offboard", "vault.unlock",
  "vault.unlock-passphrase", "vault.device.code", "vault.device.unlock", "vault.account.create", "vault.account.unlock", "vault.account.enroll-touchid", "vault.revert", "vault.migrate-key",
  "vault.resolve", "vault.render", "vault.edit", "vault.git", "vault.ssh.add", "vault.ssh.approve",
  "vault.session.open", "vault.reveal", "vault.copy", "vault.fill.native", "vault.breach.check", "vault.update",
  "vault.members.invite", "vault.members.accept", "vault.members.role", "vault.members.remove", "vault.vaults.rotate", "vault.move",
  "vault.device.approve", "vault.agent.grant", "vault.codes", "vault.codes.import", "vault.sweep", "vault.rotate",
  "vault.emergency.add", "vault.emergency.refresh", "vault.emergency.request", "vault.emergency.status",
  "vault.connect", "vault.connections.grant", "vault.connections.update",
];
/** Taking access away, reading names and asking for pending things never needs a person. */
const NO_PRESENCE = ["vault.list", "vault.revoke", "vault.pending", "vault.audit", "vault.lock", "vault.identity",
  "vault.pass.list", "vault.pass.revoke", "vault.grants.status", "vault.devices", "vault.device.revoke", "vault.account.lock", "vault.account.status", "vault.history",
  "vault.people", "vault.fingerprint", "vault.vaults.create", "vault.vaults.list", "vault.vaults.sync",
  "vault.device.join", "vault.device.list", "vault.device.sync",
  "vault.item", "vault.ssh.keys", "vault.ssh.generate", "vault.ssh.approvals", "vault.ssh.forget",
  "vault.session.close", "vault.session.status", "vault.caps", "vault.health", "vault.clipboard.clear", "vault.search",
  "vault.agent.grants", "vault.agent.revoke", "vault.uses", "vault.remind.run", "vault.rotation",
  "vault.emergency.deny", "vault.emergency.remove", "vault.emergency.list", "vault.need",
  "vault.connections.list", "vault.connections.get", "vault.connections.revoke", "vault.connections.sync",
  "vault.connections.register", "vault.connections.unregister", "vault.connections.allowed"];

test("presence: every value-out or access-giving tool declares it, with a summary", async t => {
  const { tools } = await recorded(t);
  for (const n of NEEDS_PRESENCE) {
    assert.ok(tools.has(n), `${n} is registered`);
    const p = tools.get(n).presence;
    assert.ok(p, `${n} declares presence`);
    assert.equal(typeof p.summary, "function", `${n} has a summary`);
  }
  for (const n of NO_PRESENCE) assert.ok(!tools.get(n)?.presence, `${n} needs no person`);
  // vault.release is internal (modules only) and exempt; everything else registered is listed above.
  const known = new Set([...NEEDS_PRESENCE, ...NO_PRESENCE, "vault.release", "vault.generate", "vault.match", "vault.relay",
    // P17 and vault-routed API access: internal tools other modules call, and a request the Gate holds when nothing the person said covers it.
    "vault.said.record", "vault.said.add", "vault.env.scan", "vault.items.names", "vault.mention.search", "vault.mention.resolve", "vault.use.check", "vault.use.note", "vault.said.match", "vault.said.list", "vault.said.revoke", "vault.request", "vault.api.send",
    // Connectors stores a finished sign-in in an oauth api-credential: internal (only module:connectors, and only from the token endpoint the person's own config names), it takes tokens in and gives nothing out, and it runs right after the sign-in the person just did, so it asks for no presence.
    "vault.credential.tokens"]);
  for (const n of tools.keys()) assert.ok(known.has(n) || tools.get(n).presence, `${n} is new: decide whether it needs presence`);
});

test("presence: summaries name items and destinations and never a value, and never throw", async t => {
  const { tools, run } = await recorded(t);
  const canary = `fixture-canary-${crypto.randomBytes(12).toString("hex")}`;
  const sum = (n, input) => tools.get(n).presence.summary(input);

  assert.equal(await sum("vault.put", { name: "billing-key", kind: "api-key", value: canary }), `Add a key "billing-key" to your vault`);
  await run("vault.put", { name: "billing-key", kind: "api-key", value: canary });
  assert.equal(await sum("vault.put", { name: "billing-key", value: canary }), `Replace the key "billing-key" in your vault`);
  assert.match(await sum("vault.inject", { items: [{ name: "billing-key", env: "BILLING_KEY" }] }), /"billing-key" as BILLING_KEY into a program's environment/);
  assert.match(await sum("vault.backup", { file: "/tmp/acme.vyre", passphrase: canary }), /Write a sealed backup of 1 items to \/tmp\/acme.vyre/);
  assert.match(await sum("vault.grant", { name: "billing-key", module: "mail" }), /Let mail use "billing-key"/);
  assert.match(await sum("vault.pass.create", { holder: "Dana", items: ["billing-key"], expires: "2026-10-01" }), /Share "billing-key" with Dana, relayed, until 2026-10-01/);
  assert.match(await sum("vault.totp", { name: "billing-key" }), /one-time code for "billing-key"/);
  assert.match(await sum("vault.device.code", { name: "laptop chrome" }), /Pair a new browser \(laptop chrome\)/);
  assert.match(await sum("vault.device.unlock", { device: "d_none" }), /Unlock autofill in a paired browser/);
  const alex = newIdentity(), dana = newIdentity();
  const ownerCard = encodeCard({ name: "alex", sign: alex.sign.public, box: alex.box.public, relay: "https://relay.acme.test" }, alex.sign.private);
  const ticket = encodeTicket({ pass: "p_x", owner: "alex", relay: "https://relay.acme.test", ownerSign: alex.sign.public, ownerCard,
    holder: "dana", holderSign: dana.sign.public, items: ["stripe-key"], mode: "relayed", expires: null }, alex.sign.private);
  assert.match(await sum("vault.pass.accept", { ticket }), /Accept a relayed pass from alex holding "stripe-key"/);
  // A malformed input falls back to the generic words rather than printing the input.
  assert.equal(await sum("vault.pass.accept", { ticket: canary }), "Accept a pass someone sent");
  for (const n of NEEDS_PRESENCE) {
    const s = await sum(n, { name: "billing-key", value: canary, passphrase: canary, fields: { value: canary }, ticket: canary, items: [{ name: "billing-key" }] });
    assert.equal(typeof s, "string");
    assert.ok(s.length > 0 && !s.includes(canary), `${n}: ${s}`);
  }
});

test("generate from mcp only creates a new name", async t => {
  const { run } = await recorded(t);
  await run("vault.put", { name: "site-login", kind: "login", fields: { username: "alex@example.com", password: "fixture-old" } });
  await assert.rejects(async () => run("vault.generate", { name: "site-login" }, "mcp"), /may only generate into a new name/);
  assert.equal((await run("vault.generate", { name: "fresh-secret" }, "mcp")).stored, "fresh-secret");
  // A person still rotates a login's password with it.
  assert.equal((await run("vault.generate", { name: "site-login" }, "cli")).stored, "site-login");
});

test("account tools: create returns the Secret Key once, unlock and lock, and nothing leaks", async t => {
  const { run, tools, db, events } = await recorded(t);
  const pw = `fixture-pw-${crypto.randomBytes(12).toString("hex")}`;
  const value = `fixture-mail-${crypto.randomBytes(12).toString("hex")}`;
  await run("vault.put", { name: "mail-login", kind: "login", fields: { username: "alex@example.com", password: value } });
  assert.throws(() => { throw new Error(String(tools.get("vault.account.create").callers)); }, /cli,local/);
  const made = await run("vault.account.create", { password: pw });
  assert.match(made.secretKey, /^V2-/);
  assert.equal(made.moved, 1);
  assert.equal((await run("vault.list", {})).items[0].vault, "personal");
  assert.deepEqual(await run("vault.account.lock", {}, "mcp"), { locked: true });
  await assert.rejects(run("vault.inject", { items: [{ name: "mail-login" }] }), /locked/);
  await assert.rejects(run("vault.account.unlock", { password: "fixture-wrong-password" }), /does not open/);
  assert.equal((await run("vault.account.unlock", { password: pw })).unlocked, true);
  const seen = JSON.stringify([db.prepare("SELECT * FROM vault_audit").all(), events, await run("vault.list", {})]);
  for (const s of [pw, value, made.secretKey]) assert.ok(!seen.includes(s));
});

test("presence: reveal, copy and totp take the floor's session proof, except for a reprompt item", async t => {
  const { tools, run } = await recorded(t);
  await run("vault.put", { name: "site-login", kind: "login", fields: { username: "alex@example.com", password: "fixture-pw" } });
  await run("vault.put", { name: "team-card", kind: "card", fields: { number: "4242424242424242" } });
  for (const n of ["vault.reveal", "vault.copy", "vault.totp"]) {
    const s = tools.get(n).presence.session;
    assert.equal(typeof s, "function", `${n} declares session`);
    assert.equal(s({ name: "site-login" }), true, `${n}: a login rides a session`);
    assert.equal(s({ id: "site-login" }), true, `${n}: the Capsule's id works too`);
    assert.equal(s({ name: "team-card" }), false, `${n}: a card is reprompt`);
    assert.equal(s({}), false);
  }
  for (const n of ["vault.inject", "vault.fill.native", "vault.resolve"]) assert.ok(!tools.get(n).presence.session, `${n} never rides a session`);
});

test("presence: unlocking the vault with its password asks once; Touch ID, or no password at all, still asks for presence", async t => {
  const { tools } = await recorded(t);
  const { Presence } = await import("../presence/index.js");
  const def = tools.get("vault.account.unlock");
  const needs = input => Presence.prototype.required.call({}, "vault.account.unlock", def, input);
  assert.equal(needs({ password: "fixture-password-000000" }), false, "the vault password is the proof");
  assert.equal(needs({ method: "password", password: "fixture-password-000000" }), false);
  assert.equal(needs({ method: "touchid" }), true, "Touch ID keeps its presence proof");
  assert.equal(needs({ method: "touchid", password: "fixture-password-000000" }), true);
  assert.equal(needs({}), true, "no password, no shortcut");
  assert.equal(needs(undefined), true, "a listing of tools counts as asking");
});
