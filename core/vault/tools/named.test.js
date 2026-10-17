// @ts-check
// Named vaults inside a Space (vault.named.*): a vault is a kernel record with an owner; an item sits in one (the `named` column, signed with the row), its address follows the vault, and sharing a whole
// vault is one grant on the vault's address for a person, a team, an agent, or everyone in the Space (space:people at the chosen level, space:agents at Fill in). Only the owner's surfaces; the kernel decides
// who may make or remove a vault.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { register, vsource } from "./named.js";
import { ACCESS_LEVELS } from "../../../kernel/seal/uses.js";
import { macExtra, NAMED_MIGRATION } from "../access.js";

const BOB = "per_bob", KIT = "agt_kit", TEAM = "team_aaaa";

function rig() {
  /** @type {any[]} */ const grants = [], taken = [];
  const vaults = [{ id: "vault_acme", name: "Acme", owner: "per_owner", personal: false }];
  const mint = {
    make: async (/** @type {any} */ g) => { grants.push({ ...g, id: "gr_" + grants.length }); },
    end: async (/** @type {any} */ q) => { for (let i = grants.length - 1; i >= 0; i--) if (grants[i].source === q.source) grants.splice(i, 1); },
    list: async (/** @type {any} */ q) => grants.filter(g => g.source.startsWith(q.source)),
  };
  const kernel = { space: "spc_x", chain: async () => ({ hops: [] }),
    grants: { members: { list: async () => [{ person: BOB, name: "Bob" }] }, teams: { list: async () => [{ id: TEAM, name: "Billing" }] },
      vaults: { list: () => vaults, set: async (/** @type {any} */ _c, /** @type {any} */ v) => { const r = { id: "vault_" + v.name.toLowerCase(), name: v.name, owner: "per_owner", personal: false }; vaults.push(r); return r; }, remove: async (/** @type {any} */ _c, /** @type {string} */ id) => { vaults.splice(vaults.findIndex(v => v.id === id), 1); return { removed: id }; } } },
    vault: { takeBack: async (/** @type {any} */ q) => { taken.push(q); return []; } }, mint };
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE vault_items (id TEXT PRIMARY KEY, name TEXT UNIQUE, kind TEXT, mac TEXT);"); db.exec(NAMED_MIGRATION);
  db.prepare("INSERT INTO vault_items (id, name, kind) VALUES ('i1','stripe','api-key'), ('i2','gmail','login')").run();
  const signed = /** @type {string[]} */ ([]);
  const vault = { db, row: (/** @type {string} */ n) => db.prepare("SELECT * FROM vault_items WHERE name = ?").get(n), sign: (/** @type {string} */ t, /** @type {string} */ id) => signed.push(`${t}:${id}`), audit: () => {}, list: () => ({ items: db.prepare("SELECT * FROM vault_items").all() }),
    access: { urn: async (/** @type {string} */ n) => { const r = /** @type {any} */ (db.prepare("SELECT * FROM vault_items WHERE name = ?").get(n)); return `vyre://spc_x/vault/${r && r.named ? r.named : "vault_personal"}/item/${n}`; } } };
  const reg = /** @type {Map<string, any>} */ (new Map());
  const ctx = { kernel, log: () => {}, call: async (/** @type {string} */ t, /** @type {any} */ i) => (t === "agents.uid" && i.name === "kit" ? { data: { uid: KIT } } : { error: { code: "not_found" } }) };
  register({ ctx, vault: /** @type {any} */ (vault), tool: (n, callers, d, i, run) => reg.set(n, { callers, run }) });
  return { grants, taken, signed, vaults, db, reg, call: (/** @type {string} */ n, /** @type {any} */ i) => reg.get(n).run(i, {}) };
}

test("a named vault is made, listed with what is in it and who holds it, and removed only when empty", async () => {
  const { call, vaults, db } = rig();
  const made = await call("vault.named.create", { name: "Marketing" });
  assert.equal(made.vault.id, "vault_marketing");
  assert.deepEqual((await call("vault.named.list", {})).vaults.map((/** @type {any} */ v) => [v.name, v.items]), [["Acme", 0], ["Marketing", 0]]);
  await call("vault.named.move", { item: "stripe", vault: "vault_marketing" });
  assert.equal((await call("vault.named.list", {})).vaults.find((/** @type {any} */ v) => v.id === "vault_marketing").items, 1);
  await assert.rejects(call("vault.named.remove", { id: "vault_marketing" }), /not empty/);
  await call("vault.named.move", { item: "stripe", vault: null });
  assert.equal((await call("vault.named.remove", { id: "vault_marketing" })).removed, "vault_marketing");
  assert.equal(vaults.length, 1); void db;
});

