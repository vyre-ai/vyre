// The Kernel port core/work is written against, on the REAL kernel (createKernel): only a module that declares `needs.kernel.work` has it, chainFor refuses a call that holds no person,
// chainForPerson is a member's [viewer, service] chain and nothing wider, and tasks.forRecord reads through the caller's own chain. Stand-in: SHIM(presence), as the other kernel tests.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "./index.js";
import { canonical, sha256 } from "./core/canonical.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) ? null : "wrong_proof") };
const code = p => p.then(() => null, e => e.code);

test("work port: declared only; chainFor needs a person; chainForPerson is a member's narrowed chain; no chain for a stranger", async () => {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const role = { person: BOB, role: "member" };
  await k.gateway.grants.setRole(owner, role, { presence: proof("grants.role", role, `vyre://${SPACE}/member/${BOB}`) });
  assert.equal(k.kernelFor({ name: "work", needs: { kernel: { actions: [] } } }).chainFor, undefined, "not declared, not there");
  const w = k.kernelFor({ name: "work", needs: { kernel: { work: true, actions: ["records.read", "events.read"] } } });
  for (const f of ["chainFor", "chainForPerson", "serviceChain", "ask", "definitions", "actions", "members", "tasks", "audienceFor", "authorize", "records", "events", "model"]) assert.ok(f in w, f);
  // chainFor: the call's own chain. A call with only the module's service chain acts for no one and is refused.
  assert.equal(await code(w.chainFor({})), "not_allowed");
  const c = await w.chainFor({ kernelFacts: { kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" } });
  assert.equal(c.hops[0].actor.id, OWNER);
  // chainForPerson: a member, plus this module's service hop, and never another module's name.
  const bob = w.chainForPerson(BOB);
  assert.deepEqual(bob.hops.map(h => [h.actor.kind, h.actor.id]), [["person", BOB], ["service", "work"]]);
  assert.throws(() => w.chainForPerson("per_stranger"), { code: "not_found" });
  assert.throws(() => w.chainForPerson("../x"), { code: "bad_input" });
  // That chain reads what Bob may and nothing more: it is a viewer chain, so authorize refuses every act above read for it, and it holds no session, so it never stands for presence.
  assert.equal(bob.viewer, true);
  assert.equal((await w.authorize({ chain: bob, action: "records.update", resource: `vyre://${SPACE}/matter/m_1` })).effect, "deny");
  // tasks: the person's queue, and an empty list for a record with none.
  assert.deepEqual(await w.tasks.list(c), []);
  assert.deepEqual(await w.tasks.forRecord(c, `vyre://${SPACE}/matter/m_1`), []);
});
