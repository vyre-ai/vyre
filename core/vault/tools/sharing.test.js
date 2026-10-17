// @ts-check
// vault.access.*: sharing an item is a kernel grant at one of the kernel's access levels, through the vault module's mint handle, for a person, a team or an agent.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { register, sourceOf } from "./sharing.js";
import { ACCESS_LEVELS } from "../../../kernel/seal/uses.js";

const BOB = "per_" + "b".repeat(26);
const TEAM = "team_aaaa";
const KIT = "agt_kit";

function rig() {
  /** @type {any[]} */ const grants = [];
  const mint = {
    make: async (/** @type {any} */ g) => { grants.push({ ...g, id: "gr_" + grants.length }); },
    end: async (/** @type {any} */ q) => { for (let i = grants.length - 1; i >= 0; i--) if (grants[i].source === q.source) grants.splice(i, 1); },
    list: async (/** @type {any} */ q) => grants.filter(g => g.source.startsWith(q.source)),
  };
  const kernel = { space: "spc_x", mint, chain: async () => ({ hops: [] }), grants: { members: { list: async () => [{ person: BOB, name: "Bob", role: "member" }] }, teams: { list: async () => [{ id: TEAM, name: "Billing" }] } } };
  const reg = /** @type {Map<string, any>} */ (new Map());
  const audit = /** @type {any[]} */ ([]);
  const ctx = { kernel, call: async (/** @type {string} */ t, /** @type {any} */ i) => (t === "agents.uid" && i.name === "kit" ? { data: { uid: KIT } } : { error: { code: "not_found" } }) };
  const vault = { row: (/** @type {string} */ n) => (n === "stripe" ? { name: n } : undefined), access: { urn: async (/** @type {string} */ n) => `vyre://spc_x/vault/v1/item/${n}` }, audit: (/** @type {any[]} */ ...a) => audit.push(a) };
  register({ ctx, vault: /** @type {any} */ (vault), tool: (n, callers, d, i, run) => reg.set(n, { callers, run }) });
  return { grants, reg, audit, call: (/** @type {string} */ n, /** @type {any} */ i) => reg.get(n).run(i, {}) };
}

test("share Fill in, then Read, then Edit and rotate, then take it away: one grant at a time, the kernel's actions, on the item's address", async () => {
  const { call, grants } = rig();
  await call("vault.access.set", { name: "stripe", kind: "person", subject: BOB, level: "use" });
  assert.equal(grants.length, 1);
  assert.deepEqual(grants[0].actions, [...ACCESS_LEVELS.use]);
  assert.equal(grants[0].resource.prefix, "vyre://spc_x/vault/v1/item/stripe");
  assert.equal(grants[0].source, sourceOf("stripe", BOB));
  assert.deepEqual(grants[0].subject.actor, { kind: "person", id: BOB, space: "spc_x" });
  await call("vault.access.set", { name: "stripe", kind: "person", subject: BOB, level: "reveal" });
  assert.deepEqual(grants[0].actions, [...ACCESS_LEVELS.reveal]);
  await call("vault.access.set", { name: "stripe", kind: "person", subject: BOB, level: "edit" });
  assert.equal(grants.length, 1, "sharing again replaces, never doubles");
  assert.deepEqual(grants[0].actions, [...ACCESS_LEVELS.edit]);
  assert.ok(grants[0].actions.includes("vault.rotate") && !grants[0].actions.includes("vault.delete") && !grants[0].actions.includes("vault.share"), "Edit and rotate does not carry delete or share");
  const got = await call("vault.access.get", { name: "stripe" });
  assert.deepEqual(got.access, [{ kind: "person", subject: BOB, level: "edit" }]);
  assert.equal(got.people[0].id, BOB); assert.deepEqual(got.levels, ["use", "reveal", "edit"]); assert.equal(got.teams[0].id, TEAM);
  await call("vault.access.set", { name: "stripe", kind: "person", subject: BOB, level: null });
  assert.equal(grants.length, 0);
});

