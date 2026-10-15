// @ts-check
// The guards of a standing permission, on a real vyred with the kernel on and a REAL mail connection (a fake IMAP and SMTP server behind it, test/helpers.js mailFixture): an agent's mail.send reaches the Gate
// through the mail module, the kernel's standingFor sees the agent's own chain, and
//  - the person the agent works for must hold use of the connection: a member's chat is held, the owner's approverless run goes out;
//  - another agent that merely names juno is not covered;
//  - a followed list does not count an address added by someone who does not hold the connection;
//  - an expiry ends it; a payment is held over its limit, over its day and in another currency.
// Only the outside servers are fakes.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { start } from "../daemon/index.js";
import { tempHome, present, mailFixture } from "../../test/helpers.js";
import { canonical } from "../../kernel/core/canonical.js";
import { allowLoopbackForTests } from "../../lib/http.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const stubPresence = () => { const used = new Set(); return { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_proof") }; };
const until = async (/** @type {() => any} */ f, /** @type {string} */ what, ms = 20_000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 50)); } };

async function world(/** @type {import("node:test").TestContext} */ t, /** @type {any} */ gateCfg = {}) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" }, gate: gateCfg }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: stubPresence() });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const dev = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  const tokenOf = async (/** @type {any} */ c) => ({ token: (await K.surfaces.open(c, {})).token });
  const as = async (/** @type {string} */ p, /** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", await tokenOf(dev(p)));
  const ok = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await as(OWNER, tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  const agentCall = async (/** @type {string} */ name, /** @type {string} */ person, /** @type {string} */ tool, /** @type {any} */ input) => {
    const uid = (await ok("agents.uid", { name })).uid;
    return d.registry.call(tool, input, `mcp:agent:${name}`, { token: (await K.surfaces.open(K.chains.fromFacts({ kind: "agent_session", agent: uid, session: `s-${name}-${person.slice(4, 8)}`, thread: `t-${name}-${person.slice(4, 8)}`, person, vouched: true }), {})).token, thread: "t-1", agent: name });
  };
  return { d, K, OWNER, dev, as, ok, agentCall };
}

