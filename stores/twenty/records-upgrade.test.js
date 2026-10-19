// @ts-check
// An update that brings new core record types to a Space on a slow Records store (Twenty pays a cache rebuild per metadata call, 10 to 14 s each on a live server): the Space opens on the types
// it had, the new ones are added in the background one at a time, a call for one not there yet is refused in plain words, Flow tools answer within a bounded time, and a replayed definition
// is given time for its fields.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { CORE_TYPES } from "../../records/core-types.js";
import { onTypesChanged } from "../../kernel/store/types-signal.js";
import { openCore, upgradeOrder, upgradeWords, createStoreFor } from "./space-store.js";
import { createDeferredStore, defineTimeout, DEFINE_TIMEOUT_MS } from "./deferred-store.js";

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const linksOf = (/** @type {any} */ t) => (t.fields ?? []).filter((/** @type {any} */ f) => f.kind === "link" && f.to).map((/** @type {any} */ f) => f.to);

/**
 * A store like Twenty where it matters here: one define at a time, each costing `msPerType` per type it adds, and a link to a type that is not there is refused.
 * @param {string[]} have the types it starts with @param {number} msPerType
 */
function slowStore(have, msPerType) {
  /** @type {Map<string, any>} */ const plans = new Map();
  for (const n of have) { const t = CORE_TYPES.find((c) => c.name === n); plans.set(n, t ? structuredClone(t) : { name: n, fields: [] }); }
  let line = Promise.resolve();
  /** @type {string[]} */ const defines = [];
  const store = {
    defines,
    async types() { return [...plans.values()].map((t) => structuredClone(t)); },
    /** @param {any} diff */
    define(diff) {
      const run = async () => {
        const will = new Set([...plans.keys(), ...(diff.add_types ?? []).map((/** @type {any} */ t) => t.name)]);
        for (const t of [...(diff.add_types ?? []), ...(diff.change_types ?? [])]) for (const to of linksOf(t)) if (!will.has(to)) throw Object.assign(new Error(`${t.name} links to ${to}, which is not a type here`), { code: "invalid" });
        const add = (diff.add_types ?? []).filter((/** @type {any} */ t) => !plans.has(t.name));
        defines.push((diff.add_types ?? []).map((/** @type {any} */ t) => t.name).join("+") || "(change)");
        await sleep(add.length * msPerType);
        for (const t of [...(diff.add_types ?? []), ...(diff.change_types ?? [])]) plans.set(t.name, structuredClone(t));
        return { applied: add.length > 0, changes: add.map((/** @type {any} */ t) => `added type ${t.name}`) };
      };
      const next = line.then(run, run); line = next.then(() => {}, () => {}); return next;
    },
    async upgradeLinks() { return { applied: false, changes: [] }; },
    async query(/** @type {string} */ type) { if (!plans.has(type)) throw Object.assign(new Error(`no type ${type}`), { code: "unknown_type" }); return { rows: [] }; },
    async get(/** @type {string} */ type) { if (!plans.has(type)) throw Object.assign(new Error(`no type ${type}`), { code: "unknown_type" }); return null; },
  };
  return store;
}

// An older Space: every core type but the last 13, as a Space made before the update had.
const NEW = CORE_TYPES.slice(-13).map((t) => t.name);
const OLD = CORE_TYPES.slice(0, -13).map((t) => t.name);

test("a Space that already has its types opens on them at once; the new core types are added after, in the background, one at a time, each said", async () => {
  const real = slowStore(OLD, 40);
  /** @type {string[]} */ const log = [];
  const t0 = Date.now();
  const store = await openCore(real, (l) => log.push(l));
  assert.ok(Date.now() - t0 < 200, `it opened without adding the new types (${Date.now() - t0} ms)`);
  assert.deepEqual(real.defines, [], "nothing was defined before it opened");
  const u = store.upgrade();
  assert.equal(u.total, NEW.length); assert.equal(u.done, 0); assert.deepEqual([...u.pending].sort(), [...NEW].sort());
  // a type the Space had answers; a new one not there yet is refused in plain words, as a rejected call (never a raw "no type")
  assert.deepEqual(await store.query(OLD[0]), { rows: [] });
  await assert.rejects(() => store.query(NEW[0]), (/** @type {any} */ e) => e.code === "unavailable" && e.message.startsWith(upgradeWords(0, NEW.length)) && /This finishes on its own/.test(e.message) && !/Try again/.test(e.message));
  // the holder (the waiting store the kernel holds) hears each type land, so the gateway's copy of the types is redrawn
  const holder = {}; let heard = 0; onTypesChanged(holder, () => { heard++; });
  store.startUpgrade(holder);
  store.startUpgrade(holder);   // twice is once
  for (let i = 0; i < 200 && store.upgrade(); i++) await sleep(20);
  assert.equal(store.upgrade(), null, "the upgrade finished");
  const names = new Set((await real.types()).map((t) => t.name));
  for (const n of NEW) assert.ok(names.has(n), `${n} was added`);
  assert.equal(real.defines.length, upgradeOrder(CORE_TYPES.filter((t) => NEW.includes(t.name)), new Set(OLD)).length, `one define per type (a ring of links together): ${real.defines.join(" | ")}`);
  assert.ok(heard >= 1, "the holder was told");
  assert.ok(log.some((l) => /^adding 1 of 13 new record types/.test(l)), log.join(" | "));
  assert.ok(log.some((l) => /^new record types: 13 of 13 added/.test(l)), log.join(" | "));
  assert.deepEqual(await store.query(NEW[0]), { rows: [] }, "and the type answers once it landed");
});

