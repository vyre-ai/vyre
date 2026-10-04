// @ts-check
// Standing permissions and the asked-for match, tightened (reviewer-2 M1, lead rulings L1 L2 M2), inside a real vyred with the real vault and a fake
// Gmail: cc and bcc must be covered too, a plain ask is used up by its send, an intent that names
// agents covers only them, the person adds, lists and revokes standing permissions, and the
// assistant lists and revokes only when the person's words asked. Was: what the person's own words asked for goes out at once with no card and no proof, and
// anything else holds exactly as before. A recipient the person did not name, another thread, a
// revoked intent and a sender that fails all fall back to held. Every name is a sample.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;

/** A fake Gmail send endpoint that records what it was sent and can be told to fail. */
async function fakeGmail(t) {
  const got = [];
  const state = { fail: false };
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", d => (body += d));
    req.on("end", () => {
      got.push({ url: req.url, auth: req.headers.authorization, body });
      res.writeHead(state.fail ? 500 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(state.fail ? { error: "down" } : { id: "msg-1", threadId: "th-1" }));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  return { got, state, base: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}` };
}

const MAIL = i => ({ kind: "send", via: "mail", to: "dana@harlowlegal.com", content: { subject: "Intake form", body: "Hi Dana, the form link is ready. Alex" }, ...i });

async function world(t) {
  const root = tempHome(t);
  const gmail = await fakeGmail(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" },
    gate: { senders: { mail: { type: "gmail", vault: "work-mail-token", from: "alex@example.com", base: gmail.base } } } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const cli = (tool, input = {}) => call(tool, input, { root, caller: "cli" });
  const reg = (tool, input, caller, meta = {}) => d.registry.call(tool, input, caller, meta);
  const agent = (name, thread, tool, input) => reg(tool, input, `mcp:agent:${name}`, { thread, agent: name });
  assert.ok((await cli("vault.put", { name: "work-mail-token", kind: "api-key", fields: { value: fake("token") } })).data);
  assert.equal((await cli("vault.grant", { name: "work-mail-token", module: "gate" })).data.grant.status, "active");
  const said = (o, caller = "module:sessions") => reg("vault.said.record", { thread: "t-1", said: "said-1", kind: "send", to: ["dana@harlowlegal.com"], what: "email Dana", ...o }, caller);
  return { root, gmail, cli, reg, agent, said };
}

test("gate: an asked-for email must cover every real destination, cc and bcc included (M1)", async t => {
  const { gmail, agent, said } = await world(t);
  await said({});
  const withBcc = await agent("juno", "t-1", "gate.request", MAIL({ thread: "t-1", content: { subject: "s", body: "b", bcc: ["mallory@elsewhere.test"] } }));
  assert.equal(withBcc.data.state, "held", "a bcc the person never named holds");
  const withCc = await agent("juno", "t-1", "gate.request", MAIL({ thread: "t-1", content: { subject: "s", body: "b", cc: ["mallory@elsewhere.test"] } }));
  assert.equal(withCc.data.state, "held");
  assert.equal(gmail.got.length, 0);
  // Named in full, a cc rides too.
  await said({ said: "said-2", to: ["dana@harlowlegal.com", "sam@harlowlegal.com"] });
  const ok = await agent("juno", "t-1", "gate.request", MAIL({ thread: "t-1", content: { subject: "s", body: "b", cc: ["sam@harlowlegal.com"] } }));
  assert.equal(ok.data.state, "sent", JSON.stringify(ok));
});

test("gate: a plain ask is used up by the send it asked for; a standing permission is not (L1)", async t => {
  const { gmail, agent, said } = await world(t);
  await said({});
  assert.equal((await agent("juno", "t-1", "gate.request", MAIL({ thread: "t-1" }))).data.state, "sent");
  assert.equal((await agent("juno", "t-1", "gate.request", MAIL({ thread: "t-1" }))).data.state, "held", "the second one waits");
  assert.equal(gmail.got.length, 1);
  await said({ said: "said-2", to: ["sam@harlowlegal.com"], standing: true }, "module:assistant");
  for (let i = 0; i < 2; i++) assert.equal((await agent("juno", "t-2", "gate.request", MAIL({ to: "sam@harlowlegal.com" }))).data.state, "sent");
  assert.equal(gmail.got.length, 3);
});

test("gate: an intent that names agents covers only them; naming none covers any (agents field)", async t => {
  const { agent, said } = await world(t);
  await said({ kind: "post", to: ["dana@harlowlegal.com"], standing: true, agents: ["kit"] }, "module:assistant");
  assert.equal((await agent("juno", "t-1", "gate.request", MAIL({ kind: "send", thread: "t-1" }))).data.state, "held", "juno is not kit");
  assert.equal((await agent("kit", "t-1", "gate.request", MAIL({ kind: "send", thread: "t-1" }))).data.state, "sent");
  await said({ said: "said-2", to: ["sam@harlowlegal.com"], standing: true }, "module:assistant");
  assert.equal((await agent("juno", "t-1", "gate.request", MAIL({ to: "sam@harlowlegal.com" }))).data.state, "sent", "no agents named: any of them");
});

test("gate: an http or module sender cannot name its destinations, so nothing covers it (M1)", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" },
    gate: { senders: { hook: { type: "http", vault: "k", hosts: ["https://hooks.example.test"] } } } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  await d.registry.call("vault.said.record", { thread: "t-1", said: "s", kind: "send", to: ["hooks.example.test"], what: "post to the hook", standing: true }, "module:assistant");
  const r = await d.registry.call("gate.request", { kind: "send", via: "hook", to: "hooks.example.test", content: { method: "POST", url: "https://hooks.example.test/x", body: "x" }, thread: "t-1" }, "mcp:agent:juno", { thread: "t-1", agent: "juno" });
  assert.equal(r.data.state, "held", JSON.stringify(r));
});

test("gate: the person adds, lists and revokes standing permissions; no model or module adds one", async t => {
  const { gmail, cli, reg, agent } = await world(t);
  for (const caller of ["mcp", "mcp:agent:juno", "module:assistant", "module:sessions", "tailnet-guest:x@y.test", "hook"]) {
    assert.ok((await reg("gate.said.add", { kind: "post", to: ["#deploys"] }, caller)).error, `${caller} cannot add`);
  }
  for (const caller of ["mcp", "module:sessions", "module:assistant", "cli", "local", "deck", "capsule"]) {
    assert.ok((await reg("vault.said.add", { surface: "deck", kind: "post", to: ["#deploys"] }, caller)).error, `${caller} cannot reach the internal add`);
  }
  const added = await cli("gate.said.add", { kind: "send", to: ["sam@harlowlegal.com"], agents: ["kit"], what: "kit may email Sam" });
  assert.match(added.data.id, /^s_/, JSON.stringify(added));
  assert.ok((await cli("gate.said.add", { kind: "pay", to: ["acct_1"], limits: { max_amount: 50 } })).error, "a pay one needs a currency");
  const list = (await cli("gate.said.list")).data.intents;
  assert.deepEqual(list.map(x => [x.kind, x.standing, x.agents, x.said]), [["send", true, ["kit"], "person:cli"]]);
  assert.equal((await agent("kit", "t-3", "gate.request", MAIL({ to: "sam@harlowlegal.com" }))).data.state, "sent");
  assert.equal((await agent("juno", "t-3", "gate.request", MAIL({ to: "sam@harlowlegal.com" }))).data.state, "held");
  assert.equal((await cli("gate.said.revoke", { id: added.data.id })).data.id, added.data.id);
  assert.equal((await agent("kit", "t-3", "gate.request", MAIL({ to: "sam@harlowlegal.com" }))).data.state, "held");
  assert.equal(gmail.got.length, 1);
});

test("gate: the assistant lists, and revokes only when the person's own words asked for it", async t => {
  const { cli, reg, said } = await world(t);
  const { id } = (await said({ to: ["#deploys"], kind: "post", standing: true, agents: ["kit"] }, "module:assistant")).data;
  assert.equal((await reg("gate.said.list", {}, "module:assistant")).data.intents.length, 1, "the assistant may list");
  assert.ok((await reg("gate.said.list", {}, "module:watchers")).error);
  // No words yet: refused, and the permission stands.
  assert.ok((await reg("gate.said.revoke", { id, thread: "t-1" }, "module:assistant")).error);
  assert.ok((await reg("gate.said.revoke", { id }, "module:assistant")).error, "no thread named");
  assert.ok((await reg("gate.said.revoke", { id, thread: "t-1" }, "module:sessions")).error, "only the assistant, of the modules");
  assert.equal((await cli("gate.said.list")).data.intents.length, 1);
  // The person says "stop letting kit post there": an intent of kind revoke naming this id.
  await said({ said: "said-9", kind: "revoke", to: [id], what: "stop letting kit post there" }, "module:assistant");
  // Another thread's words do not count.
  assert.ok((await reg("gate.said.revoke", { id, thread: "t-7" }, "module:assistant")).error);
  const r = await reg("gate.said.revoke", { id, thread: "t-1" }, "module:assistant");
  assert.equal(r.data.id, id, JSON.stringify(r));
  assert.deepEqual((await cli("gate.said.list")).data.intents.filter(x => x.kind === "post"), []);
  // The words are used up: they cannot revoke a second permission the person later adds.
  const other = (await said({ said: "said-10", to: ["#deploys"], kind: "post", standing: true }, "module:assistant")).data.id;
  assert.ok((await reg("gate.said.revoke", { id: other, thread: "t-1" }, "module:assistant")).error);
});

test("gate: a person's own confirmation (asked {surface, hash, at}) clears a send for 60 s; a mismatch, a stale one and a model's always hold (D2)", async t => {
  const { gmail, reg, agent } = await world(t);
  const { inputHash } = await import("../presence/index.js");
  const req = MAIL({ to: "dana@harlowlegal.com" });
  const hash = inputHash({ kind: req.kind, via: req.via, to: [req.to], content: req.content });
  const ask = (caller, asked, over = {}) => reg("gate.request", { ...req, ...over, asked }, caller);
  assert.equal((await ask("capsule", { surface: "capsule", hash, at: Date.now() })).data.state, "sent");
  assert.equal(gmail.got.length, 1);
  assert.equal((await ask("capsule", { surface: "capsule", hash: "x" + hash, at: Date.now() })).data.state, "held", "a hash mismatch holds");
  assert.equal((await ask("capsule", { surface: "capsule", hash, at: Date.now() - 61_000 })).data.state, "held", "stale");
  assert.equal((await ask("deck", { surface: "capsule", hash, at: Date.now() })).data.state, "held", "the surface must be the caller");
  assert.equal((await ask("capsule", { surface: "capsule", hash, at: Date.now() }, { content: { subject: "changed", body: "b" } })).data.state, "held", "edited after the person saw it");
  assert.equal((await agent("juno", "t-1", "gate.request", { ...req, asked: { surface: "capsule", hash, at: Date.now() } })).data.state, "held", "a model cannot claim it");
  assert.equal(gmail.got.length, 1);
});
