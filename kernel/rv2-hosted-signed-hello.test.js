// @ts-check
// Review row 2: a Space this home HOSTS for a team asks a lent computer for a signed hello exactly as the home's own Space does. The hosted kernel is booted by createSpaceKernels with the home's bootOptions; the switch was
// missing there, so a team Cloud Space handed a lease key to a bare request. Through the real daemon: an accepted Offer, a lease request with no hello, and the answer.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "../test/helpers.js";
import { start } from "../core/daemon/index.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const ALICE = "per_" + "d".repeat(26), BOB = "per_" + "e".repeat(26), DEV = "dev_mac";
const standIn = { method: "stand-in" };

/** @param {any} t @param {Record<string, string>} [env] */
async function hostedWorld(t, env = {}) {
  for (const [k, v] of Object.entries(env)) { const was = process.env[k]; process.env[k] = v; t.after(() => { if (was === undefined) delete process.env[k]; else process.env[k] = was; }); }
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "team-box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  fs.writeFileSync(path.join(root, "dev-presence-stand-in"), "");
  const d = await start({ root, kernel: true, log: () => {} });
  t.after(() => d.stop());
  const team = await d.kernel.spaces.host({ owner: ALICE, name: "team" });
  const g = team.gateway.grants;
  const alice = team.kernel.chains.fromFacts({ kind: "device", device_key_id: "dev0000000000000a", person: ALICE, path: "direct", session: "s" });
  const bob = team.kernel.chains.fromFacts({ kind: "device", device_key_id: DEV, person: BOB, path: "direct" });
  await g.setRole(alice, { person: BOB, role: "member" }, { presence: standIn });
  await g.offers.offer(alice, { side: "space_allows", member: BOB }, { presence: standIn });
  await g.offers.offer(bob, { side: "member_accepts", member: BOB, device: DEV, device_key: DEV }, { presence: standIn });
  return { team, bob };
}

test("a team Space this home hosts asks a lent computer to sign its lease request: a bare request gets no key", { timeout: 180_000 }, async t => {
  const { team, bob } = await hostedWorld(t);
  await assert.rejects(team.gateway.leases.issue(bob, { device: DEV, device_key: DEV }), (/** @type {any} */ e) => e.code === "needs_presence", "an accepted Offer is not enough: the request must be signed");
});

test("the development switch still turns it off for a walk, in a development build", { timeout: 180_000 }, async t => {
  const { team, bob } = await hostedWorld(t, { VYRE_SIGNED_LEASES_OFF: "1" });
  const r = await team.gateway.leases.issue(bob, { device: DEV, device_key: DEV });
  assert.equal(Buffer.from(r.key, "base64").length, 32);
});
