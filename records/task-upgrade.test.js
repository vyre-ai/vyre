// @ts-check
// A Space defined before fast fields has a task type without `extra`; the kernel and the tasks service define TASK as the code has it, and the records tools add the bag to a type that lacks it. Whichever comes
// first, the store must never be asked to take `extra` away ("removing a field is a migration, not a define").
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "../kernel/store/memory.js";
import { TASK, CORE_TYPES } from "./core-types.js";

const withoutExtra = () => ({ ...JSON.parse(JSON.stringify(TASK)), fields: TASK.fields.filter((f) => f.name !== "extra") });

test("TASK carries the bag itself, and the core list holds the same type", () => {
  assert.ok(TASK.fields.some((f) => f.name === "extra"));
  const core = CORE_TYPES.find((t) => t.name === "task");
  assert.deepEqual(core.fields.map((f) => f.name), TASK.fields.map((f) => f.name), "the same fields, in the same order");
});

test("the 0.6.1 task type, then this one, then this one again: each define is accepted", async () => {
  const s = createMemoryStore({ space: "spc_aaaaaaaaaaaa" });
  await s.define({ add_types: [withoutExtra()] });
  await s.define({ add_types: [TASK] });
  await s.define({ add_types: [TASK] });
  const have = (await s.types()).find((/** @type {any} */ t) => t.name === "task");
  assert.ok(have.fields.some((/** @type {any} */ f) => f.name === "extra"), "the store now holds the bag");
});

test("a store that already holds the bag accepts the kernel's own define of TASK", async () => {
  const s = createMemoryStore({ space: "spc_aaaaaaaaaaaa" });
  await s.define({ add_types: [CORE_TYPES.find((t) => t.name === "task")] });
  await s.define({ add_types: [TASK] });
});
