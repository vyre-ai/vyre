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
