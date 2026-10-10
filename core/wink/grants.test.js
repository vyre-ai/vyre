// @ts-check
// Wink's grants are the kernel's (core/wink/grants.js): a create goes through the mint handle in the kernel's own Space, a revoke ends it, a list shows the live ones, and the first start after the update
// carries the old tables' active rows over once (a member's address narrows, a storage device's grant id follows, an older device grant becomes a registry row).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createGrants, moveLocalGrants, MIGRATIONS, checkGrantInput } from "./grants.js";
import { GRANT_MIGRATIONS } from "./storage/grants.js";
import { fakeMint } from "../../test/fake-chain-kernel.js";

const SPACE = "spc_aaaaaaaaaaaa", HOME = "spc_wwwwwwwwwwww";
const person = (/** @type {string} */ id, space = HOME) => ({ kind: "actor", actor: { kind: "person", id, space } });
const input = { subject: person("per_dana"), actions: ["member.act"], resource: { prefix: `vyre://${HOME}/member/per_dana` }, conditions: {}, source: "wink:W5", reason: "Dana, A1 B2, member" };

function world() {
  const mint = fakeMint();
  const ctx = { kernel: { mint, space: SPACE }, store: { db: new DatabaseSync(":memory:") }, log() {} };
  for (const sql of [...MIGRATIONS, ...GRANT_MIGRATIONS, "CREATE TABLE wink_storage_devices (id TEXT PRIMARY KEY, grant_id TEXT)"]) ctx.store.db.exec(sql);
  return { mint, ctx, db: ctx.store.db };
}
const put = (/** @type {any} */ db, /** @type {string} */ table, /** @type {any} */ g, status = "active") => table === "wink_grants"
  ? db.prepare("INSERT INTO wink_grants (id, status, source, subject_key, resource_prefix, body, created_at) VALUES (?,?,?,?,?,?,?)").run(g.id, status, g.source, "k", g.resource.prefix, JSON.stringify(g), 1)
  : db.prepare("INSERT INTO wink_storage_grants (id, status, body) VALUES (?,?,?)").run(g.id, status, JSON.stringify(g));

test("create goes through the kernel in its own Space; get and list show it; revoke ends it and a second revoke is the same", async () => {
  const { ctx, mint } = world();
  const g = createGrants({ ctx });
  const made = await g.create(input);
  assert.equal(made.resource.prefix, `vyre://${SPACE}/member/per_dana`, "the address says the kernel's Space, not Wink's stand-in");
  assert.equal(made.subject.actor.space, SPACE);
  assert.equal((await g.get(made.id)).source, "wink:W5");
  assert.equal((await g.list({ source: "wink:" })).length, 1);
  assert.equal((await g.list({ source: "wink:W4" })).length, 0);
  assert.deepEqual(await g.list({ status: "revoked" }), [], "the kernel's list is the live grants; the log keeps what was taken back");
  await g.revoke(made.id, "removed by the owner");
  await g.revoke(made.id, "removed by the owner");
  assert.equal(await g.get(made.id), null);
  assert.equal(mint.made.get(made.id).status, "revoked");
});

test("a server with no kernel says so plainly and writes nothing; an input the contract does not allow is bad_input", async () => {
  const g = createGrants({ ctx: { store: { db: new DatabaseSync(":memory:") } } });
  await assert.rejects(() => g.create(input), { code: "unavailable", message: /no kernel/ });
  assert.throws(() => checkGrantInput({ ...input, source: "other:1" }), { code: "bad_input" });
});

