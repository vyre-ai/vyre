// The planner's reminder and note types are kept by the planner (protected by definition). A member reads, changes and creates none of their rows by any Records route, sees no event about them in the log or on a subscription,
// and cannot define a type to take their place; the planner (the keeper service) and the owner still do all of it.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { PLANNER_TYPES } from "../../core/planner/types.js";
import { canonical, sha256 } from "../core/canonical.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob";
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const KEPT = /\/(note|reminder)\//;

test("planner rows: no Records route, event read or subscription gives a member any of them, and she cannot create, change, remove or redefine; the planner and the owner can", { timeout: 120_000 }, async () => {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct" });
  { const r = { person: BOB, role: "member" }; await k.gateway.grants.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${BOB}`) }); }
  const R = k.gateway.records;
  const types = PLANNER_TYPES.filter(t => t.name === "note" || t.name === "reminder").map(t => ({ ...t }));
  const planner = k.kernelFor({ name: "planner", needs: { kernel: { actions: ["records.read", "records.create", "records.update", "records.remove"], types } } });
  const P = planner.serviceChain("planner"), PR = planner.records;
  const seen = [];
  const un = k.gateway.events.subscribe(bob, "probe", {}, e => { seen.push(e); });
  const note = await PR.create(P, "note", { title: "SECRET-NOTE", state: "open", body: "SECRET-NOTE-BODY" });
  const rem = await PR.create(P, "reminder", { title: "SECRET-REMINDER", kind: "reminder", state: "open", at: "2027-01-01T10:00:00Z" });
  await PR.update(P, "note", note.id, { title: "SECRET-NOTE-2" }, note.version);
  for (const [type, row] of [["note", note], ["reminder", rem]]) {
    assert.equal(await R.get(bob, type, row.id), null, `${type}: no get`);
    assert.deepEqual((await R.query(bob, type, { page: { limit: 20 } })).rows, [], `${type}: no list`);
    assert.deepEqual(await R.aggregate(bob, type, { measures: [{ fn: "count" }] }), [], `${type}: no count`);
    await assert.rejects(() => R.update(bob, type, row.id, { title: "BOB" }, row.version), e => ["not_allowed", "not_found", "denied"].includes(e.code), `${type}: no update`);
    await assert.rejects(() => R.remove(bob, type, row.id, row.version), e => ["not_allowed", "not_found", "denied"].includes(e.code), `${type}: no remove`);
    await assert.rejects(() => R.restore(bob, type, row.id), e => ["not_allowed", "not_found", "denied"].includes(e.code), `${type}: no restore`);
    await assert.rejects(() => R.create(bob, type, { title: "BOBS", state: "open", kind: "reminder", at: "2027-01-01T10:00:00Z" }), e => ["not_allowed", "denied"].includes(e.code), `${type}: no create`);
  }
  assert.equal((await R.search(bob, { text: "SECRET", page: { limit: 20 } })).rows.filter(h => h.type === "note" || h.type === "reminder").length, 0, "no search hit");
  for (const spec of [{}, { since: 0 }, { limit: 500 }]) {
    const got = await k.gateway.events.read(bob, spec);
    assert.ok(!got.some(e => KEPT.test(String(e.subject)) || JSON.stringify(e).includes("SECRET")), `events.read ${JSON.stringify(spec)} shows her none`);
  }
  await new Promise(r => setTimeout(r, 300));
  assert.ok(!seen.some(e => KEPT.test(String(e.subject)) || JSON.stringify(e).includes("SECRET")), `her subscription got none: ${JSON.stringify(seen.map(e => e.subject))}`);
  // she cannot define a type to take the place of the planner's, nor change its definition
  await assert.rejects(() => R.define(bob, { add_types: [{ name: "note", label: "Note", fields: [{ name: "title", kind: "text", label: "T" }] }] }), e => ["not_allowed", "denied", "not_found"].includes(e.code), "a member cannot define a `note` type");
  await assert.rejects(() => R.define(bob, { change_types: [{ ...types[0], protected: false }] }), e => ["not_allowed", "denied", "not_found"].includes(e.code), "nor change the planner's type to unprotected");
  assert.equal((await k.store.types()).find(t => t.name === "note").protected, true, "the definition is as the planner made it");
  // the planner and the owner still read their rows
  assert.equal((await PR.get(P, "note", note.id)).data.title, "SECRET-NOTE-2", "the planner reads its row");
  assert.equal((await R.get(owner, "reminder", rem.id)).data.title, "SECRET-REMINDER", "the owner reads the row");
  assert.ok((await k.gateway.events.read(owner, {})).some(e => KEPT.test(String(e.subject))), "the owner's log has the events");
  if (typeof un === "function") un();
});
