// @ts-check
// Two defines on one Twenty store never run at once: Twenty answers the second with a lock timeout (55P03) while the first is still adding fields (J6).
import "../../scripts/mac-test-guard.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SCRATCH } from "../../test/scratch.mjs";
import { createTwentyStore } from "./store.js";
import { TwentyClient } from "./client.js";
import { FakeTwenty } from "./testing/fake-twenty.js";

const fake = new FakeTwenty(); await fake.start();
after(() => fake.stop());

const type = (/** @type {string} */ name) => ({ name, label: name, fields: [{ name: "a", kind: "text", label: "A" }, { name: "b", kind: "text", label: "B" }] });

test("defines made at the same time on one store run one after the other", async () => {
  fake.reset();
  const dir = fs.mkdtempSync(path.join(SCRATCH, "ds-"));
  const store = createTwentyStore({ client: new TwentyClient({ url: fake.url, key: () => fake.key, sleep: async () => {} }), space: "spc_cccccccccccc", dir, webhookSecret: crypto.randomBytes(16).toString("hex"), graceMs: 0 });
  const gql = store.client.gql.bind(store.client);
  let inflight = 0, most = 0;
  store.client.gql = async (/** @type {any[]} */ ...a) => { inflight++; most = Math.max(most, inflight); await new Promise(r => setTimeout(r, 2)); try { return await gql(...a); } finally { inflight--; } };
  // the defines overlap only if two of them are inside a Twenty call together
  const started = [];
  const all = await Promise.all(["alpha", "beta", "gamma"].map(async n => { started.push(n); return store.define({ add_types: [type(n)] }); }));
  assert.equal(all.length, 3);
  assert.equal(most, 1, "never two Twenty calls from two defines at once");
  assert.deepEqual((await store.types()).map((/** @type {any} */ t) => t.name).sort(), ["alpha", "beta", "gamma"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the mirror columns of a type are made once when several callers ask at the same time (the duplicate-field migration J1 hit)", async () => {
  fake.reset();
  const dir = fs.mkdtempSync(path.join(SCRATCH, "ds-"));
  const store = createTwentyStore({ client: new TwentyClient({ url: fake.url, key: () => fake.key, sleep: async () => {} }), space: "spc_cccccccccccc", dir, webhookSecret: crypto.randomBytes(16).toString("hex"), graceMs: 0 });
  await store.define({ add_types: [type("delta")] });
  const gql = store.client.gql.bind(store.client);
  const made = [];
  store.client.gql = async (/** @type {string} */ api, /** @type {string} */ q, /** @type {any} */ v) => { if (/createOneField/.test(q) && v?.i?.field?.name === "vyreProject") made.push(v.i.field.name); await new Promise(r => setTimeout(r, 3)); return gql(api, q, v); };
  await Promise.all([store.prepare(), store.prepare(), store.prepare()]);
  assert.ok(made.length <= 1, `the column was asked for ${made.length} times`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a write answers with the empty text it was given, though Twenty keeps an empty text as no value (store_disagreed on a chat's empty agents)", async () => {
  fake.reset();
  const dir = fs.mkdtempSync(path.join(SCRATCH, "ds-"));
  const store = createTwentyStore({ client: new TwentyClient({ url: fake.url, key: () => fake.key, sleep: async () => {} }), space: "spc_cccccccccccc", dir, webhookSecret: crypto.randomBytes(16).toString("hex"), graceMs: 0 });
  await store.define({ add_types: [type("eps")] });
  const id = (await import("../../kernel/core/ids.js")).mintUuid(Date.now());
  const made = await store.create("eps", id, { a: "x", b: "" });
  assert.equal(made.data.b, "", "the answer to the create says what was written");
  const upd = await store.update("eps", id, { a: "" }, made.version);
  assert.equal(upd.data.a, "");
  assert.equal((await store.get("eps", id)).data.b, undefined, "a read says what Twenty holds");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a define leaves one log line naming its types, their fields and the seconds it took (a slow first call names its cause)", async () => {
  fake.reset();
  const dir = fs.mkdtempSync(path.join(SCRATCH, "ds-"));
  const lines = /** @type {string[]} */ ([]);
  const store = createTwentyStore({ client: new TwentyClient({ url: fake.url, key: () => fake.key, sleep: async () => {} }), space: "spc_cccccccccccc", dir, webhookSecret: crypto.randomBytes(16).toString("hex"), graceMs: 1, log: l => lines.push(l) });
  await store.define({ add_types: [type("alpha"), type("beta")] });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^store define: alpha, beta \(4 fields\) took \d+\.\d s$/);
  const { defineLine } = await import("./store.js");
  assert.equal(defineLine({ change_types: [type("gamma")] }, 31_240), "store define: gamma (2 fields) took 31.2 s");
  assert.equal(defineLine({ remove_types: ["x"] }, 400), "store define: no types (0 fields) took 0.4 s");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a new type's mirror columns are made by the define, so the first write to it makes no schema change (a member's first chat waited ~20 s for them)", async () => {
  fake.reset();
  const dir = fs.mkdtempSync(path.join(SCRATCH, "ds-"));
  const store = createTwentyStore({ client: new TwentyClient({ url: fake.url, key: () => fake.key, sleep: async () => {} }), space: "spc_cccccccccccc", dir, webhookSecret: crypto.randomBytes(16).toString("hex"), graceMs: 0 });
  const gql = store.client.gql.bind(store.client);
  const made = /** @type {string[]} */ ([]);
  let phase = "define";
  store.client.gql = async (/** @type {string} */ api, /** @type {string} */ q, /** @type {any} */ v) => { if (/createOneField/.test(q) && /^vyre(Project|Owner|CreatedBy|Sensitivity)$/.test(v?.i?.field?.name || "")) made.push(`${phase}:${v.i.field.name}`); return gql(api, q, v); };
  await store.define({ add_types: [type("mirrored")] });
  phase = "write";
  const id = (await import("../../kernel/core/ids.js")).mintUuid(Date.now());
  await store.create("mirrored", id, { a: "x" }, { attrs: { project: "p1", owner: "per_x" } });
  await store.get("mirrored", id);
  assert.deepEqual(made.map(m => m.split(":")[0]), ["define", "define", "define", "define"], `all four columns in the define, none at the first write: ${made.join(", ")}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a type that already exists without mirror columns still gets them at its first write; a define that failed on a column is finished by the next one", async () => {
  fake.reset();
  const dir = fs.mkdtempSync(path.join(SCRATCH, "ds-"));
  const mk = () => createTwentyStore({ client: new TwentyClient({ url: fake.url, key: () => fake.key, sleep: async () => {} }), space: "spc_cccccccccccc", dir, webhookSecret: crypto.randomBytes(16).toString("hex"), graceMs: 0 });
  const store = mk();
  const names = /** @type {string[]} */ ([]);
  let failOn = "vyreOwner", phase = "define";
  const gql = store.client.gql.bind(store.client);
  store.client.gql = async (/** @type {string} */ api, /** @type {string} */ q, /** @type {any} */ v) => {
    const n = v?.i?.field?.name;
    if (/createOneField/.test(q) && /^vyre(Project|Owner|CreatedBy|Sensitivity)$/.test(n || "")) { if (n === failOn) { failOn = ""; throw Object.assign(new Error("migration lock timeout"), { code: "unavailable" }); } names.push(`${phase}:${n}`); }
    return gql(api, q, v);
  };
  // the first define fails halfway on a column: it says so, and the next one finishes the type
  await assert.rejects(store.define({ add_types: [type("halfway")] }));
  await store.define({ add_types: [type("halfway")] });
  const id = (await import("../../kernel/core/ids.js")).mintUuid(Date.now());
  phase = "write";
  await store.create("halfway", id, { a: "x" }, { attrs: { project: "p1" } });
  assert.deepEqual([...new Set(names.map(m => m.split(":")[1]))].sort(), ["vyreCreatedBy", "vyreOwner", "vyreProject", "vyreSensitivity"], names.join(", "));
  assert.ok(names.every(m => m.startsWith("define:")), `all four were made by the defines, none by the write: ${names.join(", ")}`);
  // a type from before this change (object and fields, no mirror columns) is made lazily at its first write, as it was: its define-time columns are skipped here to stand in for it
  const mirror = /^vyre(Project|Owner|CreatedBy|Sensitivity)$/;
  const legacyStore = mk();
  const lg = legacyStore.client.gql.bind(legacyStore.client);
  legacyStore.client.gql = async (/** @type {string} */ api, /** @type {string} */ q, /** @type {any} */ v) => (/createOneField/.test(q) && mirror.test(v?.i?.field?.name || "") ? { createOneField: { id: "skipped", name: v.i.field.name } } : lg(api, q, v));
  await legacyStore.define({ add_types: [type("legacy")] });
  const later = mk();   // the updated server, a fresh process: the type exists in Twenty with no mirror columns
  const lazy = /** @type {string[]} */ ([]);
  const lg2 = later.client.gql.bind(later.client);
  later.client.gql = async (/** @type {string} */ api, /** @type {string} */ q, /** @type {any} */ v) => { if (/createOneField/.test(q) && mirror.test(v?.i?.field?.name || "")) lazy.push(v.i.field.name); return lg2(api, q, v); };
  await later.define({ add_types: [type("legacy")] });
  assert.equal(lazy.length, 0, "an existing type's define does not make them");
  await later.create("legacy", (await import("../../kernel/core/ids.js")).mintUuid(Date.now()), { a: "y" }, { attrs: { project: "p2" } });
  assert.deepEqual(lazy.slice().sort(), ["vyreCreatedBy", "vyreOwner", "vyreProject", "vyreSensitivity"], "the first write makes them, as before");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a Records call slower than the limit leaves a log line naming the call (a slow first action names its cause)", async () => {
  fake.reset();
  const dir = fs.mkdtempSync(path.join(SCRATCH, "ds-"));
  const lines = /** @type {string[]} */ ([]);
  const store = createTwentyStore({ client: new TwentyClient({ url: fake.url, key: () => fake.key, sleep: async () => {}, slowMs: 0 }), space: "spc_cccccccccccc", dir, webhookSecret: crypto.randomBytes(16).toString("hex"), graceMs: 0, log: l => lines.push(l) });
  await store.define({ add_types: [type("slowish")] });
  assert.ok(lines.some(l => /^slow Records call: (metadata|graphql) \w+ took \d+\.\d s$/.test(l)), lines.join(" | "));
  const quiet = createTwentyStore({ client: new TwentyClient({ url: fake.url, key: () => fake.key, sleep: async () => {}, slowMs: 60_000 }), space: "spc_cccccccccccc", dir: fs.mkdtempSync(path.join(SCRATCH, "ds-")), webhookSecret: "x", graceMs: 0, log: l => lines.push(`quiet:${l}`) });
  await quiet.define({ add_types: [type("quick")] });
  assert.ok(!lines.some(l => l.startsWith("quiet:slow Records call")), "a fast call says nothing");
  fs.rmSync(dir, { recursive: true, force: true });
});