test("moving an item ends what was shared on its old address, signs the row, and the new address follows the vault", async () => {
  const { call, taken, signed, db } = rig();
  await call("vault.named.move", { item: "stripe", vault: "vault_acme" });
  assert.deepEqual(taken, [{ prefix: "vyre://spc_x/vault/vault_personal/item/stripe", reason: "the item moved to another vault" }]);
  assert.deepEqual(signed, ["vault_items:i1"]);
  assert.equal(/** @type {any} */ (db.prepare("SELECT named FROM vault_items WHERE name='stripe'").get()).named, "vault_acme");
  await assert.rejects(call("vault.named.move", { item: "stripe", vault: "vault_nope" }), /no vault/);
  await assert.rejects(call("vault.named.move", { item: "ghost", vault: "vault_acme" }), /no item/);
});

test("the row's signature covers the vault link only when there is one, so rows from before keep theirs and a tampered link shows", () => {
  assert.deepEqual(macExtra("vault_items", { named: null }), {});
  assert.deepEqual(macExtra("vault_items", { named: "vault_acme" }), { named: "vault_acme" });
  assert.deepEqual(macExtra("vault_grants", { named: "x" }), {});
});

test("share a whole vault with a person, a team or an agent at the kernel's levels; an agent only Fill in", async () => {
  const { call, grants } = rig();
  await call("vault.named.access.set", { vault: "vault_acme", kind: "person", subject: BOB, level: "edit" });
  await call("vault.named.access.set", { vault: "vault_acme", kind: "team", subject: TEAM, level: "reveal" });
  await call("vault.named.access.set", { vault: "vault_acme", kind: "agent", subject: "kit", level: "use" });
  assert.equal(grants.length, 3);
  for (const g of grants) assert.equal(g.resource.prefix, "vyre://spc_x/vault/vault_acme");
  assert.deepEqual(grants[0].actions, [...ACCESS_LEVELS.edit]); assert.deepEqual(grants[1].actions, [...ACCESS_LEVELS.reveal]);
  assert.deepEqual(grants[1].subject, { kind: "group", id: TEAM });
  await assert.rejects(call("vault.named.access.set", { vault: "vault_acme", kind: "agent", subject: "kit", level: "reveal" }), /Fill in/);
  await call("vault.named.access.set", { vault: "vault_acme", kind: "person", subject: BOB, level: null });
  assert.equal(grants.length, 2);
  assert.deepEqual((await call("vault.named.access.get", { vault: "vault_acme" })).access.map((/** @type {any} */ a) => a.kind).sort(), ["agent", "team"]);
});

test("everyone in the Space: every member at the chosen level and every agent at Fill in, two grants that go together", async () => {
  const { call, grants } = rig();
  await call("vault.named.access.set", { vault: "vault_acme", kind: "everyone", subject: "everyone", level: "reveal" });
  assert.deepEqual(grants.map(g => g.subject), [{ kind: "group", id: "space:people" }, { kind: "group", id: "space:agents" }]);
  assert.deepEqual(grants[0].actions, [...ACCESS_LEVELS.reveal]); assert.deepEqual(grants[1].actions, [...ACCESS_LEVELS.use]);
  assert.deepEqual((await call("vault.named.access.get", { vault: "vault_acme" })).access, [{ kind: "everyone", subject: "everyone", level: "reveal" }]);
  await call("vault.named.access.set", { vault: "vault_acme", kind: "everyone", subject: "everyone", level: null });
  assert.equal(grants.length, 0);
  assert.equal(vsource("vault_acme", "x"), "vault:vshare:vault_acme:x");
});

test("refusals: a vault that does not exist, a bad kind or level, the manage level, people who are not members; owner surfaces only", async () => {
  const { call, reg } = rig();
  await assert.rejects(call("vault.named.access.set", { vault: "vault_nope", kind: "person", subject: BOB, level: "use" }), /no vault/);
  await assert.rejects(call("vault.named.access.set", { vault: "vault_acme", kind: "role", subject: "admin", level: "use" }), /person, a team, an agent/);
  for (const level of ["manage", "root"]) await assert.rejects(call("vault.named.access.set", { vault: "vault_acme", kind: "person", subject: BOB, level }), /level/);
  await assert.rejects(call("vault.named.access.set", { vault: "vault_acme", kind: "person", subject: "per_zzz", level: "use" }), /not a member/);
  for (const n of ["vault.named.create", "vault.named.list", "vault.named.move", "vault.named.remove", "vault.named.access.get", "vault.named.access.set"]) for (const c of ["module", "mcp", "harness", "device", "mobile"]) assert.ok(!reg.get(n).callers.includes(c), `${n} not for ${c}`);
});