test("a team and an agent are grantees too: a group subject for a team, the agent's stable id for an agent, and an agent only ever gets Fill in", async () => {
  const { call, grants } = rig();
  await call("vault.access.set", { name: "stripe", kind: "team", subject: TEAM, level: "reveal" });
  assert.deepEqual(grants[0].subject, { kind: "group", id: TEAM });
  assert.deepEqual(grants[0].actions, [...ACCESS_LEVELS.reveal]);
  await call("vault.access.set", { name: "stripe", kind: "agent", subject: "kit", level: "use" });
  assert.deepEqual(grants[1].subject.actor, { kind: "agent", id: KIT, space: "spc_x" });
  assert.equal(grants[1].source, sourceOf("stripe", KIT));
  assert.deepEqual((await call("vault.access.get", { name: "stripe" })).access, [{ kind: "team", subject: TEAM, level: "reveal" }, { kind: "agent", subject: KIT, level: "use" }]);
  for (const level of ["reveal", "edit"]) await assert.rejects(call("vault.access.set", { name: "stripe", kind: "agent", subject: "kit", level }), /agent can only be given use/, level);
  await assert.rejects(call("vault.access.set", { name: "stripe", kind: "agent", subject: "ghost", level: "use" }), /no agent has that name/);
  await assert.rejects(call("vault.access.set", { name: "stripe", kind: "team", subject: "team_none", level: "use" }), /no team/);
  await call("vault.access.set", { name: "stripe", kind: "agent", subject: "kit", level: null });
  await call("vault.access.set", { name: "stripe", kind: "team", subject: TEAM, level: null });
  assert.equal(grants.length, 0);
});

test("a grant made before the kernel's levels (vault.use, vault.edit) still reads as Fill in or Edit", async () => {
  const { call, grants } = rig();
  grants.push({ id: "old1", source: sourceOf("stripe", BOB), subject: { kind: "actor", actor: { kind: "person", id: BOB, space: "spc_x" } }, actions: ["vault.use"] });
  assert.deepEqual((await call("vault.access.get", { name: "stripe" })).access, [{ kind: "person", subject: BOB, level: "use" }]);
  grants[0].actions = ["vault.use", "vault.edit"];
  assert.equal((await call("vault.access.get", { name: "stripe" })).access[0].level, "edit");
});

test("refusals: no such item, a bad kind, id or level; owner surfaces only, no module or model caller", async () => {
  const { call, reg } = rig();
  await assert.rejects(call("vault.access.set", { name: "nope", kind: "person", subject: BOB, level: "use" }), /no item/);
  await assert.rejects(call("vault.access.set", { name: "stripe", kind: "role", subject: "admin", level: "use" }), /person, a team or an agent/);
  await assert.rejects(call("vault.access.set", { name: "stripe", kind: "person", subject: "../x y", level: "use" }), /person/);
  for (const level of ["root", "manage"]) await assert.rejects(call("vault.access.set", { name: "stripe", kind: "person", subject: BOB, level }), /level/, level);
  await assert.rejects(call("vault.access.set", { name: "stripe", kind: "person", subject: "per_" + "z".repeat(26), level: "use" }), /not a member/);
  for (const n of ["vault.access.get", "vault.access.set"]) for (const c of ["module", "mcp", "harness", "device", "mobile"]) assert.ok(!reg.get(n).callers.includes(c), `${n} not for ${c}`);
});

test("sharing is audited without a value", async () => {
  const { call, audit } = rig();
  await call("vault.access.set", { name: "stripe", kind: "person", subject: BOB, level: "edit" });
  assert.equal(audit[0][0], "share");
  assert.match(audit[0][4], /^person:per_b+ \(edit\)$/);
  assert.ok(!JSON.stringify(audit).includes("secret"));
});

test("a grant for someone who left can still be taken away, and a kernel that cannot list members refuses a new one", async () => {
  const { call, grants } = rig();
  await call("vault.access.set", { name: "stripe", kind: "person", subject: BOB, level: "use" });
  const gone = rig();
  await gone.call("vault.access.set", { name: "stripe", kind: "person", subject: "per_" + "z".repeat(26), level: null });
  assert.equal(grants.length, 1);
  const blind = /** @type {Map<string, any>} */ (new Map());
  register({ ctx: { kernel: { space: "spc_x", mint: { make: async () => {}, end: async () => {}, list: async () => [] }, chain: async () => { throw new Error("no"); } } }, vault: /** @type {any} */ ({ row: () => ({}), access: { urn: async () => "vyre://spc_x/vault/v1/item/stripe" }, audit: () => {} }), tool: (n, callers, d, i, run) => blind.set(n, run) });
  await assert.rejects(blind.get("vault.access.set")({ name: "stripe", kind: "person", subject: BOB, level: "use" }, {}), /not a member/);
  await assert.rejects(blind.get("vault.access.set")({ name: "stripe", kind: "team", subject: TEAM, level: "use" }, {}), /no team/);
});
