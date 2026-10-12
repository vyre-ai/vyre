// A Space that already holds a type unprotected (an upgrade): the module that declares it protected defines it through the kernel handle (the raw store), AFTER a request has made the gateway read the definitions.
// The gateway must see the new definition: a member then reads none of its rows, by get, list or the event log.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { canonical, sha256 } from "../core/canonical.js";
const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob";
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const OLD = { name: "reminder", label: "Reminder", fields: [{ name: "title", kind: "text", label: "T" }] };
const NEW = { ...OLD, protected: true };
test("upgrade: a Space that already holds an unprotected reminder type; the planner module starts after a member has already used Records", async () => {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct" });
  const r = { person: BOB, role: "member" }; await k.gateway.grants.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${BOB}`) });
  const R = k.gateway.records;
  await R.define(owner, { add_types: [OLD] });
  const row = await R.create(owner, "reminder", { title: "OWNER-REMINDER" });
  assert.equal((await R.query(bob, "reminder", { page: { limit: 5 } })).rows.length, 1, "control: old definition, the member reads it (this is the open read)");
  const h = k.kernelFor({ name: "planner", needs: { kernel: { actions: ["records.read", "records.create", "records.update"], types: [NEW] } } });
  await h.records.query(k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" }), "reminder", { page: { limit: 1 } }).catch(() => null);
  const types = await k.store.types();
  assert.equal(types.find(t => t.name === "reminder").protected, true, "the module's definition reached the store");
  assert.equal((await R.query(bob, "reminder", { page: { limit: 5 } })).rows.length, 0, "AFTER the module defined it protected, the member reads none (a stale cache would still list it)");
  assert.equal(await R.get(bob, "reminder", row.id), null);
  const ev = await k.gateway.events.read(bob, {});
  assert.ok(!ev.some(e => String(e.subject).includes("/reminder/")), "and the event log shows her none of its events");
});
