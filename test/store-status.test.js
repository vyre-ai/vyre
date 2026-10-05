// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "./helpers.js";
import { storeStatus } from "../stores/store-status.js";
import { createMemoryStore } from "../kernel/store/memory.js";
import { mintUuid } from "../kernel/core/ids.js";
import { start } from "../core/daemon/index.js";
import { request } from "../core/daemon/client.js";

const withType = async (/** @type {any} */ s, n = 3) => { await s.define({ add_types: [{ name: "contact", label: "Contact", fields: [{ name: "name", kind: "text", label: "Name" }] }] }); for (let i = 0; i < n; i++) await s.create("contact", mintUuid(), { name: `n${i}` }); return s; };

test("status names the store: built-in by default, with the record count it sees", async t => {
  const root = tempHome(t);
  const s = await withType(createMemoryStore());
  const st = await storeStatus({ root, store: s, env: {} });
  assert.deepEqual(st, { store: "builtin", from: "default", mode: "sqlite", records: 3, reachable: true });
});

test("VYRE_STORE asks for Twenty and the server is not on it: status says so plainly, it does not fall back quietly", async t => {
  const root = tempHome(t);
  const st = await storeStatus({ root, store: await withType(createMemoryStore(), 1), env: { VYRE_STORE: "twenty" } });
  assert.equal(st.store, "builtin"); assert.equal(st.from, "VYRE_STORE"); assert.equal(st.reachable, false);
  assert.match(String(st.note), /asks for Twenty and this server is not using it/);
});

test("a home set up on Twenty that now runs on the built-in store is named, and a Twenty that does not answer says so", async t => {
  const root = tempHome(t);
  fs.mkdirSync(path.join(root, "kernel"), { recursive: true });
  fs.writeFileSync(path.join(root, "kernel", "store.json"), JSON.stringify({ kind: "twenty" }));
  const st = await storeStatus({ root, store: await withType(createMemoryStore(), 2), env: {} });
  assert.match(String(st.note), /set up on Twenty.*built-in store/);
  const down = { kind: "twenty", health: async () => ({ ok: false, detail: "no reply" }), types: async () => [], aggregate: async () => [] };
  const st2 = await storeStatus({ root, store: down, env: { VYRE_STORE: "twenty" } });
  assert.equal(st2.store, "twenty"); assert.equal(st2.reachable, false); assert.equal(st2.records, null);
  assert.match(String(st2.note), /Twenty is not answering: no reply/);
});

test("a store that refuses every record call is reported as none, with its plain words", async t => {
  const root = tempHome(t);
  const { createRefusingStore } = await import("../kernel/store/refusing.js");
  const st = await storeStatus({ root, server: true, store: createRefusingStore("not enough free memory"), env: { VYRE_STORE: "twenty" } });
  assert.equal(st.store, "none"); assert.equal(st.reachable, false);
  assert.match(String(st.note), /cannot run the record store \(Twenty\): not enough free memory/);
});

test("a real daemon reports records_store on /v1/health: the built-in store, from the default, with a count", { timeout: 120_000 }, async t => {
  process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1";
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const h = (await request("GET", "/v1/health", undefined, { root })).data;
  assert.equal(h.records_store.store, "builtin");
  assert.equal(h.records_store.from, "default");
  assert.equal(typeof h.records_store.records, "number");
  assert.equal(h.records_store.reachable, true);
});
