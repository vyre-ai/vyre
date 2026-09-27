// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../store/index.js";
import { Idempotency, keyUuid } from "./idempotency.js";
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

test("idempotency: keyUuid keeps a uuid key and maps any other key to one stable uuid per caller", () => {
  const u = "3F2504E0-4F89-41D3-9A0C-0305E82C3301";
  assert.equal(keyUuid("deck", u), u.toLowerCase());
  const a = keyUuid("deck", "send-1234"), b = keyUuid("deck", "send-1234"), c = keyUuid("cli", "send-1234");
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});
