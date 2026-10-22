// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tempHome } from "./helpers.js";
import { storeStatus } from "../stores/store-status.js";
import { createMemoryStore } from "../kernel/store/memory.js";
import { mintUuid } from "../kernel/core/ids.js";
import { start } from "../core/daemon/index.js";
import { request } from "../core/daemon/client.js";

const withType = async (/** @type {any} */ s, n = 3) => { await s.define({ add_types: [{ name: "contact", label: "Contact", fields: [{ name: "name", kind: "text", label: "Name" }] }] }); for (let i = 0; i < n; i++) await s.create("contact", mintUuid(), { name: `n${i}` }); return s; };

test("status names the Vyre store, with the record count it sees", async t => {
  const root = tempHome(t);
  const s = await withType(createMemoryStore());
  const st = await storeStatus({ root, store: s, env: {} });
  assert.deepEqual(st, { store: "vyre", records: 3, reachable: true });
});

test("an old VYRE_STORE value does not change the status: the count is still the Vyre store's", async t => {
  const root = tempHome(t);
  const st = await storeStatus({ root, store: await withType(createMemoryStore(), 1), env: { VYRE_STORE: "auto" } });
  assert.equal(st.store, "vyre");
  assert.equal(st.records, 1);
  assert.equal(st.reachable, true);
});

test("a real daemon reports records_store on /v1/health: the Vyre store, with a count", { timeout: 120_000 }, async t => {
  process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1";
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const h = (await request("GET", "/v1/health", undefined, { root })).data;
  assert.equal(h.records_store.store, "vyre");
  assert.equal(typeof h.records_store.records, "number");
  assert.equal(h.records_store.reachable, true);
});

test("a daemon with VYRE_STORE=auto starts on the Vyre store and says the old value is ignored", { timeout: 120_000 }, async t => {
  process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1";
  process.env.VYRE_STORE = "auto";
  t.after(() => { delete process.env.VYRE_STORE; });
  const root = tempHome(t);
  /** @type {string[]} */ const lines = [];
  const d = await start({ root, log: m => lines.push(String(m)), kernel: true });
  t.after(() => d.stop());
  assert.ok(lines.includes("records: Twenty is gone; this Space starts on the Vyre store, empty"));
  const h = (await request("GET", "/v1/health", undefined, { root })).data;
  assert.equal(h.records_store.store, "vyre");
  assert.equal(typeof h.records_store.records, "number");
  assert.equal(h.records_store.reachable, true);
  const planner = d.registry.status().find((/** @type {any} */ m) => m.name === "planner");
  assert.equal(planner.state, "running");
  assert.equal(planner.waiting, undefined);
});

test("the health answer does not wait for a record store that is busy: it comes within the budget and says the store is busy", async () => {
  const { storeStatusWithin } = await import("../stores/store-status.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-"));
  const slow = new Promise(() => {});
  const busy = { attached: () => true, types: () => slow, aggregate: () => slow };
  const t0 = Date.now();
  const r = /** @type {any} */ (await storeStatusWithin(150, { root, store: busy, env: {} }));
  assert.ok(Date.now() - t0 < 1000, "answered inside a second");
  assert.equal(r.busy, true);
  assert.equal(r.store, "vyre");
  assert.match(r.note, /busy setting up; Vyre is running/);
  const quick = /** @type {any} */ (await storeStatusWithin(1500, { root, store: { attached: () => true, types: async () => [], aggregate: async () => [] }, env: {} }));
  assert.equal(quick.busy, undefined);
  assert.equal(quick.reachable, true);
  assert.equal(quick.store, "vyre");
});
