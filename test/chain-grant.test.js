// @ts-check
// presence.person.chain-grant (design B): the relay asks for the grant that lets a chain-admitted device open its person session. The refusals, on a real daemon: only the relay may ask, and only for a device that is
// on the chain right now with a presence key. (The grant itself for a listed device is proved on a real chain by rc2-people's walk, which needs the directory.)
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
  const add = (/** @type {string} */ id, /** @type {string | null} */ viaChain, /** @type {string | null} */ presenceKey = "someenrolledkey1") =>
    db.prepare("INSERT INTO relay_devices (id, name, pub, presence_key, paired_at, kind, trusted, removed_at, via_chain) VALUES (?, 'phone', 'p', ?, 1, 'app', 0, NULL, ?)").run(id, presenceKey, viaChain);
  const grant = (/** @type {string} */ id, caller = "module:relay") => d.registry.call("presence.person.chain-grant", { device: id }, caller);
  return { d, add, grant };
}

test("only the relay may ask for a chain grant", { timeout: 120_000 }, async t => {
  const { add, grant } = await rig(t);
  add("chaindevice00000", JSON.stringify({ identity: IDENT, entry: "e".repeat(26), seq: 1, at: 1 }));
  for (const caller of ["module:wink", "module:vyred", "cli", "device:chaindevice00000"]) {
    const r = await grant("chaindevice00000", caller);
    assert.ok(r.error, `${caller} is refused`);
    assert.notEqual(r.data?.granted, true);
  }
});

test("no grant for a device that is not on the chain: an ordinary paired device, or one never paired", { timeout: 120_000 }, async t => {
  const { add, grant } = await rig(t);
  add("ordinarydevice00", null);
  const a = await grant("ordinarydevice00");
  assert.ok(a.error && a.error.code === "denied", JSON.stringify(a));
  assert.match(a.error.message, /not on the identity chain/);
  const b = await grant("neverpairedxxxxx");
  assert.ok(b.error && b.error.code === "denied");
});

test("no grant for a chain device whose chain cannot be read now, or that has no presence key", { timeout: 120_000 }, async t => {
  const { add, grant } = await rig(t);
  add("chaindevice00000", JSON.stringify({ identity: IDENT, entry: "e".repeat(26), seq: 1, at: 1 }));
  const unreadable = await grant("chaindevice00000");
  assert.ok(unreadable.error && unreadable.error.code === "denied", "the chain is unknown to this home, so it is read as refused");
  add("nokeydevice0000", JSON.stringify({ identity: IDENT, entry: "f".repeat(26), seq: 1, at: 1 }), null);
  const nokey = await grant("nokeydevice0000");
  assert.ok(nokey.error && nokey.error.code === "denied");
});
