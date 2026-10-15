// @ts-check
// ONE rule for both doors: the app's member door (core/flows/member.js) and the MCP tools use mayInspectFlow.
// Flows over MCP for members (roadmap 0.6 item 14): flows.describe, flows.runs and flows.connections answer a member for a Flow she made or one shared with her (Can use or Can edit), and refuse
// one that is not; an owner is served as before. A real vyred with the kernel on, the member's own session token on an MCP call. SHIM(presence) `kernelPresence` accepts any proof.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "./index.js";
import { tempHome } from "../../test/helpers.js";
import { createMemberTools } from "../work/member-tools.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

test("a member's MCP key inspects a Flow shared with her and is refused one that is not", { timeout: 150_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await K.gateway.grants.setRole(ownerChain, { person: BEN, role: "member" }, { presence: proof() });
  const benChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-ben", person: BEN, path: "relay" });
  const tokenOf = async (/** @type {any} */ c) => ({ token: (await K.surfaces.open(c, {})).token });
  const asOwner = async (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "cli", await tokenOf(ownerChain));
  const asBen = async (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "mcp", await tokenOf(benChain));

  const mk = async (/** @type {string} */ name) => {
    const f = await asOwner("flows.define", { flow: { format: 1, name, label: name, authorship: "human", trigger: { on: "manual" }, steps: [] } });
    assert.ok(f.data && f.data.ok, JSON.stringify(f.error || f.data));
    assert.ok(!(await asOwner("flows.approve", { id: f.data.id, version: f.data.version, hash: f.data.hash })).error);
    const run = await asOwner("flows.start", { id: f.data.id });
    assert.ok(!run.error, JSON.stringify(run.error));
    return f.data.id;
  };
  const shared = await mk("refunds"), hidden = await mk("owner_only");
  assert.ok(!(await asOwner("flows.access.set", { id: shared, subject: BEN, level: "use" })).error);

  // the Flow shared with her
  const d1 = await asBen("flows.describe", { id: shared });
  assert.ok(d1.data && Array.isArray(d1.data.lines), "describe answers for a shared Flow: " + JSON.stringify(d1.error));
  const r1 = await asBen("flows.runs", { id: shared });
  assert.ok(Array.isArray(r1.data) && r1.data.length >= 1, "its runs answer: " + JSON.stringify(r1.error));
  // the Flow that is not shared with her
  for (const [tool, input] of [["flows.describe", { id: hidden }], ["flows.runs", { id: hidden }]]) {
    const r = await asBen(tool, input);
    assert.ok(r.error && r.error.code === "not_found", `${tool} on a Flow that is not shared: ${JSON.stringify(r).slice(0, 160)}`);
  }
  const hiddenRun = (await asOwner("flows.runs", { id: hidden })).data[0];
  assert.equal((await asBen("flows.describe", { run: hiddenRun.id })).error?.code, "not_found", "a run of a Flow that is not shared");
  // without an id she is shown the runs of her Flows only
  const all = await asBen("flows.runs", {});
  assert.ok(Array.isArray(all.data) && all.data.every((/** @type {any} */ r) => r.flow === shared) && all.data.length >= 1, "only the shared Flow's runs: " + JSON.stringify(all.data));
  // connections: answers, and names no Flow she may not inspect
  const c = await asBen("flows.connections", {});
  assert.ok(c.data && Array.isArray(c.data.connections), JSON.stringify(c.error));
  assert.ok(!JSON.stringify(c.data).includes(hidden));
  // a run of one Flow and the id of another in one call: only the run's own Flow is read, and never the other
  const sharedRun = (await asOwner("flows.runs", { id: shared })).data[0];
  const mixed = await asBen("flows.describe", { run: sharedRun.id, id: hidden });
  assert.ok(mixed.data, JSON.stringify(mixed.error));
  assert.ok(!JSON.stringify(mixed.data).includes("owner_only"), "the hidden Flow's words are not in it");
  assert.equal((await asBen("flows.describe", { run: hiddenRun.id, id: shared })).error?.code, "not_found", "a hidden run named beside a shared id");
  // the app's member door answers the same way for the same people
  const svc = /** @type {any} */ (createMemberTools({ space: K.id.space, kernel: K, registry: d.registry }).flows);
  assert.ok((await svc.list(benChain, {})).every((/** @type {any} */ r) => r.id === shared), "the door lists only the shared Flow");
  for (const call of [() => svc.get(benChain, { id: hidden }), () => svc.runs(benChain, { id: hidden }), () => svc.describe(benChain, { id: hidden }), () => svc.start(benChain, { id: hidden }), () => svc.describe(benChain, { run: hiddenRun.id })])
    await assert.rejects(call, /no such Flow you can use/);
  assert.ok((await svc.describe(benChain, { id: shared })).lines.length >= 1);
  // an owner still sees all
  assert.ok((await asOwner("flows.describe", { id: hidden })).data.lines.length >= 1);
  assert.ok((await asOwner("flows.runs", {})).data.length >= 2);
  // taking the sharing away closes it again
  assert.ok(!(await asOwner("flows.access.set", { id: shared, subject: BEN, level: null })).error);
  assert.equal((await asBen("flows.describe", { id: shared })).error?.code, "not_found");
});
