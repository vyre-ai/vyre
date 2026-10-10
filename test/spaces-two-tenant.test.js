// @ts-check
// Two people on one box with no identity of its own (a server): the home owner is in two Spaces, a second person only in the first. spaces.list and spaces.records.status answer for the CALLER, never
// for the home's owner: the second person sees the first Space only, and a person in none sees none. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("spaces.list and spaces.records.status answer for the caller: a member of one Space sees only that one, a stranger sees none", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner, BOB = "per_" + "b".repeat(26), EVE = "per_" + "e".repeat(26);
  const s1 = await d.kernel.spaces.host({ owner, name: "roomone" }), s2 = await d.kernel.spaces.host({ owner, name: "roomtwo" });
  const ownerChain = s1.kernel.chains.fromFacts({ kind: "device", device_key_id: "dev0000000000000a", person: owner, path: "direct", session: "s" });
  await s1.gateway.grants.setRole(ownerChain, { person: BOB, role: "member" }, { presence: { method: "stand-in" } });
  const as = async (/** @type {string} */ person, /** @type {string} */ tool) => {
    const chain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "dev-" + person.slice(4, 10), person, path: "direct", session: "s" });
    return d.registry.call(tool, {}, "cli", { token: (await d.kernel.surfaces.open(chain, {})).token });
  };
  const ids = (/** @type {any} */ r) => (r.data ? (Array.isArray(r.data) ? r.data.map((/** @type {any} */ x) => x.id) : r.data.spaces.map((/** @type {any} */ x) => x.space)) : r).sort();
  assert.deepEqual(ids(await as(owner, "spaces.list")), [s1.space, s2.space, d.kernel.id.space].sort(), "the owner is in the home and both Spaces");
  assert.deepEqual(ids(await as(BOB, "spaces.list")), [s1.space], "a member of one Space sees only that one");
  assert.deepEqual(ids(await as(BOB, "spaces.records.status")), [s1.space]);
  assert.deepEqual(ids(await as(EVE, "spaces.list")), [], "a person in none sees none");
  assert.deepEqual(ids(await as(EVE, "spaces.records.status")), []);
  assert.deepEqual(ids(await as(owner, "spaces.records.status")), [s1.space, s2.space, d.kernel.id.space].sort());
});