test("the first start after the update moves the active rows over once: members narrow, a storage device follows its grant, an old device grant becomes a registry row, revoked rows go", async () => {
  const { ctx, mint, db } = world();
  put(db, "wink_grants", { id: "gr_old_member", subject: person("per_dana"), actions: ["member.act"], resource: { prefix: `vyre://${HOME}/` }, conditions: {}, source: "wink:W5", reason: "Dana, A1 B2, member" });
  put(db, "wink_grants", { id: "gr_old_share", subject: person("per_alex"), actions: ["node.host"], resource: { prefix: `vyre://${HOME}/node/dev_a/` }, conditions: { budget: { meter: "node.cpu-hours-day", limit: 2 } }, source: "wink:W4", reason: "shared with limits" });
  put(db, "wink_grants", { id: "gr_old_device", subject: { kind: "actor", actor: { kind: "device", id: "dev_old", space: HOME } }, actions: ["space.act"], resource: { prefix: `vyre://${HOME}/` }, conditions: {}, source: "wink:W2", reason: "Old laptop, A1 B2" });
  put(db, "wink_grants", { id: "gr_gone", subject: person("per_sam"), actions: ["member.act"], resource: { prefix: `vyre://${HOME}/` }, conditions: {}, source: "wink:W5" }, "revoked");
  put(db, "wink_storage_grants", { id: "gr_old_store", subject: { kind: "actor", actor: { kind: "device", id: "dev_s", space: HOME } }, actions: ["storage.hold"], resource: { prefix: `vyre://${HOME}/storage/sto_1/` }, conditions: {}, source: "wink:W3", reason: "Office drive, storage" });
  db.prepare("INSERT INTO wink_storage_devices (id, grant_id) VALUES ('sto_1', 'gr_old_store')").run();
  const adopted = /** @type {any[]} */ ([]);
  const moved = await moveLocalGrants({ ctx, adoptDevice: x => adopted.push(x) });
  assert.equal(moved, 3);
  assert.deepEqual(adopted.map(x => x.subject.actor.id), ["dev_old"]);
  const live = [...mint.made.values()];
  assert.deepEqual(live.map(g => g.source).sort(), ["wink:W3", "wink:W4", "wink:W5"]);
  const member = live.find(g => g.source === "wink:W5");
  assert.equal(member.resource.prefix, `vyre://${SPACE}/member/per_dana`);
  assert.equal(member.subject.actor.space, SPACE);
  const newStoreGrant = live.find(g => g.source === "wink:W3");
  assert.equal(db.prepare("SELECT grant_id FROM wink_storage_devices WHERE id = 'sto_1'").get().grant_id, newStoreGrant.id, "the device row follows its grant");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wink_grants").get().n + db.prepare("SELECT COUNT(*) AS n FROM wink_storage_grants").get().n, 0, "the old tables are empty");
  assert.equal(await moveLocalGrants({ ctx, adoptDevice: () => assert.fail("nothing is left to adopt") }), 0, "twice is the same as once");
  assert.equal(mint.made.size, 3);
});

test("a server with no kernel keeps the old rows where they are", async () => {
  const { db } = world();
  put(db, "wink_grants", { id: "gr_old_member", subject: person("per_dana"), actions: ["member.act"], resource: { prefix: `vyre://${HOME}/` }, conditions: {}, source: "wink:W5" });
  await assert.rejects(() => moveLocalGrants({ ctx: { store: { db } }, adoptDevice: () => {} }), { code: "unavailable" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wink_grants").get().n, 1);
});

test("a stop between making a grant and deleting its row does not make the grant twice at the next try", async () => {
  const { ctx, mint, db } = world();
  put(db, "wink_grants", { id: "gr_old_member", subject: person("per_dana"), actions: ["member.act"], resource: { prefix: `vyre://${HOME}/` }, conditions: {}, source: "wink:W5", reason: "Dana, A1 B2, member" });
  await moveLocalGrants({ ctx, adoptDevice: () => {} });
  assert.equal(mint.made.size, 1);
  put(db, "wink_grants", { id: "gr_old_member", subject: person("per_dana"), actions: ["member.act"], resource: { prefix: `vyre://${HOME}/` }, conditions: {}, source: "wink:W5", reason: "Dana, A1 B2, member" }); // the row that was not deleted
  assert.equal(await moveLocalGrants({ ctx, adoptDevice: () => {} }), 1, "the row goes");
  assert.equal(mint.made.size, 1, "and no second grant is made");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wink_grants").get().n, 0);
});
