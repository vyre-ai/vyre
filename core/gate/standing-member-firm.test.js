// @ts-check
// A member's standing permission for their own agent over their own firm-key mailbox, through the real Gate, the real Microsoft module and the kernel, against the fake Graph. What it proves: a member's permission lets
// their own agent's send go out with no question; the same agent in another person's turn is still held for that person; the owner's permission covers only the owner's own turns; a member cannot give one over a sender
// that is not their own mailbox, or for an agent they did not make; and a revoke is immediate.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { startFakeGraph } from "../../lib/connectors/testing/fake-graph.js";
import { allowLoopbackForTests } from "../../lib/http.js";
allowLoopbackForTests();

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab", CY = "per_" + "defghijklmnopqrstuvwxyzabc";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

test("a member's standing permission lets their own agent send from their own mailbox; it covers no one else's turn, and the owner's covers only the owner's", { timeout: 240_000 }, async t => {
  const g = await startFakeGraph(t, { users: { "ben@firm.test": { mail: [] }, "cy@firm.test": { mail: [] }, "owner@firm.test": { mail: [] } } });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const dev = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  for (const p of [BEN, CY]) await K.gateway.grants.setRole(dev(OWNER), { person: p, role: "member" }, { presence: proof() });
  const as = async (/** @type {string} */ p, /** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "deck", { token: (await K.surfaces.open(dev(p), {})).token });
  const ok = async (/** @type {string} */ p, /** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await as(p, tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  // the owner sets the firm app up once and records each person's work email
  await ok(OWNER, "vault.put", { name: "m365-key", kind: "env-set", fields: { tenant_id: g.tenant, client_id: g.clientId, client_secret: g.secret, token_uri: g.tokenUri } });
  await ok(OWNER, "vault.grant", { name: "m365-key", module: "microsoft" });
  await ok(OWNER, "microsoft.add", { name: "firm", domain: "firm.test", item: "m365-key", base: g.origin });
  await ok(OWNER, "microsoft.members.email", { person: BEN, email: "ben@firm.test" });
  await ok(OWNER, "microsoft.members.email", { person: CY, email: "cy@firm.test" });
  await ok(OWNER, "microsoft.members.email", { person: OWNER, email: "owner@firm.test" });
  // Ben makes his own agent; the agent works in Ben's turns and in Cy's
  const juno = await ok(BEN, "agents.create", { name: "juno", kind: "agent" });
  const agentTurn = async (/** @type {string} */ person, /** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "mcp:agent:juno", { token: (await K.surfaces.open(dev(person), { agent: juno.uid, session: "s-" + person.slice(4, 8), thread: "t-" + person.slice(4, 8) })).token, thread: "t-" + person.slice(4, 8), agent: "juno" });
  const mail = (/** @type {string} */ person) => agentTurn(person, "microsoft.mail.send", { to: ["dana@harlow.example"], subject: "Refund R-9", body: "Hello Dana" });
  const posts = () => g.requests.filter(r => r.method === "POST");

  // before any permission, the agent's send in Ben's turn is held for Ben
  const first = await mail(BEN);
  assert.ok(first.data && first.data.held, JSON.stringify(first));
  assert.equal(posts().length, 0);

  // Ben gives juno a standing permission for his own mailbox
  const rule = { agent: "juno", kind: "send", via: "microsoft:firm", to: { patterns: ["*@harlow.example"] }, daily_cap: 3 };
  const made = await ok(BEN, "gate.standing.add", rule);
  assert.ok(made.id, "a member gives one for their own agent over their own mailbox");
  const covered = await mail(BEN);
  assert.equal(covered.data && covered.data.sent, true, JSON.stringify(covered));
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].path, "/v1.0/users/ben@firm.test/sendMail", "from Ben's own mailbox");

  // the same agent in Cy's turn is still held, for Cy, and nothing is sent from Cy's mailbox
  const cys = await mail(CY);
  assert.ok(cys.data && cys.data.held, "Ben's permission does not cover Cy's turn: " + JSON.stringify(cys));
  assert.equal(posts().length, 1);
  assert.equal((await as(CY, "gate.get", { id: cys.data.held })).data.requester, CY);
  assert.equal((await as(BEN, "gate.get", { id: cys.data.held })).error?.code, "not_found", "and Ben does not see it");

  // the owner's permission covers only the owner's own turns
  const ownerRule = await ok(OWNER, "gate.standing.add", rule);
  assert.ok(ownerRule.id);
  const cys2 = await agentTurn(CY, "microsoft.mail.send", { to: ["dana@harlow.example"], subject: "Second", body: "x" });
  assert.ok(cys2.data && cys2.data.held, "the owner's permission does not cover Cy's turn either");
  assert.equal(posts().length, 1);

  // what a member cannot do: another member's agent, the Space's own sender, "any" connection
  assert.equal((await as(CY, "gate.standing.add", rule)).error?.code, "denied", "Cy did not make juno");
  assert.equal((await as(BEN, "gate.standing.add", { ...rule, via: "mail" })).error?.code, "denied", "the Space's own sender is not a member's to give");
  const anyVia = { ...rule }; delete anyVia.via;
  assert.equal((await as(BEN, "gate.standing.add", anyVia)).error?.code, "denied", "nor a permission for any sender");

  // another member can neither end nor see Ben's permission; Ben sees his own; the owner (staff) sees every permission, which is the audit view the permission list already gave
  assert.equal((await as(CY, "gate.standing.revoke", { id: made.id })).error?.code, "denied", "Cy cannot revoke Ben's permission");
  assert.deepEqual((await ok(CY, "gate.standing.list")).permissions, [], "Cy's list shows none of Ben's");
  assert.deepEqual((await ok(CY, "gate.standing.list", { agent: "juno" })).permissions, [], "not even by naming the agent");
  assert.ok((await ok(BEN, "gate.standing.list")).permissions.some((/** @type {any} */ p) => p.id === made.id), "Ben sees his own");
  assert.ok((await ok(OWNER, "gate.standing.list")).permissions.some((/** @type {any} */ p) => p.id === made.id), "the owner sees all");
  // a member cannot give a permission over a connection she does not hold
  assert.equal((await as(BEN, "gate.standing.add", { ...rule, via: "mail:work" })).error?.code, "denied", "a connection Ben does not hold");
  assert.equal((await as(BEN, "gate.standing.add", { ...rule, via: "google:work" })).error?.code, "denied", "nor a Google connection that is not his");

  // a revoke is immediate
  await ok(BEN, "gate.standing.revoke", { id: made.id });
  const after = await mail(BEN);
  assert.ok(after.data && after.data.held, "revoked: held again " + JSON.stringify(after));
  assert.equal(posts().length, 1);
});
