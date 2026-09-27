// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../store/index.js";
import { Idempotency } from "./idempotency.js";
import { tempHome } from "../../test/helpers.js";

const fresh = (t, o) => new Idempotency(open(path.join(tempHome(t), "vyre.db")), o);
const id = (key, input = { n: 1 }) => ({ caller: "deck", tool: "threads.send", key, input });

test("idempotency: a repeat gets the first answer and the tool runs once", async t => {
  const idem = fresh(t);
  let runs = 0;
  const run = async () => ({ data: { n: ++runs } });
  assert.deepEqual(await idem.once(id("k1"), run), { data: { n: 1 } });
  assert.deepEqual(await idem.once(id("k1"), run), { data: { n: 1 }, replayed: true });
  assert.equal(runs, 1);
});

test("idempotency: input key order does not matter, other input is a conflict", async t => {
  const idem = fresh(t);
  const run = async () => ({ data: true });
  await idem.once(id("k2", { a: 1, b: 2 }), run);
  assert.equal((await idem.once(id("k2", { b: 2, a: 1 }), run)).replayed, true);
  assert.equal((await idem.once(id("k2", { a: 1, b: 3 }), run)).error?.code, "idempotency_conflict");
});

test("idempotency: a tool's refusal is kept, a crash is not", async t => {
  const idem = fresh(t);
  let runs = 0;
  await idem.once(id("k3"), async () => { runs++; return { error: { code: "denied", message: "no" } }; });
  assert.equal((await idem.once(id("k3"), async () => { runs++; return { data: 1 }; })).error?.code, "denied");
  await idem.once(id("k4"), async () => { runs++; return { error: { code: "failed", message: "boom" } }; });
  assert.deepEqual(await idem.once(id("k4"), async () => { runs++; return { data: 2 }; }), { data: 2 });
  assert.equal(runs, 3);
});

test("idempotency: a record older than its day is forgotten", async t => {
  let now = 1_000_000;
  const idem = fresh(t, { now: () => now });
  let runs = 0;
  const run = async () => ({ data: ++runs });
  await idem.once(id("k5"), run);
  now += 25 * 60 * 60 * 1000;
  assert.deepEqual(await idem.once(id("k5"), run), { data: 2 });
});
