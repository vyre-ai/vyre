import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteKernel } from "./client.js";
import { createRemoteServer } from "./server.js";
import { createMemoryTransport } from "./memory-transport.js";
import { createKernel } from "../index.js";
import { payloadHash } from "../seal/wire.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob";
let T = 1_800_000_000_000;
const clock = () => ++T;

/** A home with the sealing process's contract (a proof over exactly the payload hash, once) and a remote client over an in-memory wire as the owner's device. */
async function rig({ signer } = {}) {
  const used = new Set();
  const presence = { check: async ({ chain, op, fields, proof }) => (chain && proof && proof.payload_hash === payloadHash(op, SPACE, fields) && !used.has(proof.nonce) && (used.add(proof.nonce), true) ? null : "wrong_payload") };
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), clock, presence });
  const server = createRemoteServer({ space: SPACE, home: "home_x", kernel: k, clock });
  const transport = createMemoryTransport({ servers: { [SPACE]: server }, peer: { device_key_id: "dev_owner", person: OWNER, path: "wink" } });
  const device = createRemoteKernel({ space: SPACE, transport, clock, ...(signer ? { signer } : {}) });
  return { k, server, transport, device };
}

const role = { person: BOB, role: "member" };
// ---- reviewer-2 probe on b67e0a20f: does the home's kernel refuse a proof whose signed home or challenge is not this home's or this challenge's? (drop into kernel/remote/) ----
test("RV2-RP1: a proof naming another home, another challenge, or neither is refused by the home, not only by the device's own signer", async () => {
  const out = {};
  for (const [name, extra] of Object.entries({ "another home": { home: "home_OTHER", challenge: "WILL-BE-SET" }, "another challenge": { home: "home_x", challenge: "chal_other" }, "no home no challenge": {}, "right home right challenge": { home: "home_x", challenge: "WILL-BE-SET" } })) {
    const signer = async ch => ({ presence: { payload_hash: ch.payload_hash, nonce: "n_" + Math.random(), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, v === "WILL-BE-SET" ? ch.nonce : v])) } });
    const { device, k } = await rig({ signer });
    try { await device.gateway.grants.setRole({}, role); out[name] = "ACCEPTED"; } catch (e) { out[name] = "refused:" + (e.code || String(e.message).slice(0, 60)); }
  }
  console.log("RP1", JSON.stringify(out));
  for (const n of ["another home", "another challenge", "no home no challenge"]) assert.notEqual(out[n], "ACCEPTED", n + " was accepted");
  assert.equal(out["right home right challenge"], "ACCEPTED");
});
