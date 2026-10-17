// @ts-check
// The owner-only and person-only Flows tools on a real vyred, through the registry, with the caller's own session token (sec53's review of
// 179c1a963). An assistant's session names an agent hop on the owner's chain: the registry refuses flows.advance and flows.budget.set (the
// owner's person hop is not enough), holds flows.settle for the person's tap, and the owner's own token still works. A member reads
// flows.budget, and flows.kit.propose installs nothing until the approver says yes. SHIM(presence) `kernelPresence` accepts any proof, as the other real-daemon suites do.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "./index.js";
import { tempHome } from "../../test/helpers.js";

const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 25_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out: ${what}`); await new Promise(r => setTimeout(r, 200)); } };

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

/** The code a refused call carries, or "" when it went through. @param {any} r */
const refusedCode = r => (r && r.error ? String(r.error.code || r.error.message || "") : "");

test("an assistant's session cannot advance a stage gate or set the AI budget, even on the owner's chain; the owner's own session still can; a member reads the budget", { timeout: 150_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await K.gateway.grants.setRole(ownerChain, { person: BEN, role: "member" }, { presence: proof() });
  const benChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-ben", person: BEN, path: "relay" });
  const tokenOf = async (/** @type {any} */ c, /** @type {any} */ o = {}) => ({ token: (await K.surfaces.open(c, o)).token });
  const asOwner = async (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "cli", await tokenOf(ownerChain));
  const asAssistant = async (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "mcp", await tokenOf(ownerChain, { agent: "kit", thread: "t-1" }));
  const asBen = async (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "mcp", await tokenOf(benChain));

  // the assistant's advance and budget set are refused at the registry; the owner's own token is not refused for who it is
  assert.notEqual(refusedCode(await asAssistant("flows.advance", { run: "no-such-run", reason: "x" })), "", "an assistant cannot advance a stage gate");
  const aBudget = await asAssistant("flows.budget.set", { tokens_per_day: 999999 });
  assert.notEqual(refusedCode(aBudget), "", "an assistant cannot set the AI budget, even on the owner's chain");
  const before = await asOwner("flows.budget", {});
  assert.ok(before.data && typeof before.data.tokens_per_day === "number", JSON.stringify(before));
  assert.notEqual(before.data.tokens_per_day, 999999, "the refused set changed nothing");

  const oBudget = await asOwner("flows.budget.set", { tokens_per_day: 123456 });
  assert.ok(!refusedCode(oBudget), `the owner's own session sets the budget: ${JSON.stringify(oBudget)}`);
  assert.equal((await asOwner("flows.budget", {})).data.tokens_per_day, 123456, "the owner's set is read back");

  // a member reads the budget; setting it is refused to her
  const benRead = await asBen("flows.budget", {});
  assert.ok(benRead.data && typeof benRead.data.tokens_per_day === "number", `a member reads the budget: ${JSON.stringify(benRead)}`);
  assert.notEqual(refusedCode(await asBen("flows.budget.set", { tokens_per_day: 1 })), "", "a member cannot set the budget");
});

test("an assistant's settle is held for the person's tap, not run; the owner's settle still reaches the runner", { timeout: 150_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  const tokenOf = async (/** @type {any} */ c, /** @type {any} */ o = {}) => ({ token: (await K.surfaces.open(c, o)).token });
  const asOwner = async (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "cli", await tokenOf(ownerChain));
  const asAssistant = async (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "mcp", await tokenOf(ownerChain, { agent: "kit", thread: "t-1" }));

  for (const action of ["retry", "advance"]) {
    const r = await asAssistant("flows.settle", { run: "no-such-run", action, reason: "x" });
    assert.ok(r.data && r.data.held_for_approval, `an assistant's settle ${action} is held for the person's tap: ${JSON.stringify(r)}`);
  }
  // the owner's own settle is not held: it reaches the runner (which says the run is not there)
  const own = await asOwner("flows.settle", { run: "no-such-run", action: "retry" });
  assert.ok(!(own.data && own.data.held_for_approval), "the owner's settle is not held by the assistant rule");
});

test("a Kit proposal installs nothing until the approver says yes", { timeout: 180_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, owner = K.id.owner;
  const chainOf = () => K.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await K.surfaces.open(chainOf(), {})).token });
  const lib = (await d.registry.call("records.kits.library", {}, "cli", await meta())).data;
  // not the base Kit: a new Space starts with its types already, so installing it adds none
  const id = (lib.kits || lib).find((/** @type {any} */ k) => k.id !== "base").id;
  const kit = (await d.registry.call("records.kits.get", { id }, "cli", await meta())).data;
  const p = await d.registry.call("flows.kit.propose", { kit: kit.kit || kit }, "cli", await meta());
  assert.ok(p.data && p.data.ok, JSON.stringify(p));
  const typesBefore = (await K.store.types()).map((/** @type {any} */ x) => x.name);
  const installed = async () => ((await d.registry.call("flows.kit.list", {}, "cli", await meta())).data || []).filter((/** @type {any} */ k) => k.status === "installed");
  assert.equal((await installed()).length, 0, "nothing installed by the proposal");
  assert.deepEqual((await K.store.types()).map((/** @type {any} */ x) => x.name), typesBefore, "no type defined by the proposal");
  // the approver's yes is the install's only way in (kit-apply runs it on the approved task)
  const row = await K.gateway.ask.get(chainOf(), p.data.task);
  await K.gateway.ask.decide(chainOf(), p.data.task, { outcome: "approved", proof: { op: "task.decide", fields: { task: p.data.task, payload_hash: row.payload.payload_hash, decision: row.payload.decision }, n: Math.random() } });
  const done = await until(async () => (await installed()).length ? true : null, "the approved Kit to install");
  assert.ok(done, "the Kit installs once the approver says yes");
});
