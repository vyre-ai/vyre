import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { canonical, sha256 } from "../core/canonical.js";

// Custom roles (core/roles): the membership keeps its base built-in role and adds `custom`; the kernel expands the given grants under source role:<id> and refuses anything outside the base bundle.
const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) ? null : "wrong_proof") };
const all = `vyre://${SPACE}/*/*`;
const bobActor = { kind: "person", id: BOB, space: SPACE };

async function rig() {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 4), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants;
  const set = (m) => g.setRole(owner, m, { presence: proof("grants.role", m, `vyre://${SPACE}/member/${m.person}`) });
  const active = async () => (await g.list(owner, { subject: { kind: "actor", actor: bobActor }, status: "active" }));
  const mine = async () => (await g.members.list(owner)).find(m => m.person === BOB);
  return { set, active, mine };
}
const custom = (id, actions, extra = {}) => ({ id, grants: [{ actions, resource: { prefix: all }, ...extra }] });

test("a custom role: the grants carry source role:<id>, the membership keeps its base and names the role", async () => {
  const { set, active, mine } = await rig();
  await set({ person: BOB, role: "member", custom: custom("paralegal", ["records.read", "tasks.read"]) });
  const gs = await active();
  assert.ok(gs.length > 0 && gs.every(x => x.source === "role:paralegal"), "no member bundle is left beside it");
  assert.deepEqual(gs.flatMap(x => x.actions).sort(), ["records.read", "tasks.read"]);
  const m = await mine();
  assert.equal(m.role, "member");
  assert.equal(m.custom, "paralegal");
});

test("a custom role never holds an action outside its base, never has a base above admin, never a reserved id or a wider prefix", async () => {
  const { set } = await rig();
  await assert.rejects(() => set({ person: BOB, role: "member", custom: custom("wide", ["records.read", "records.define"]) }), { code: "not_allowed" }, "records.define is Admin's");
  await assert.rejects(() => set({ person: BOB, role: "admin", custom: custom("own", ["records.read"]) }), { code: "not_allowed" }, "base admin: it would still rank as an admin");
  await assert.rejects(() => set({ person: BOB, role: "member", custom: custom("own", ["space.upgrade"]) }), { code: "not_allowed" }, "owner-only action");
  await assert.rejects(() => set({ person: BOB, role: "owner", custom: custom("boss", ["records.read"]) }), { code: "not_allowed" }, "base owner");
  await assert.rejects(() => set({ person: BOB, role: "temp", scope: [all], expires: Date.now() + 3600_000, custom: custom("guesty", ["records.read"]) }), { code: "not_allowed" }, "base temp");
  await assert.rejects(() => set({ person: BOB, role: "member", custom: custom("member", ["records.read"]) }), { code: "not_allowed" }, "reserved id");
  await assert.rejects(() => set({ person: BOB, role: "member", custom: { id: "far", grants: [{ actions: ["records.read"], resource: { prefix: "vyre://spc_bbbbbbbbbbbb/*/*" } }] } }), { code: "not_allowed" }, "another Space");
  await assert.rejects(() => set({ person: BOB, role: "member", custom: custom("odd", ["records.read"], { conditions: { budget: { meter: "x", limit: 1 } } }) }), { code: "not_allowed" }, "only an expiry as a condition");
  for (const bad of [{ conditions: { when: { expires: "soon" } } }, { conditions: { when: { expires: NaN } } }, { conditions: { when: { expires: 1 } } }, { resource: { prefix: all, where: [{ attr: "nope", op: "eq", value: "x" }] } }, { resource: { prefix: all, where: "project" } }, { resource: { prefix: all, fields: ["ok", ""] } }]) {
    await assert.rejects(() => set({ person: BOB, role: "member", custom: { id: "typo", grants: [{ actions: ["records.read"], resource: { prefix: all }, ...bad }] } }), { code: "not_allowed" }, JSON.stringify(bad));
  }
});

test("assigning again replaces the old grants and leaves none behind; a built-in role returns the person to exactly the base", async () => {
  const { set, active, mine } = await rig();
  await set({ person: BOB, role: "member", custom: custom("alpha", ["records.read"]) });
  await set({ person: BOB, role: "member", custom: custom("alpha", ["records.read", "records.create"]) });
  let gs = await active();
  assert.deepEqual(gs.flatMap(x => x.actions).sort(), ["records.create", "records.read"], "only the new grants are active");
  await set({ person: BOB, role: "member" });
  gs = await active();
  assert.deepEqual(gs.map(x => x.source), ["role:member"]);
  assert.ok(gs[0].actions.includes("records.update") && gs[0].actions.includes("tasks.work"), "the whole Member bundle");
  assert.equal((await mine()).custom, undefined);
});

test("an end date on a custom role is a condition on its grants", async () => {
  const { set, active } = await rig();
  const at = Date.now() + 3600_000;
  await set({ person: BOB, role: "member", custom: custom("temp-help", ["records.read"], { conditions: { when: { expires: at } } }) });
  assert.equal((await active())[0].conditions.when.expires, at);
});
