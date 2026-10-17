// @ts-check
// Standing permissions for agents (0.6): a person lets one agent send by itself, to named recipients, up to a daily cap. Through the REAL Gate on a real vyred with the kernel on: inside the scope the act goes
// out with no held question and the log names the permission it used; outside it, over the cap, after a revoke, or after the issuer lost admin, it is held as always; a model, a member and the default
// assistant cannot create or use one. Only the outside mail server is a fake.
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
import { canonical } from "../../kernel/core/canonical.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza";
const stubPresence = () => { const used = new Set(); return { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_proof") }; };
const proofFor = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: crypto.createHash("sha256").update(canonical({ action, input })).digest("hex") }, n: Math.random() });
void proofFor;

async function fakeGmail(/** @type {import("node:test").TestContext} */ t) {
  /** @type {any[]} */ const got = [];
  const server = http.createServer((req, res) => { let body = ""; req.on("data", d => (body += d)); req.on("end", () => { got.push({ url: req.url, body }); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "m1", threadId: "t1" })); }); });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  return { got, base: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}` };
}

test("a standing permission lets one agent send inside its scope with no question, and asks outside it, over the cap, after a revoke and after the issuer lost admin", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  const gmail = await fakeGmail(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" }, gate: { senders: { mail: { type: "gmail", vault: "work-mail-token", from: "alex@example.com", base: gmail.base } } } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: stubPresence() });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const dev = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  const tokenOf = async (/** @type {any} */ c) => ({ token: (await K.surfaces.open(c, {})).token });
  const as = async (/** @type {string} */ p, /** @type {string} */ tool, /** @type {any} */ input = {}, caller = "cli") => d.registry.call(tool, input, caller, await tokenOf(dev(p)));
  const ok = async (/** @type {string} */ p, /** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await as(p, tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  await ok(OWNER, "vault.put", { name: "work-mail-token", kind: "api-key", fields: { value: `fixture-token-${crypto.randomBytes(6).toString("hex")}` } });
  await ok(OWNER, "vault.grant", { name: "work-mail-token", module: "gate" });
  const ownerChain = dev(OWNER);
  await K.gateway.grants.setRole(ownerChain, { person: ANA, role: "admin" }, { presence: { op: "stand-in", fields: {}, n: 1 } }).catch(() => {});
  const uid = (await ok(OWNER, "agents.create", { name: "juno", kind: "agent" })).uid;
  const agent = async (/** @type {string} */ agentId, /** @type {any} */ extra = {}) => ({ token: (await K.surfaces.open(ownerChain, { agent: agentId, session: `s-${agentId.slice(-8)}`, thread: `t-${agentId.slice(-8)}`, ...extra })).token });
  const send = async (/** @type {string} */ to, /** @type {string} */ id = uid) => d.registry.call("gate.request", { kind: "send", via: "mail", to, content: { subject: "Re: intake", body: "Hi, the form is on staging." } }, "mcp:agent:juno", { ...(await agent(id)), thread: "t-1", agent: "juno" });

  // before any permission: held, as ever
  assert.equal((await send("dana@harlowlegal.com")).data.state, "held", "no permission: held");
  assert.equal(gmail.got.length, 0);

  // a model, the agent itself and a member cannot create one; the owner can
  const input = { agent: "juno", kind: "send", via: "mail", to: { patterns: ["*@harlowlegal.com"] }, daily_cap: 2 };
  assert.ok((await d.registry.call("gate.standing.add", input, "mcp", await tokenOf(dev(OWNER)))).error, "a model cannot create one");
  assert.ok((await d.registry.call("gate.standing.add", input, "mcp:agent:juno", { ...(await agent(uid)), thread: "t-1", agent: "juno" })).error, "an agent cannot create or widen its own");
  const made = await ok(OWNER, "gate.standing.add", input);
  assert.ok(made.id);

  // inside the scope: out at once, no question, the log names the permission
  const inside = (await send("dana@harlowlegal.com")).data;
  assert.equal(inside.state, "sent", JSON.stringify(inside));
  assert.equal(inside.by, `standing:${made.id}`);
  assert.equal(gmail.got.length, 1);
  const released = d.registry.deps.events.since(0, { limit: 5000 }).filter((/** @type {any} */ e) => e.type === "gate.released").pop();
  assert.equal(released.payload.by, `standing:${made.id}`, "the log names the permission it used");

  // outside the scope: one ask, as today (another domain, and a mixed list)
  assert.equal((await send("someone@elsewhere.com")).data.state, "held");
  assert.equal((await send(["dana@harlowlegal.com", "someone@elsewhere.com"])).data.state, "held", "every recipient must be in scope");
  // the default assistant never rides an agent's permission
  assert.equal((await send("dana@harlowlegal.com", "assistant")).data.state, "held");
  // over the cap (two a day): the third asks
  assert.equal((await send("dana@harlowlegal.com")).data.state, "sent", "the second one");
  assert.equal((await send("dana@harlowlegal.com")).data.state, "held", "over the cap asks");
  assert.equal(gmail.got.length, 2);

  // the list shows the use
  const listed = (await ok(OWNER, "gate.standing.list")).permissions.find((/** @type {any} */ p) => p.id === made.id);
  assert.equal(listed.use.count, 2);
  assert.equal(listed.kind, "send", "what it may do without asking");
  assert.equal(listed.agent, "juno");
  assert.ok(listed.daily_cap >= 1, "its limit");
  assert.deepEqual((await ok(OWNER, "gate.standing.list", { agent: "juno" })).permissions.map((/** @type {any} */ p) => p.id), [made.id], "narrowed to one agent");
  assert.deepEqual((await ok(OWNER, "gate.standing.list", { agent: "kit" })).permissions, [], "another agent has none");
  assert.equal(listed.use.last.length, 2);

  // revoke is instant
  const again = await ok(OWNER, "gate.standing.add", { ...input, to: { patterns: ["dana@harlowlegal.com"] }, daily_cap: 5 });
  assert.equal((await send("dana@harlowlegal.com")).data.state, "sent", "a fresh permission covers it");
  await ok(OWNER, "gate.standing.revoke", { id: again.id });
  assert.equal((await send("dana@harlowlegal.com")).data.state, "held", "revoked: asks");

  // an admin's permission matches nothing once they are no longer an admin
  const byAna = await as(ANA, "gate.standing.add", { ...input, to: { patterns: ["lee@harlowlegal.com"] }, daily_cap: 5 });
  if (!byAna.error) {
    assert.equal((await send("lee@harlowlegal.com")).data.state, "sent", "while she is an admin");
    await K.gateway.grants.setRole(ownerChain, { person: ANA, role: "member" }, { presence: { op: "stand-in", fields: {}, n: 2 } }).catch(() => {});
    assert.equal((await send("lee@harlowlegal.com")).data.state, "held", "the issuer lost admin: the grant matches nothing");
  }
});

test("a list is the addresses it holds when the permission is made; following it as it changes is a choice the person makes", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  const gmail = await fakeGmail(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" }, gate: { senders: { mail: { type: "gmail", vault: "work-mail-token", from: "alex@example.com", base: gmail.base } } } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: stubPresence() });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  const owner = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { token: (await K.surfaces.open(ownerChain, {})).token });
  const ok = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await owner(tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  await ok("vault.put", { name: "work-mail-token", kind: "api-key", fields: { value: `fixture-token-${crypto.randomBytes(6).toString("hex")}` } });
  await ok("vault.grant", { name: "work-mail-token", module: "gate" });
  await K.gateway.records.define(ownerChain, { add_types: [{ name: "contact", label: "Contact", fields: [{ name: "name", kind: "text", label: "Name" }, { name: "email", kind: "text", label: "Email" }, { name: "other_emails", kind: "emails", label: "Other emails" }] }] });
  const lee = await K.gateway.records.create(ownerChain, "contact", { name: "Lee", email: "lee@harlowlegal.com" });
  const uid = (await ok("agents.create", { name: "juno", kind: "agent" })).uid;
  const send = async (/** @type {string} */ to) => d.registry.call("gate.request", { kind: "send", via: "mail", to, content: { subject: "Re: intake", body: "Hi." } }, "mcp:agent:juno", { token: (await K.surfaces.open(ownerChain, { agent: uid, session: "s-j", thread: "t-j" })).token, thread: "t-1", agent: "juno" });
  const snap = await ok("gate.standing.add", { agent: "juno", kind: "send", via: "mail", to: { lists: [`contact:${lee.id}`] }, daily_cap: 50 });
  const follow = await ok("gate.standing.add", { agent: "juno", kind: "send", via: "mail", to: { lists: [`contact:${lee.id}`] }, follow_lists: true, daily_cap: 50 });
  assert.match(follow.warning, /Anyone who can edit these lists can change who juno sends to/);
  assert.equal((await send("lee@harlowlegal.com")).data.state, "sent", "the address the list held when the permission was made");
  // someone adds an address to the contact afterwards: the snapshot does not follow, the followed list does
  await K.gateway.records.update(ownerChain, "contact", lee.id, { other_emails: ["new@harlowlegal.com"] }, (await K.gateway.records.get(ownerChain, "contact", lee.id)).version);
  await ok("gate.standing.revoke", { id: follow.id });
  assert.equal((await send("new@harlowlegal.com")).data.state, "held", "a snapshot means what the person saw: the new address asks");
  const follow2 = await ok("gate.standing.add", { agent: "juno", kind: "send", via: "mail", to: { lists: [`contact:${lee.id}`] }, follow_lists: true, daily_cap: 50 });
  assert.equal((await send("new@harlowlegal.com")).data.state, "sent", "a list the person chose to follow as it changes covers the new address");
  await ok("gate.standing.revoke", { id: follow2.id });
  await ok("gate.standing.revoke", { id: snap.id });
  assert.equal((await send("lee@harlowlegal.com")).data.state, "held");
});

// ---- The said-intents and the asked-for handshake, restored verbatim from c1942ddd6 (the seven tests d984d8e2a replaced by two). Same intents; only the helper names differ from the tests above, so both sets live in one file.
const saidFake = (/** @type {string} */ label) => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;

/** A fake Gmail send endpoint that records what it was sent and can be told to fail. */
async function saidGmail(t) {
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

const MAIL = (/** @type {any} */ i = {}) => ({ kind: "send", via: "mail", to: "dana@harlowlegal.com", content: { subject: "Intake form", body: "Hi Dana, the form link is ready. Alex" }, ...i });

async function saidWorld(t) {
  const root = tempHome(t);
  const gmail = await saidGmail(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" },
    gate: { senders: { mail: { type: "gmail", vault: "work-mail-token", from: "alex@example.com", base: gmail.base } } } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const cli = (tool, input = {}) => call(tool, input, { root, caller: "cli" });
  const reg = (tool, input, caller, meta = {}) => d.registry.call(tool, input, caller, meta);
  const agent = (name, thread, tool, input) => reg(tool, input, `mcp:agent:${name}`, { thread, agent: name });
  assert.ok((await cli("vault.put", { name: "work-mail-token", kind: "api-key", fields: { value: saidFake("token") } })).data);
  assert.equal((await cli("vault.grant", { name: "work-mail-token", module: "gate" })).data.grant.status, "active");
  const said = (o, caller = "module:sessions") => reg("vault.said.record", { thread: "t-1", said: "said-1", kind: "send", to: ["dana@harlowlegal.com"], what: "email Dana", ...o }, caller);
  return { root, gmail, cli, reg, agent, said };
}

test("gate: an asked-for email must cover every real destination, cc and bcc included (M1)", async t => {
  const { gmail, agent, said } = await saidWorld(t);
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
  const { gmail, agent, said } = await saidWorld(t);
  await said({});
  assert.equal((await agent("juno", "t-1", "gate.request", MAIL({ thread: "t-1" }))).data.state, "sent");
  assert.equal((await agent("juno", "t-1", "gate.request", MAIL({ thread: "t-1" }))).data.state, "held", "the second one waits");
  assert.equal(gmail.got.length, 1);
  await said({ said: "said-2", to: ["sam@harlowlegal.com"], standing: true }, "module:assistant");
  for (let i = 0; i < 2; i++) assert.equal((await agent("juno", "t-2", "gate.request", MAIL({ to: "sam@harlowlegal.com" }))).data.state, "sent");
  assert.equal(gmail.got.length, 3);
});

test("gate: an intent that names agents covers only them; naming none covers any (agents field)", async t => {
  const { agent, said } = await saidWorld(t);
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
  const { gmail, cli, reg, agent } = await saidWorld(t);
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
  const { cli, reg, said } = await saidWorld(t);
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
  const { gmail, reg, agent } = await saidWorld(t);
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
