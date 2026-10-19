// @ts-check
// A person's profile through the entry points the app really calls (apps/app/src/state/profiles.ts): records.create and records.update as the person on a real vyred with the kernel on, and, for a member
// of a team the box hosts, the member door's records rows. The owner's and a member's own save goes through; a Flow step's and an agent's is refused (kernel/gateway/ownership.js). SHIM(presence):
// `kernelPresence` accepts any proof for the owner's grants acts. Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { MEMBER_PROFILE } from "../../records/core-types.js";
import { createMemberTools } from "../work/member-tools.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab", ANA = "per_" + "bcdefghijklmnopqrstuvwxyza";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const T = "member-profile";

test("the owner and a member save their own profile through the app's tools; a Flow step and an agent cannot", { timeout: 150_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner, space = K.id.space;
  const dev = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  const ownerChain = dev(OWNER);
  for (const p of [BEN, ANA]) await K.gateway.grants.setRole(ownerChain, { person: p, role: "member" }, { presence: proof() });
  await K.gateway.records.define(ownerChain, { add_types: [MEMBER_PROFILE] }).catch(() => {});
  // the app's call: the registry tool, as the person's own connection
  const as = async (/** @type {string} */ p, /** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "cli", { token: (await K.surfaces.open(dev(p), {})).token });

  // the owner, on their own box
  const me = await as(OWNER, "records.me", {});
  assert.equal(me.data && me.data.person, OWNER, JSON.stringify(me));
  const made = await as(OWNER, "records.create", { type: T, data: { person: OWNER, name: "Owner", about: "Runs the Space", look: "s3~c5" } });
  assert.ok(!made.error, JSON.stringify(made.error));
  const rec = made.data.record;
  const changed = await as(OWNER, "records.update", { urn: rec.urn, patch: { about: "Runs the Space and billing" }, base_version: rec.version });
  assert.ok(!changed.error, JSON.stringify(changed.error));
  assert.equal(changed.data.record.data.about, "Runs the Space and billing");

  // a member, through the same tools
  const bens = await as(BEN, "records.create", { type: T, data: { person: BEN, name: "Ben", about: "Intake" } });
  assert.ok(!bens.error, JSON.stringify(bens.error));
  const benUp = await as(BEN, "records.update", { urn: bens.data.record.urn, patch: { about: "Intake and calendar" }, base_version: bens.data.record.version });
  assert.ok(!benUp.error, JSON.stringify(benUp.error));
  // and the owner cannot change hers, through the same tool
  const ownerOnBen = await as(OWNER, "records.update", { urn: bens.data.record.urn, patch: { about: "Changed by the owner" }, base_version: benUp.data.record.version });
  assert.equal(ownerOnBen.error && ownerOnBen.error.code, "not_allowed", JSON.stringify(ownerOnBen));

  // a member of a team this box hosts, through the member door's rows (the path a joined member's app takes)
  const door = createMemberTools({ space, kernel: K, registry: d.registry });
  const anaChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-ana1", person: ANA, path: "relay" });
  const anas = /** @type {any} */ (await /** @type {any} */ (door).records.create(anaChain, { type: T, data: { person: ANA, name: "Ana", about: "Billing" } })).record;
  assert.equal(anas.data.person, ANA);
  const anaUp = /** @type {any} */ (await /** @type {any} */ (door).records.update(anaChain, { urn: anas.urn, patch: { about: "Billing and payroll" }, base_version: anas.version })).record;
  assert.equal(anaUp.data.about, "Billing and payroll");

  // a Flow step running as the owner (the approver's chain with the automation after it) is refused, on create and on update
  const flow = K.chains.forFlow({ flow: "f_profile", approver: ownerChain, run: "run_1" });
  const code = (/** @type {Promise<any>} */ p) => p.then(() => null, (/** @type {any} */ e) => e && e.code);
  assert.equal(await code(K.gateway.records.create(flow, T, { person: OWNER, about: "Made by a Flow" })), "not_allowed", "a Flow's create");
  const cur = await K.gateway.records.get(ownerChain, T, rec.id);
  assert.equal(await code(K.gateway.records.update(flow, T, rec.id, { about: "Changed by a Flow" }, cur.version)), "not_allowed", "a Flow's update");

  // an agent acting for the owner: refused through the gateway and through the registry tool a model session would call
  const agent = K.chains.fromFacts({ kind: "agent_session", vouched: true, person: OWNER, agent: "assistant", session: "s-agent" });
  assert.notEqual(await code(K.gateway.records.update(agent, T, rec.id, { about: "Changed by an agent" }, cur.version)), null, "an agent's update");
  const viaModel = await d.registry.call("records.update", { urn: rec.urn, patch: { about: "Changed by a model" }, base_version: cur.version }, "mcp", {});
  assert.ok(viaModel.error, JSON.stringify(viaModel));
  assert.equal((await K.gateway.records.get(ownerChain, T, rec.id)).data.about, "Runs the Space and billing", "unchanged");
});
