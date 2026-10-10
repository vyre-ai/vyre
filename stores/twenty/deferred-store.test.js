// @ts-check
// A record store that is not there yet, and the kernel that booted over it: the task record type made at boot is applied when the real store attaches, and the task migration runs then too (once),
// with no retry loop of the kernel's own.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCRATCH } from "../../test/scratch.mjs";
import { createDeferredStore, MAX_DEFS } from "./deferred-store.js";
import { createMemoryStore } from "../../kernel/store/memory.js";
import { bootKernel } from "../../kernel/boot.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
const sealer = { presenceCheck: async () => null };
const mk = () => new DatabaseSync(path.join(fs.mkdtempSync(path.join(SCRATCH, "vyre-deferred-")), "kernel.db"));

test("whenReady runs once after attach, and at once when the store is already there", async () => {
  const d = createDeferredStore({ reason: () => "Twenty is starting" });
  const seen = /** @type {string[]} */ ([]);
  d.whenReady(() => seen.push("first"));
  assert.deepEqual(seen, []);
  await d.attach(createMemoryStore());
  assert.deepEqual(seen, ["first"]);
  d.whenReady(() => seen.push("late"));
  assert.deepEqual(seen, ["first", "late"]);
});

test("a kernel booted over a store that is not there yet defines the task record type and migrates when the store attaches", async () => {
  const d = createDeferredStore({ reason: () => "Twenty is starting" });
  const k = await bootKernel({ db: mk(), space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), sealer, store: d });
  assert.ok(k, "the kernel boots while the store is away");
  d.bootDone();
  await assert.rejects(() => d.types(), e => /** @type {any} */ (e).code === "unavailable");
  const real = createMemoryStore();
  await d.attach(real);
  assert.ok((await real.types()).some((/** @type {any} */ t) => t.name === "task"), "the task type made at boot was applied to the real store");
});

const reason = () => "the store is starting";


test("deferred store: a definition made while the real store is attaching is applied, not dropped", async () => {
  const d = createDeferredStore({ reason });
  d.define({ n: 1 });
  d.define({ n: 2 });
  /** @type {any[]} */ const got = [];
  let late = false;
  const real = { async define(/** @type {any} */ diff) { got.push(diff.n); if (diff.n === 1 && !late) { late = true; await d.define({ n: 3 }); } await new Promise(r => setImmediate(r)); return { applied: true }; }, types: async () => [], health: async () => ({ ok: true }) };
  await d.attach(real);
  assert.deepEqual(got, [1, 2, 3], "every definition, including the one made during the replay, reached the real store in order");
  assert.equal(d.attached(), true);
  await d.define({ n: 4 });
  assert.deepEqual(got, [1, 2, 3, 4], "after attach everything forwards");
});

test("deferred store: the queue is capped while the store is away, and a define past it is refused in plain words", async () => {
  const d = createDeferredStore({ reason });
  for (let i = 0; i < MAX_DEFS; i++) await d.define({ n: i });
  await assert.rejects(() => d.define({ n: "over" }), e => /** @type {any} */ (e).code === "unavailable" && /too many changes are waiting/.test(/** @type {Error} */ (e).message));
  /** @type {any[]} */ const got = [];
  await d.attach({ define: async (/** @type {any} */ x) => { got.push(x.n); return {}; }, types: async () => [], health: async () => ({ ok: true }) });
  assert.equal(got.length, MAX_DEFS, "the queued ones were all applied; the refused one was not");
});

test("deferred store: after the kernel's start a define while away is refused, not queued", async () => {
  const d = createDeferredStore({ reason });
  d.bootDone();
  await assert.rejects(() => d.define({ n: 1 }), e => /** @type {any} */ (e).code === "unavailable");
});

test("deferred store: its attribute map is a real Map from the start, so the gateway built over it can read and write attributes (it refused, and every gated call failed as no such record)", async () => {
  const d = createDeferredStore({ reason });
  const held = d.meta;   // the gateway takes this object when it is built, before the store is attached
  assert.equal(typeof held.get, "function");
  assert.equal(held.get("vyre://s/contact/1"), undefined);
  held.set("vyre://s/contact/1", { owner: "per_a" });
  assert.deepEqual(held.get("vyre://s/contact/1"), { owner: "per_a" });
  assert.equal(held.size, 1);
  assert.deepEqual([...held.keys()], ["vyre://s/contact/1"]);
});

