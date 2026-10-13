// @ts-check
// presence.person.status names the person a session acts as, and their role here, to that caller only (a member's chain device sees HER identity and role, never the owner's). It is read from the facts the daemon
// built for the device, so nothing a caller sends picks the person.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const MEMBER = "per_" + "bcdefghijklmnopqrstuvwxyza";

test("status names the owner for the owner's session and the member for hers, and says nothing without a session", { timeout: 120_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner;
  const chain = (/** @type {string} */ p) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-" + p.slice(4, 8), person: p, path: "direct", session: "s" });
  await d.kernel.gateway.grants.setRole(chain(OWNER), { person: MEMBER, role: "member" }, { presence: { op: "stand-in", fields: {}, n: Math.random() } });
  const status = (/** @type {any} */ person, /** @type {any} */ facts) => d.registry.call("presence.person.status", {}, "deck", { person, ...(facts ? { kernelFacts: facts } : {}) });
  const session = { id: "sess1", kind: "bearer" };
  const mine = await status(session, { kind: "device", device_key_id: "dabc", person: MEMBER, path: "relay" });
  assert.equal(mine.error, undefined, JSON.stringify(mine.error));
  assert.deepEqual([mine.data.signed, mine.data.id, mine.data.person, mine.data.role], [true, "sess1", MEMBER, "member"]);
  const his = await status(session, { kind: "device", device_key_id: "downer", person: OWNER, path: "relay" });
  assert.deepEqual([his.data.person, his.data.role], [OWNER, "owner"]);
  const none = await status(null, null);
  assert.deepEqual(none.data, { signed: false });
});
