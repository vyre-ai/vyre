// @ts-check
// relay.device.info is read by the daemon on EVERY device call, to build that device's facts. It must answer for an ordinary device, an unknown id, an owner-paired device and a chain device whose chain cannot be read,
// and never throw. (It once threw for every device: a variable that was never defined, so no paired app device got any facts.)
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const IDENT = "per_" + "a".repeat(26);

async function rig(/** @type {any} */ t) {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const db = d.registry.deps.db;
  const add = (/** @type {string} */ id, /** @type {string | null} */ ownerPaired = null, /** @type {string | null} */ viaChain = null) =>
    db.prepare("INSERT INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at, owner_paired, via_chain) VALUES (?, 'phone', 'p', 1, 'app', 0, NULL, ?, ?)").run(id, ownerPaired, viaChain);
  const info = async (/** @type {string} */ id) => d.registry.call("relay.device.info", { id }, "module:vyred");
  return { d, add, info };
}

test("an ordinary paired device answers with its kind and no chain fact; an unknown id answers null", { timeout: 120_000 }, async t => {
  const { add, info } = await rig(t);
  add("ordinarydevice00");
  const r = await info("ordinarydevice00");
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(r.data.kind, "app");
  assert.equal(r.data.removed, false);
  assert.equal(r.data.ownerPaired, false);
  assert.equal(r.data.viaChain, undefined);
  const none = await info("neverpairedxxxxx");
  assert.equal(none.error, undefined);
  assert.equal(none.data, null);
});

test("an owner-paired device still reads as the owner's", { timeout: 120_000 }, async t => {
  const { add, info } = await rig(t);
  add("ownerdevice00000", JSON.stringify({ by: "owner", at: 1, path: "window" }));
  const r = await info("ownerdevice00000");
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(r.data.ownerPaired, true);
});

test("a chain device whose chain cannot be read does not throw: it answers removed (refused) with no chain fact", { timeout: 120_000 }, async t => {
  const { add, info } = await rig(t);
  add("chaindevice00000", null, JSON.stringify({ identity: IDENT, entry: "e".repeat(26), seq: 1, at: 1 }));
  const r = await info("chaindevice00000");
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(r.data.removed, true, "the chain is unreadable here (the identity is unknown to this home), so it is refused, not removed");
  assert.equal(r.data.viaChain, undefined);
});