test("deferred store: attributes kept while the store was away are written onto the real store's map when it attaches, and the held map then reads and writes that one", async () => {
  const d = createDeferredStore({ reason });
  const held = d.meta;
  held.set("vyre://s/contact/1", { owner: "per_a" });
  const writes = /** @type {string[]} */ ([]);
  const realMeta = new (class extends Map { set(/** @type {string} */ u, /** @type {any} */ a) { writes.push(u); return super.set(u, a); } })();
  await d.attach(Object.assign(createMemoryStore(), { meta: realMeta }));
  assert.deepEqual(writes, ["vyre://s/contact/1"], "the real map (which mirrors to the records) was written");
  assert.deepEqual(realMeta.get("vyre://s/contact/1"), { owner: "per_a" });
  held.set("vyre://s/contact/2", { owner: "per_b" });
  assert.deepEqual(realMeta.get("vyre://s/contact/2"), { owner: "per_b" }, "a write through the held map after attach reaches the real one");
  assert.deepEqual(held.get("vyre://s/contact/1"), { owner: "per_a" });
  assert.equal(held.size, 2);
});

test("after boot, a type read or a definition waits a bounded while for a store that attaches late, then says the store's own words", async () => {
  const keep = setInterval(() => {}, 50);   // the wait's own timer is unref'd, so something must keep the loop alive for the test
  const d = createDeferredStore({ reason: () => "starting Records: setting up its workspace (12 s so far)", waits: () => true, waitMs: 400 });
  d.bootDone();
  const read = d.types();
  const def = d.define({ add_types: [{ name: "late-note", label: "Late note", fields: [{ name: "body", kind: "text", label: "Body" }] }] });
  setTimeout(() => { void d.attach(createMemoryStore()); }, 100);
  assert.ok(Array.isArray(await read), "the read waited for the store and got the types");
  assert.ok(await def, "the definition waited and was applied");
  const gone = createDeferredStore({ reason: () => "starting Records: setting up its workspace (12 s so far)", waits: () => true, waitMs: 150 });
  gone.bootDone();
  await assert.rejects(() => gone.types(), e => /** @type {any} */ (e).code === "unavailable" && /starting Records.*so far/.test(/** @type {any} */ (e).message));
  const failed = createDeferredStore({ reason: () => "the record store for this space is not available yet: no Docker", waits: () => false, waitMs: 60_000 });
  failed.bootDone();
  await assert.rejects(() => failed.define({ add_types: [] }), /no Docker/, "a store that is not on its way is not waited for");
  clearInterval(keep);
});

test("records.define on a store that attaches late waits for it; past the wait it answers in the store's words, never the raw error", async () => {
  const keep = setInterval(() => {}, 50);
  const d = createDeferredStore({ reason: () => "starting Records: setting up its workspace (3 s so far)", waits: () => true, waitMs: 300 });
  const k = await bootKernel({ db: mk(), space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), sealer, store: d });
  d.bootDone();
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const T = { name: "dossier2", label: "Dossier", fields: [{ name: "name", kind: "text", label: "Name", required: true }] };
  const pending = k.gateway.records.define(owner, { add_types: [T] });
  setTimeout(() => { void d.attach(createMemoryStore()); }, 100);
  const r = await pending;
  assert.ok(r, "define waited for the store and went through");
  const d2 = createDeferredStore({ reason: () => "starting Records: setting up its workspace (3 s so far)", waits: () => true, waitMs: 100 });
  const k2 = await bootKernel({ db: mk(), space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), sealer, store: d2 });
  d2.bootDone();
  const owner2 = k2.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  await assert.rejects(() => k2.gateway.records.define(owner2, { add_types: [T] }), e => !/could not be read/.test(/** @type {any} */ (e).message) && /starting Records.*so far/.test(/** @type {any} */ (e).message));
  clearInterval(keep);
});
