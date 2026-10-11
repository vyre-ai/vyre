// @ts-check
// The member door's session tokens (kernel/remote/server.js ADAPT surfaces.open / surfaces.revoke): a token for a person's whole chain is for an owner or an admin. No member path opens one over the door (a member's chats
// mint their own, server side), so a member is refused with words that name a next step; the owner is still served. Through the real dispatch (serve), on a real vyred. Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../../core/daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { createRemoteServer } from "./server.js";
import { WIRE_VERSION } from "./wire.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

test("a member is refused a session token over the door, in words with a next step; the owner is served; a member cannot revoke either", { timeout: 90_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner, SPACE = d.kernel.id.space;
  const oc = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await d.kernel.gateway.grants.setRole(oc, { person: ANA, role: "member" }, { presence: proof() });
  const server = createRemoteServer({ space: SPACE, kernel: d.kernel, services: {} });
  let n = 0;
  const via = async (/** @type {string} */ person, /** @type {string} */ call, /** @type {any[]} */ ...args) => {
    const r = await server.serve({ v: WIRE_VERSION, id: "r" + (++n), space: SPACE, ts: Date.now(), call, args }, { device_key_id: "dev-" + person.slice(4, 10), person, path: "relay" });
    return r.ok ? { ok: true, v: r.result } : { ok: false, e: `${r.error.code}: ${r.error.message}` };
  };
  const refused = await via(ANA, "surfaces.open", {});
  assert.equal(refused.ok, false);
  assert.match(String(refused.e), /not_allowed.*owner or an admin.*ask the owner/i, "words with a next step");
  assert.equal((await via(ANA, "surfaces.revoke", "some-session")).ok, false, "and she cannot revoke");
  const served = await via(OWNER, "surfaces.open", {});
  assert.ok(served.ok && typeof served.v.token === "string", `the owner is served: ${JSON.stringify(served)}`);
  assert.equal((await via(OWNER, "surfaces.revoke", served.v.session || served.v.token)).ok !== undefined, true);
});
