import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCRATCH } from "../../test/scratch.mjs";
import { bootKernel } from "../boot.js";
import { basicAllow, BASIC_REFUSAL, BASIC_TYPES } from "../../records/basic-types.js";
import { CONTACT } from "../conformance/suite.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
const sealer = { presenceCheck: async () => null };
const PROJECT = { name: "project", label: "Project", fields: [{ name: "body", kind: "text", label: "Body" }] };

const boot = (over = {}) => bootKernel({ db: new DatabaseSync(path.join(fs.mkdtempSync(path.join(SCRATCH, "vyre-basic-")), "kernel.db")), space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), sealer, ...over });
const owner = k => k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });

test("a Basic device boots on its own store with no Records refusal, and keeps the fixed personal types (project and chat-record)", async () => {
  const k = await boot({ basic: { allow: basicAllow(), refusal: BASIC_REFUSAL } });
  const o = owner(k);
  assert.deepEqual([...BASIC_TYPES], ["project", "chat-record"]);
  await k.gateway.records.define(o, { add_types: [PROJECT] });
  const made = await k.gateway.records.create(o, "project", { body: "buy milk" });
  assert.equal(made.data.body, "buy milk");
  assert.equal((await k.gateway.records.query(o, "project", {})).rows.length, 1, "no refusal: records answer");
});

test("on Basic, records.define of a custom type answers: Custom types need your own server (Pro)", async () => {
  const k = await boot({ basic: { allow: basicAllow(), refusal: BASIC_REFUSAL } });
  const o = owner(k);
  await assert.rejects(() => k.gateway.records.define(o, { add_types: [CONTACT] }), e => e.code === "pro_required" && e.message === "Custom types need your own server (Pro).");
  await assert.rejects(() => k.gateway.records.define(o, { add_types: [PROJECT, { ...CONTACT, name: "matter" }] }), e => e.code === "pro_required");
  for (const n of ["task", "reminder", "note"]) await assert.rejects(() => k.gateway.records.define(o, { add_types: [{ ...CONTACT, name: n }] }), e => e.code === "pro_required", `${n} needs a server`);
  await k.gateway.records.define(o, { add_types: [PROJECT] });
  await assert.rejects(() => k.gateway.records.define(o, { change_types: [{ ...CONTACT, name: "invoice" }] }), e => e.code === "pro_required");
  await assert.rejects(() => k.gateway.records.define(o, { remove_types: ["contact"] }), e => e.code === "pro_required");
});

test("a server or a development build has no such limit", async () => {
  const k = await boot();
  const o = owner(k);
  await k.gateway.records.define(o, { add_types: [CONTACT] });
  assert.equal((await k.gateway.records.create(o, "contact", { name: "Jane" })).data.name, "Jane");
});