test("a standing permission over a real mail connection: the owner's agent goes out, a member's chat and another agent are held, an expiry ends it, and a followed list ignores an address added by someone without the connection", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const { K, OWNER, ok, as, agentCall } = w;
  const mail = await mailFixture(t, (tool, input) => as(OWNER, tool, input));
  const via = `mail:${mail.id}`;
  await ok("agents.create", { name: "juno", kind: "agent" });
  await ok("agents.create", { name: "kit", kind: "agent" });
  await K.gateway.grants.setRole(w.dev(OWNER), { person: BEN, role: "member" }, { presence: { op: "stand-in", fields: {}, n: 1 } }).catch(() => {});
  const send = async (/** @type {string} */ agent, /** @type {string} */ person, /** @type {string} */ to) => {
    const r = await agentCall(agent, person, "mail.send", { account: mail.id, to, subject: "Re: intake", body: "Hi, the form is on staging." });
    assert.ok(!r.error, `${agent} as ${person.slice(4, 8)}: ${JSON.stringify(r.error)}`);
    const id = r.data.held || r.data.id;
    return (await ok("gate.get", { id })).state;
  };
  const made = await ok("gate.standing.add", { agent: "juno", kind: "send", via, to: { patterns: ["*@harlowlegal.com"] }, daily_cap: 20 });
  // the owner's agent (an approverless run: the person hop is the owner, who holds the connection)
  assert.equal(await send("juno", OWNER, "dana@harlowlegal.com"), "sent", "inside the scope, no question");
  await until(() => mail.mailbox.sent.length === 1, "the mail reached the mail server");
  // a member's chat with the same agent: she does not hold the connection, so the agent may not use it for her
  assert.equal(await send("juno", BEN, "dana@harlowlegal.com"), "held", "a member's chat is held when she could not use the connection herself");
  // another agent that merely names juno is not covered
  assert.equal(await send("kit", OWNER, "dana@harlowlegal.com"), "held", "another agent is not covered");
  assert.equal(mail.mailbox.sent.length, 1);

  // an expiry ends it
  await ok("gate.standing.revoke", { id: made.id });
  const soon = await ok("gate.standing.add", { agent: "juno", kind: "send", via, to: { patterns: ["*@harlowlegal.com"] }, daily_cap: 20, expires: Date.now() + 4000 });
  assert.ok(soon.id);
  assert.equal(await send("juno", OWNER, "dana@harlowlegal.com"), "sent", "before the expiry");
  await new Promise(r => setTimeout(r, 4500));
  assert.equal(await send("juno", OWNER, "dana@harlowlegal.com"), "held", "after the expiry it asks");

  // a followed list counts only what someone who holds the connection wrote
  await K.gateway.records.define(w.dev(OWNER), { add_types: [{ name: "contact", label: "Contact", fields: [{ name: "name", kind: "text", label: "Name" }, { name: "email", kind: "text", label: "Email" }, { name: "other_emails", kind: "emails", label: "Other emails" }] }] });
  const lee = await K.gateway.records.create(w.dev(OWNER), "contact", { name: "Lee", email: "lee@harlowlegal.com" });
  const follow = await ok("gate.standing.add", { agent: "juno", kind: "send", via, to: { lists: [`contact:${lee.id}`] }, follow_lists: true, daily_cap: 20 });
  assert.equal(await send("juno", OWNER, "lee@harlowlegal.com"), "sent");
  // Ben (a member, no use of the connection) adds an address: it does not count
  const v1 = (await K.gateway.records.get(w.dev(OWNER), "contact", lee.id)).version;
  await K.gateway.records.update(w.dev(BEN), "contact", lee.id, { other_emails: ["planted@harlowlegal.com"] }, v1).catch(() => {});
  assert.equal(await send("juno", OWNER, "planted@harlowlegal.com"), "held", "an address added by someone without the connection does not count");
  // the owner writes it: it counts
  const v2 = (await K.gateway.records.get(w.dev(OWNER), "contact", lee.id)).version;
  await K.gateway.records.update(w.dev(OWNER), "contact", lee.id, { other_emails: ["planted@harlowlegal.com"] }, v2);
  assert.equal(await send("juno", OWNER, "planted@harlowlegal.com"), "sent", "written by someone who holds it: it counts");
  await ok("gate.standing.revoke", { id: follow.id });
});

test("a payment is held over its limit for one payment, over its day, and in another currency; inside them it goes out", { timeout: 300_000 }, async t => {
  allowLoopbackForTests(true);
  t.after(() => allowLoopbackForTests(false));
  /** @type {any[]} */ const paid = [];
  const server = http.createServer((req, res) => { let b = ""; req.on("data", c => (b += c)); req.on("end", () => { paid.push(b); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); }); });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  const host = `127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  const w = await world(t, { senders: { pay: { type: "http", vault: "pay-token", hosts: [host] } } });
  const { OWNER, ok, agentCall } = w;
  await ok("vault.put", { name: "pay-token", kind: "api-key", fields: { value: `fixture-token-${crypto.randomBytes(6).toString("hex")}` } });
  await ok("vault.grant", { name: "pay-token", module: "gate" });
  await ok("agents.create", { name: "juno", kind: "agent" });
  await ok("gate.standing.add", { agent: "juno", kind: "spend", via: "pay", to: { patterns: ["billing@vendor.example"] }, max_amount: 50, daily_amount: 100, currency: "usd" });
  const pay = async (/** @type {number} */ amount, /** @type {string} */ currency = "USD", /** @type {string} */ payee = "billing@vendor.example") => {
    const r = await agentCall("juno", OWNER, "gate.request", { kind: "spend", via: "pay", to: payee, content: { method: "POST", url: `http://${host}/pay`, body: "x", payee, amount, currency } });
    assert.ok(!r.error, JSON.stringify(r.error));
    return r.data.state;
  };
  assert.equal(await pay(40), "sent", "inside the limits");
  assert.equal(await pay(60), "held", "over the limit for one payment");
  assert.equal(await pay(40, "EUR"), "held", "another currency");
  assert.equal(await pay(40, "USD", "other@vendor.example"), "held", "another payee");
  assert.equal(await pay(40), "sent", "the second one still fits the day");
  assert.equal(await pay(40), "held", "over the day");
  assert.equal(paid.length, 2, "only the two inside the limits went out");
});
