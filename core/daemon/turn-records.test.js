// @ts-check
// A chat turn's record picks are read under the asker's own chain; a team Space's chat and a missing chain tag nothing.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../../kernel/index.js";
import { turnRecordTags } from "./turn-records.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob";
const TYPE = { name: "client", label: "Client", fields: [{ name: "name", kind: "text", label: "Name", required: true }] };

async function rig() {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 4) });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });
  await k.gateway.records.define(owner, { add_types: [TYPE] });
  const rec = await k.gateway.records.create(owner, "client", { name: "Jane Harlow" });
  const personChainFor = async (/** @type {string} */ person) => k.chains.fromFacts({ kind: "device", device_key_id: "vyred", person, path: "direct" });
  return { k, rec, tags: turnRecordTags({ kernel: { id: { space: SPACE }, gateway: k.gateway }, personChainFor }) };
}

test("the owner's pick is tagged under the owner's chain; a person who is not a member of the Space gets nothing", async () => {
  const { rec, tags } = await rig();
  assert.deepEqual((await tags({ asker: OWNER, chips: [{ kind: "record", id: rec.urn }] })).tags.map((/** @type {any} */ t) => t.id), [rec.urn]);
  assert.deepEqual((await tags({ asker: BOB, chips: [{ kind: "record", id: rec.urn }] })).tags, []);
});

test("another Space's chat, and a missing asker, tag nothing; other chips pass through to their providers", async () => {
  const { rec, tags } = await rig();
  assert.deepEqual((await tags({ asker: OWNER, space: "spc_bbbbbbbbbbbb", chips: [{ kind: "record", id: rec.urn }] })).tags, []);
  assert.deepEqual((await tags({ asker: "", chips: [{ kind: "record", id: rec.urn }] })).tags, []);
  assert.deepEqual((await tags({ asker: OWNER, chips: [{ kind: "vault", id: "x" }] })).chips, [{ kind: "vault", id: "x" }]);
});
