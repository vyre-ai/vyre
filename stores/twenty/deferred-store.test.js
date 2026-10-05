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
import { createDeferredStore } from "./deferred-store.js";
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
