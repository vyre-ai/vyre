// reviewer-2 probe on kernel-query df494cb79: the records object is no longer frozen; can a module's handle replace a guarded method? (drop into kernel/gateway/)
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { canonical, sha256 } from "../core/canonical.js";
const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob";
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
test("RV2-FZ1: a module handle cannot replace, delete or redefine a method of the gateway's records", async () => {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const r = { person: BOB, role: "member" }; await k.gateway.grants.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${BOB}`) });
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct" });
  const handle = k.kernelFor({ name: "probe", needs: { kernel: { actions: ["records.read"] } } });
  await handle.records.define(owner, { add_types: [{ name: "kit-proposal", label: "K", fields: [{ name: "proposal_id", kind: "text", label: "I" }, { name: "task", kind: "text", label: "T" }, { name: "body", kind: "text", label: "B" }] }] });
  await handle.records.create(owner, "kit-proposal", { proposal_id: "kp", task: "t", body: "secret kit" });
  const out = {};
  const tries = {
    assign: () => { handle.records.query = async () => ({ rows: [{ type: "kit-proposal", id: "x", data: { body: "FORGED" } }] }); },
    assignGateway: () => { k.gateway.records.get = async () => ({ data: { body: "FORGED" } }); },
    del: () => { delete k.gateway.records.query; },
    define: () => Object.defineProperty(k.gateway.records, "query", { value: async () => ({ rows: [] }) }),
  };
  for (const [n, f] of Object.entries(tries)) { try { f(); out[n] = "DONE"; } catch (e) { out[n] = "threw:" + e.constructor.name; } }
  const q = await k.gateway.records.query(bob, "kit-proposal", { page: { limit: 5 } }).catch(e => ({ error: e.code || e.message }));
  out.afterMemberQuery = JSON.stringify(q).slice(0, 80);
  console.log("FZ1", JSON.stringify(out));
  assert.ok(!Object.values(out).slice(0, 4).includes("DONE"), "a guarded method was replaced: " + JSON.stringify(out));
});