test("a definition made during the upgrade waits for one type, not all of them, and one that links to a type still being added brings it along", async () => {
  const real = slowStore(OLD, 60);
  const store = await openCore(real, () => {});
  store.startUpgrade();
  await sleep(10);   // the first new type is being added
  const biggest = Math.max(...upgradeOrder(CORE_TYPES.filter((t) => NEW.includes(t.name)), new Set(OLD)).map((g) => g.length));
  const t0 = Date.now();
  await store.define({ add_types: [{ name: "note", fields: [{ name: "title", kind: "text" }] }] });
  assert.ok(Date.now() - t0 < 60 * biggest + 200, `a definition waited for about one type (${Date.now() - t0} ms), not ${NEW.length}`);
  // a new type that links to a core type not there yet: the store would refuse it; the core type comes with it
  const target = upgradeOrder(CORE_TYPES.filter((t) => NEW.includes(t.name)), new Set(OLD)).at(-1)?.[0].name;
  assert.ok(store.upgrade().pending.includes(target));
  await store.define({ add_types: [{ name: "memo", fields: [{ name: "about", kind: "link", to: target }] }] });
  assert.ok((await real.types()).some((t) => t.name === "memo"));
  assert.ok(!(store.upgrade()?.pending ?? []).includes(target), "the linked type landed with it");
  assert.ok(store.fieldsFor({ add_types: [{ name: "x", fields: [{ name: "a", kind: "text" }] }] }) === 1);
  for (let i = 0; i < 200 && store.upgrade(); i++) await sleep(20);
});

test("a new Space (none of its core types) still gets them all before it opens, as before; an up-to-date one adds nothing", async () => {
  const fresh = slowStore([], 1);
  /** @type {any} */ (fresh).upgradeLinks = async () => ({ applied: false, changes: [] });
  const s = await openCore(fresh, () => {});
  assert.equal(s, fresh, "no layer on a new Space");
  const names = new Set((await fresh.types()).map((t) => t.name));
  for (const t of CORE_TYPES) assert.ok(names.has(t.name));
  const done = slowStore(CORE_TYPES.map((t) => t.name), 1);
  assert.equal(await openCore(done, () => {}), done);
  assert.deepEqual(done.defines, []);
});

test("upgradeOrder: a type comes after the new types it links to; a ring goes in together", () => {
  const a = { name: "a", fields: [{ name: "b", kind: "link", to: "b" }] }, b = { name: "b", fields: [] }, c = { name: "c", fields: [{ name: "x", kind: "link", to: "contact" }] };
  assert.deepEqual(upgradeOrder([a, b, c], new Set(["contact"])).map((g) => g.map((t) => t.name)), [["b"], ["a"], ["c"]]);
  const r1 = { name: "r1", fields: [{ name: "o", kind: "link", to: "r2" }] }, r2 = { name: "r2", fields: [{ name: "o", kind: "link", to: "r1" }] };
  assert.deepEqual(upgradeOrder([r1, r2], new Set()).map((g) => g.map((t) => t.name)), [["r1", "r2"]]);
  // the real core types order without a refused link
  const groups = upgradeOrder(CORE_TYPES.filter((t) => NEW.includes(t.name)), new Set(OLD));
  const seen = new Set(OLD);
  for (const g of groups) { for (const t of g) seen.add(t.name); for (const t of g) for (const to of linksOf(t)) assert.ok(seen.has(to) || !NEW.includes(to), `${t.name} links to ${to} before it is there`); }
});

