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
  assert.equal((await k.gateway.records.query(o, "project", { page: { limit: 10 } })).rows.length, 1, "no refusal: records answer");
});

test("on Basic, records.define of a custom type answers: Custom types need a Cloud space", async () => {
  const k = await boot({ basic: { allow: basicAllow(), refusal: BASIC_REFUSAL } });
  const o = owner(k);
  await assert.rejects(() => k.gateway.records.define(o, { add_types: [CONTACT] }), e => e.code === "cloud_required" && e.message === "Custom types need a Cloud space.");
  await assert.rejects(() => k.gateway.records.define(o, { add_types: [PROJECT, { ...CONTACT, name: "matter" }] }), e => e.code === "cloud_required");
  for (const n of ["def-flow", "flow-run", "def-role", "def-view", "template"]) await assert.rejects(() => k.gateway.records.define(o, { add_types: [{ ...CONTACT, name: n }] }), e => e.code === "cloud_required", `${n} needs a server`);
  for (const n of ["task", "reminder", "note"]) await assert.rejects(() => k.gateway.records.define(o, { add_types: [{ ...CONTACT, name: n }] }), e => e.code === "cloud_required", `${n} needs a server`);
  await k.gateway.records.define(o, { add_types: [PROJECT] });
  await assert.rejects(() => k.gateway.records.define(o, { change_types: [{ ...CONTACT, name: "invoice" }] }), e => e.code === "cloud_required");
  await assert.rejects(() => k.gateway.records.define(o, { remove_types: ["contact"] }), e => e.code === "cloud_required");
});

test("a server or a development build has no such limit", async () => {
  const k = await boot();
  const o = owner(k);
  await k.gateway.records.define(o, { add_types: [CONTACT] });
  assert.equal((await k.gateway.records.create(o, "contact", { name: "Jane" })).data.name, "Jane");
});

test("a module's own types are held to the same list on Basic: not made, and its calls answer the Cloud line", async () => {
  const GOAL = { name: "goal", label: "Goal", fields: [{ name: "title", kind: "text", label: "Title" }] };
  const PROJ = { name: "project", label: "Project", fields: [{ name: "body", kind: "text", label: "Body" }] };
  const mod = { name: "goals", needs: { kernel: { actions: [], types: [GOAL, PROJ] } } };
  const basic = await boot({ basic: { allow: basicAllow(), refusal: BASIC_REFUSAL } });
  const kb = basic.kernelFor(mod);
  await new Promise(r => setTimeout(r, 50));
  const o = owner(basic);
  const names = (await basic.store.types()).map(t => t.name);
  assert.deepEqual(names.filter(n => n === "goal" || n === "project").sort(), ["project"], "only the allowed type of the module exists");
  await assert.rejects(() => basic.gateway.records.create(o, "goal", { title: "x" }), e => e.code === "cloud_required" && e.message === "Custom types need a Cloud space.");
  void kb;
  const dev = await boot();
  dev.kernelFor(mod);
  await new Promise(r => setTimeout(r, 50));
  assert.ok((await dev.store.types()).some(t => t.name === "goal"), "a server or a development build makes every declared type");
});
