// @ts-check
// Design B on a REAL daemon and kernel: what the facts of a chain device open and shut. (b) a member's chain device is refused the vault and the relay's owner acts; (g) an owner's chain device still gets the owner's
// facts and acts; (h) a limited member device (an unconfirmed GitHub-added one) is refused the device-admin tools but still uses the member's tools. The facts are the ones callerFacts builds from a device row.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start, callerFacts } from "../core/daemon/index.js";
import { createLimitedGate, DEVICE_ADMIN } from "../core/modules/device-admin.js";
import { refusal } from "../core/modules/door-gate.js";
import { tempHome } from "./helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const MEMBER = "per_" + "bcdefghijklmnopqrstuvwxyza";
const DEVICE = "device:abcdefghijklmnop";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

/** A team server: the owner and one member. `facts(role-holder)` is what callerFacts gives a chain device of that person. */
async function rig(/** @type {any} */ t, /** @type {{ limited?: boolean }} */ o = {}) {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner;
  const chain = (/** @type {string} */ p) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-" + p.slice(4, 8), person: p, path: "direct", session: "s" });
  await d.kernel.gateway.grants.setRole(chain(OWNER), { person: MEMBER, role: "member" }, { presence: proof() });
  d.registry.deps.limitedGate = createLimitedGate({ isLimited: async () => o.limited === true });
  /** The facts of a chain device of `identity`, built the way the daemon builds them from the relay's row. */
  const facts = (/** @type {string} */ identity, memberRole = "member") => callerFacts(DEVICE, { caller: DEVICE }, null, d.kernel, false,
    { kind: "app", removed: false, ownerPaired: false, homeOwner: false, person: null, viaChain: { identity, limited: o.limited === true }, memberRole: identity === OWNER ? null : memberRole });
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ f) => d.registry.call(tool, input, DEVICE, { kernelFacts: f });
  return { d, OWNER, facts, call };
}

test("(b) a member's chain device is refused the vault and the relay's owner acts, in the owner's words", { timeout: 200_000 }, async t => {
  const { facts, call } = await rig(t);
  const f = facts(MEMBER);
  assert.equal(f?.person, MEMBER);
  for (const [tool, input] of /** @type {[string, any][]} */ ([["vault.list", {}], ["relay.devices.rename", { id: "abcdefghijklmnop", name: "x" }], ["relay.devices.remove", { id: "abcdefghijklmnop" }], ["relay.devices.mark", { id: "abcdefghijklmnop" }]])) {
    const r = await call(tool, input, f);
    assert.ok(r.error && r.error.code === "denied", `${tool}: refused to her, got ${JSON.stringify(r).slice(0, 160)}`);
    assert.equal(r.error.message, refusal(tool), `${tool}: in the owner's words`);
  }
});

test("(g) the owner's chain device is unchanged: owner facts, and the owner's acts are served", { timeout: 200_000 }, async t => {
  const { facts, call, OWNER } = await rig(t);
  const f = facts(OWNER);
  assert.equal(f?.person, OWNER);
  assert.equal(f?.kind, "device");
  const r = await call("settings.get", {}, f);
  assert.ok(!(r.error && r.error.code === "denied"), `settings.get is the owner's and is served: ${JSON.stringify(r).slice(0, 160)}`);
});

test("(h) a limited member device is refused the device-admin tools but still uses the member's tools", { timeout: 200_000 }, async t => {
  const { facts, call } = await rig(t, { limited: true });
  const f = facts(MEMBER);
  assert.equal(f?.limited, true, "the live limit rides in her facts");
  for (const tool of ["relay.devices.mark", "presence.enroll", "wink.phone.open", "spaces.devices.set"]) {
    assert.ok(DEVICE_ADMIN.has(tool), `${tool} is a device-admin tool`);
    const r = await call(tool, {}, f);
    assert.ok(r.error && r.error.code === "denied", `${tool}: refused`);
  }
  const used = await call("records.list", { type: "contact" }, f);
  assert.ok(!(used.error && used.error.code === "denied"), `a member's own tool is not refused: ${JSON.stringify(used).slice(0, 160)}`);
});
