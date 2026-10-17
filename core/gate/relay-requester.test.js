// @ts-check
// A member's agent's send, filed at the Gate by the Microsoft and Google modules, is filed AS that member: the Gate records the person on the verified chain as the requester (only they see and answer it), and
// a call with no person behind it files nothing. The modules relay the person to gate.request ({ relay: true }, core/modules/relay-allowed.js) as mail does; a plain nested call carries no token to the Gate. Real daemon,
// kernel on, the fake Graph and the fake Google behind the real modules.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { startFakeGraph } from "../../lib/connectors/testing/fake-graph.js";
import { startFakeGoogle } from "../../lib/connectors/testing/fake-google.js";
import { allowLoopbackForTests } from "../../lib/http.js";
allowLoopbackForTests();

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

async function world(/** @type {import("node:test").TestContext} */ t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const dev = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  await K.gateway.grants.setRole(dev(OWNER), { person: BEN, role: "member" }, { presence: proof() });
  const as = async (/** @type {string} */ p, /** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "deck", { token: (await K.surfaces.open(dev(p), {})).token });
  const ok = async (/** @type {string} */ p, /** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await as(p, tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  const juno = await ok(BEN, "agents.create", { name: "juno", kind: "agent" });
  const agentTurn = async (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "mcp:agent:juno", { token: (await K.surfaces.open(dev(BEN), { agent: juno.uid, session: "s-ben", thread: "t-ben" })).token, thread: "t-ben", agent: "juno" });
  const held = () => d.registry.deps.db.prepare("SELECT COUNT(*) AS n FROM gate_items").get().n;
  return { d, K, OWNER, as, ok, agentTurn, held };
}

/** The assertions both providers share: filed as Ben, Ben's alone, nothing filed for a call with no person. */
async function filedAsBen(/** @type {any} */ w, /** @type {string} */ tool, /** @type {any} */ input) {
  const first = await w.agentTurn(tool, input);
  assert.ok(first.data && first.data.held, `${tool}: ${JSON.stringify(first)}`);
  const id = first.data.held;
  assert.equal((await w.ok(BEN, "gate.get", { id })).requester, BEN, "the Gate recorded the member on the verified chain as the requester");
  assert.equal((await w.as(w.OWNER, "gate.get", { id })).error?.code, "not_found", "and the owner is told there is no such item");
  const before = w.held();
  const bare = await w.d.registry.call(tool, input, "mcp:agent:juno", { agent: "juno", thread: "t-ben" });
  assert.ok(bare.error, `${tool}: a call with no person behind it is refused: ${JSON.stringify(bare)}`);
  assert.equal(w.held(), before, "and nothing was filed for it");
}

test("microsoft: a member's agent's send is filed at the Gate as the member; a call with no person files nothing", { timeout: 240_000 }, async t => {
  const g = await startFakeGraph(t, { users: { "ben@firm.test": { mail: [] }, "owner@firm.test": { mail: [] } } });
  const w = await world(t);
  await w.ok(w.OWNER, "vault.put", { name: "m365-key", kind: "env-set", fields: { tenant_id: g.tenant, client_id: g.clientId, client_secret: g.secret, token_uri: g.tokenUri } });
  await w.ok(w.OWNER, "vault.grant", { name: "m365-key", module: "microsoft" });
  await w.ok(w.OWNER, "microsoft.add", { name: "firm", domain: "firm.test", item: "m365-key", base: g.origin });
  await w.ok(w.OWNER, "microsoft.members.email", { person: BEN, email: "ben@firm.test" });
  await filedAsBen(w, "microsoft.mail.send", { to: ["dana@harlow.example"], subject: "Refund R-9", body: "Hello Dana" });
});

test("google: a member's agent's send from the firm key is filed at the Gate as the member; a call with no person files nothing", { timeout: 240_000 }, async t => {
  const fake = await startFakeGoogle(t, { users: ["ben@firm.test", "owner@firm.test"] });
  const w = await world(t);
  await w.ok(w.OWNER, "vault.put", { name: "firm-sa", kind: "secret", fields: { value: fake.serviceAccount("owner@firm.test") } });
  await w.ok(w.OWNER, "vault.grant", { name: "firm-sa", module: "google" });
  await w.ok(w.OWNER, "google.add", { name: "firm", email: "owner@firm.test", firm: true, domain: "firm.test", auth: { type: "service-account", item: "firm-sa" }, base: fake.base });
  await w.ok(w.OWNER, "google.members.email", { person: BEN, email: "ben@firm.test" });
  await filedAsBen(w, "google.mail.send", { to: "dana@harlow.example", subject: "Refund R-9", body: "Hello Dana" });
});
