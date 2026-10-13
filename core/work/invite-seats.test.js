// @ts-check
// An invite that names projects: the joiner is put on each at the level chosen, by the one seat-giving path (hub.setSeatLevel). A replay (a restart re-delivers invite.used) leaves an existing seat as it is, even
// one an admin has edited since, and gives no second seat.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCRATCH } from "../../test/scratch.mjs";
import { bootKernel } from "../../kernel/boot.js";
import { PROJECT, TEAM_MEMBER } from "../../records/core-types.js";
import { createHub } from "./hub.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", NEW = "per_new";
async function rig() {
  const db = new DatabaseSync(path.join(fs.mkdtempSync(path.join(SCRATCH, "vyre-invseat-")), "kernel.db"));
  const k = await bootKernel({ db, space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presenceCheck: async () => null });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });
  await k.gateway.records.define(owner, { add_types: [PROJECT, TEAM_MEMBER] });
  const hub = createHub({ kernel: { space: SPACE, owner: OWNER, serviceChain: () => owner, records: k.gateway.records }, call: async () => ({ data: null }) });
  const x = await hub.createProject(owner, { name: "Project X" }), y = await hub.createProject(owner, { name: "Project Y" });
  const seats = async (/** @type {string} */ p) => { const r = await hub.seatOf(p, NEW); return r && r.team ? r.level : null; };
  return { k, owner, hub, x, y, seats };
}

test("a joiner is seated on the invite's project at its level and on no other project", async () => {
  const { hub, owner, x, y, seats } = await rig();
  const r = await hub.setSeatLevel(owner, { project: x.id, person: NEW, level: "viewer", keep: true });
  assert.equal(r.seated, true);
  assert.equal(await seats(x.id), "viewer");
  assert.equal(await seats(y.id), null, "nothing else");
});

test("a replay gives no second seat and never undoes a level an admin changed since", async () => {
  const { k, hub, owner, x, seats } = await rig();
  await hub.setSeatLevel(owner, { project: x.id, person: NEW, level: "viewer", keep: true });
  await hub.setSeatLevel(owner, { project: x.id, person: NEW, level: "lead" });
  const again = await hub.setSeatLevel(owner, { project: x.id, person: NEW, level: "viewer", keep: true });
  assert.equal(again.kept, true);
  assert.equal(await seats(x.id), "lead", "the admin's edit stands");
  const rows = (await k.gateway.records.query(owner, "team-member", { page: { limit: 50 } })).rows.filter((/** @type {any} */ r) => r.data.actor && r.data.actor.actor.id === NEW);
  assert.equal(rows.length, 1, "one seat");
});

test("a project that is gone answers null, so the work module can say 'not added' loudly", async () => {
  const { hub, owner } = await rig();
  assert.equal(await hub.setSeatLevel(owner, { project: "no-such-project", person: NEW, level: "contributor", keep: true }), null);
});