test("defineTimeout: at least the floor, and a third of it for each field a definition adds or changes; a function gets the floor", () => {
  const fields = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => ({ name: `f${i}`, kind: "text" }));
  assert.equal(defineTimeout({ add_types: [{ name: "t", fields: fields(1) }] }, null, DEFINE_TIMEOUT_MS), DEFINE_TIMEOUT_MS);
  assert.equal(defineTimeout({ add_types: [{ name: "t", fields: fields(67) }] }, null, DEFINE_TIMEOUT_MS), 67 * 20_000, "the 67-field definition that took 73 s gets 22 minutes, not 60 s");
  assert.equal(defineTimeout(async () => {}, null, DEFINE_TIMEOUT_MS), DEFINE_TIMEOUT_MS);
  assert.equal(defineTimeout({ change_types: [{ name: "t", fields: fields(4) }] }, { fieldsFor: () => 10 }, 30, 10), 100, "the store's own count, with the types it brings along");
});

test("a replayed definition with many fields that takes longer than the floor is waited for, not retried; a small one that hangs past its time still is", async () => {
  const d = createDeferredStore({ reason: () => "starting", defineTimeoutMs: 40, defineMsPerField: 20 });
  const many = { add_types: [{ name: "big", fields: Array.from({ length: 10 }, (_, i) => ({ name: `f${i}`, kind: "text" })) }] };
  await d.define(many);
  /** @type {string[]} */ const applied = [];
  const real = { meta: new Map(), types: async () => [], define: async (/** @type {any} */ diff) => { await sleep(120); applied.push(diff.add_types[0].name); return { applied: true, changes: [] }; } };
  await d.attach(real);   // 120 ms is past the 40 ms floor but inside 10 x 20 ms
  assert.equal(d.attached(), true);
  assert.deepEqual(applied, ["big"], "applied once, with no retry");
  const d2 = createDeferredStore({ reason: () => "starting", defineTimeoutMs: 40, defineMsPerField: 20 });
  await d2.define({ add_types: [{ name: "small", fields: [{ name: "a", kind: "text" }] }] });
  await assert.rejects(d2.attach({ ...real, define: async () => { await sleep(300); return { applied: true, changes: [] }; } }), /did not answer in 0 s|Applying definitions: retrying/);
  assert.equal(d2.attached(), false);
  await sleep(300);
});

test("storeFor: a Space opened on a slow store with new core types is ready in a bounded time, the upgrade runs after, and the waiting store says how far it is while away", async () => {
  const home = fs.mkdtempSync(path.join(SCRATCH, "rup-"));
  const real = slowStore(OLD, 30);
  /** @type {string[]} */ const lines = [];
  const f = createStoreFor({ home, mode: "twenty", helper: false, log: (l) => lines.push(l), coreTypes: true, makeStore: () => real,
    preflight: async () => ({ ok: true, reasons: [], facts: /** @type {any} */ ({}) }), provision: /** @type {any} */ (async () => ({ url: "http://127.0.0.1:1", keyFile: "k", webhookSecretFile: "w" })),
    rotate: /** @type {any} */ (async () => {}) });
  const t0 = Date.now();
  const st = await f("spc_aaaaaaaaaaaa", { personal: true });
  assert.ok(Date.now() - t0 < 1000, `ready in ${Date.now() - t0} ms, before ${NEW.length} x 30 ms of new types`);
  assert.ok(lines.some((l) => /Records ready/.test(l)));
  assert.ok(st.upgrade(), "the upgrade is under way after Records ready");
  for (let i = 0; i < 200 && st.upgrade(); i++) await sleep(20);
  assert.equal(st.upgrade(), null);
  assert.ok(lines.some((l) => /^adding \d+ of 13 new record types/.test(l)), lines.join(" | "));
  st.stopKeyCheck?.();
  fs.rmSync(home, { recursive: true, force: true });
});

test("the waiting store reports the start's upgrade while away, and the real store's once attached", async () => {
  let u = /** @type {any} */ ({ done: 2, total: 13 });
  const d = createDeferredStore({ reason: () => "starting", upgrade: () => u });
  assert.deepEqual(d.upgrade(), { done: 2, total: 13 });
  u = null;
  assert.equal(d.upgrade(), null);
  const real = { meta: new Map(), types: async () => [], define: async () => ({ applied: false, changes: [] }), upgrade: () => ({ done: 5, total: 13, pending: ["x"] }) };
  await d.attach(real);
  assert.deepEqual(d.upgrade(), { done: 5, total: 13, pending: ["x"] });
});
