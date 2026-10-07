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
