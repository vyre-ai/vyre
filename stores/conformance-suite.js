// @ts-check
// The conformance suite: one set of tests that every store must pass (spec 3.5). It is the
// definition of "a store". It runs against the in-memory reference store, against Twenty through
// a fake Twenty (offline, in CI) and against a real Twenty (testbox).
//
// A harness gives the suite what a store cannot do for itself:
//   make()   -> { store, behind(type, id, patch), touch(type, id), cleanup() }  a store with the suite types defined
//   empty()  -> { store, cleanup() }  a second, empty store with the suite types defined (for export and import)
//   behind   changes a record inside the store, the way a mail sync or an edit made behind the gateway would
//   touch    changes something the language does not declare (position, search vector), to prove the hash ignores it

import { StoreError, SEALED_PLACEHOLDER, assertStore } from "./contract.js";
import { mintId, isRecordId, idTime } from "../records/ids.js";
import { recordHash } from "./hash.js";

/** The types the suite defines, in the stored form of the language. */
export const SUITE_TYPES = [
  {
    name: "widget", label: "Widget", plural: "Widgets", title: "title",
    fields: [
      { name: "title", kind: "text", required: true },
      { name: "tag", kind: "text" },
      { name: "qty", kind: "number", integer: true, min: 0 },
      { name: "price", kind: "money", currency: "USD" },
      { name: "due", kind: "date" },
      { name: "at", kind: "datetime" },
      { name: "done", kind: "boolean", default: false },
      { name: "kind", kind: "choice", options: ["Alpha", "Beta", "Gamma"] },
      { name: "owner", kind: "person" },
      { name: "secret", kind: "sealed", class: "us-ssn" },
      { name: "address", kind: "address" },
      { name: "status", kind: "stage", stages: [{ name: "New" }, { name: "Active" }, { name: "Done" }] },
    ],
  },
];

const CODES = new Set(["not_found", "conflict", "invalid", "sealed_value", "unknown_type", "unknown_field", "unavailable", "name_reserved", "unsupported", "rate_limited", "tampered", "id_exists"]);

/**
 * @param {string} name
 * @param {{ test: any, before?: any, after?: any }} runner node:test functions
 * @param {{ assert: typeof import("node:assert/strict") }} deps
 * @param {{ make: () => Promise<any>, empty: (types: any[]) => Promise<any>, waitMs?: number }} harness
 */
export function conformance(name, runner, deps, harness) {
  const { test } = runner;
  const assert = deps.assert;
  /** @type {any} */ let h;
  const run = `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  let n = 0;
  /** @type {any[]} */ let current = SUITE_TYPES;
  const tag = (/** @type {string} */ s) => `${run}-${s}-${++n}`;
  /** @param {string} t @param {any} [fields] */
  const mk = (t, fields = {}) => h.store.create("widget", { id: mintId(), fields: { title: `Widget ${t}`, tag: t, ...fields } });
  /** @param {() => Promise<any>} fn @param {string} code */
  const rejects = async (fn, code) => { try { await fn(); } catch (e) { assert.ok(e instanceof StoreError, `expected a StoreError, got ${e && /** @type {any} */ (e).stack}`); assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`); assert.ok(CODES.has(e.code)); return; } assert.fail(`expected ${code}`); };
  /** @param {() => Promise<boolean>} cond */
  const until = async (cond, ms = harness.waitMs ?? 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

  test(`${name}: set up`, async () => { h = await harness.make(); assertStore(h.store); });

  test(`${name}: define is idempotent and reports what it applied`, async () => {
    const again = await h.store.define({ types: SUITE_TYPES });
    assert.deepEqual(again.applied, [], "a second define applies nothing");
    const grown = structuredClone(SUITE_TYPES);
    grown[0].fields.push({ name: "extra", kind: "text" });
    const r = await h.store.define({ types: grown });
    current = grown;
    assert.deepEqual(r.applied, ["field widget.extra"]);
    assert.deepEqual((await h.store.define({ types: grown })).applied, []);
    const c = await mk(tag("extra"), { extra: "hello" });
    assert.equal(c.fields.extra, "hello");
  });

  test(`${name}: define refuses a removal and a change of kind (those are migrations)`, async () => {
    const removed = structuredClone(SUITE_TYPES); removed[0].fields = removed[0].fields.filter((/** @type {any} */ f) => f.name !== "tag");
    await rejects(() => h.store.define({ types: removed }), "unsupported");
    const kind = structuredClone(SUITE_TYPES); kind[0].fields.find((/** @type {any} */ f) => f.name === "qty").kind = "text"; delete kind[0].fields.find((/** @type {any} */ f) => f.name === "qty").integer; delete kind[0].fields.find((/** @type {any} */ f) => f.name === "qty").min;
    await rejects(() => h.store.define({ types: kind }), "unsupported");
  });

  test(`${name}: the id we mint is the id the store keeps`, async () => {
    const id = mintId();
    const rec = await h.store.create("widget", { id, fields: { title: "Keeps its id", tag: tag("ids") } });
    assert.equal(rec.id, id);
    assert.equal((await h.store.get("widget", id)).id, id);
    const minted = await h.store.create("widget", { fields: { title: "Store mints", tag: tag("ids") } });
    assert.ok(isRecordId(minted.id));
    assert.ok(Math.abs(idTime(minted.id) - Date.now()) < 60_000);
    await rejects(() => h.store.create("widget", { id, fields: { title: "Duplicate id", tag: tag("ids") } }), "id_exists");
    await rejects(() => h.store.create("widget", { id: "01a101b0-a370-7000-b5d3-0f0df5924247", fields: { title: "v7", tag: tag("ids") } }), "invalid");
  });

  test(`${name}: every value kind round-trips`, async () => {
    const t = tag("kinds");
    const fields = { title: "Kinds", tag: t, qty: 7, price: { amount: 1234.56, currency: "USD" }, due: "2026-10-03", at: "2026-10-03T12:30:45.000Z", done: true, kind: "Beta", owner: "assistant:juno", address: { street1: "1 Harlow Way", city: "Sacramento", state: "CA", postal: "95814" }, status: "Active" };
    const rec = await mk(t, fields);
    const got = await h.store.get("widget", rec.id);
    for (const [k, v] of Object.entries(fields)) assert.deepEqual(got.fields[k], v, `field ${k}`);
    assert.equal(got.fields.secret, null);
    assert.equal(got.version, rec.version);
    assert.equal(typeof got.hash, "string");
    assert.equal(got.deletedAt, null);
  });

  test(`${name}: defaults apply, required and types are enforced, errors are typed`, async () => {
    const rec = await mk(tag("defaults"));
    assert.equal(rec.fields.done, false);
    assert.equal(rec.fields.status, "New");
    await rejects(() => h.store.create("widget", { id: mintId(), fields: { tag: tag("req") } }), "invalid");
    await rejects(() => h.store.create("widget", { id: mintId(), fields: { title: "x", qty: -1 } }), "invalid");
    await rejects(() => h.store.create("widget", { id: mintId(), fields: { title: "x", qty: 1.5 } }), "invalid");
    await rejects(() => h.store.create("widget", { id: mintId(), fields: { title: "x", kind: "Delta" } }), "invalid");
    await rejects(() => h.store.create("widget", { id: mintId(), fields: { title: "x", due: "03/10/2026" } }), "invalid");
    await rejects(() => h.store.create("widget", { id: mintId(), fields: { title: "x", nope: 1 } }), "unknown_field");
    await rejects(() => h.store.create("ghost", { id: mintId(), fields: {} }), "unknown_type");
    await rejects(() => h.store.get("ghost", mintId()), "unknown_type");
    assert.equal(await h.store.get("widget", mintId()), null);
  });

  test(`${name}: update checks the version the caller read`, async () => {
    const rec = await mk(tag("upd"), { qty: 1 });
    const u1 = await h.store.update("widget", rec.id, { qty: 2 }, rec.version);
    assert.equal(u1.fields.qty, 2);
    assert.notEqual(u1.version, rec.version);
    assert.equal((await h.store.get("widget", rec.id)).fields.qty, 2);
    try { await h.store.update("widget", rec.id, { qty: 3 }, rec.version); assert.fail("a stale version must conflict"); }
    catch (e) { assert.equal(e.code, "conflict"); assert.equal(e.detail.current, u1.version); }
    assert.equal((await h.store.get("widget", rec.id)).fields.qty, 2, "a conflict writes nothing");
    await rejects(() => h.store.update("widget", mintId(), { qty: 1 }, rec.version), "not_found");
    await rejects(() => h.store.update("widget", rec.id, {}, u1.version), "invalid");
    await rejects(() => h.store.update("widget", rec.id, { qty: 1 }, ""), "invalid");
    await rejects(() => h.store.update("widget", rec.id, { title: null }, u1.version), "invalid");
    const u2 = await h.store.update("widget", rec.id, { kind: "Gamma", price: { amount: 10, currency: "USD" } }, u1.version);
    assert.equal(u2.fields.qty, 2, "an update changes only the fields it names");
    assert.equal(u2.fields.kind, "Gamma");
  });

  test(`${name}: two writers with the same base version: exactly one wins`, async () => {
    const rec = await mk(tag("race"), { qty: 0 });
    const r = await Promise.allSettled([h.store.update("widget", rec.id, { qty: 1 }, rec.version), h.store.update("widget", rec.id, { qty: 2 }, rec.version)]);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    const lost = /** @type {PromiseRejectedResult} */ (r.find((x) => x.status === "rejected"));
    assert.equal(lost.reason.code, "conflict");
  });

  test(`${name}: remove hides a record, restore brings it back`, async () => {
    const t = tag("rm");
    const rec = await mk(t);
    const removed = await h.store.remove("widget", rec.id);
    assert.ok(removed.deletedAt);
    assert.equal(await h.store.get("widget", rec.id), null);
    assert.equal((await h.store.get("widget", rec.id, { includeDeleted: true })).id, rec.id);
    assert.equal((await h.store.query("widget", { filter: { tag: t } })).rows.length, 0);
    assert.equal((await h.store.query("widget", { filter: { tag: t }, onlyDeleted: true })).rows.length, 1);
    assert.equal((await h.store.query("widget", { filter: { tag: t }, includeDeleted: true })).rows.length, 1);
    const back = await h.store.restore("widget", rec.id);
    assert.equal(back.deletedAt, null);
    assert.equal((await h.store.get("widget", rec.id)).id, rec.id);
    await rejects(() => h.store.remove("widget", mintId()), "not_found");
  });

  test(`${name}: query filters, combinators and sorts`, async () => {
    const t = tag("q");
    await mk(t, { title: "Anna", qty: 5, price: { amount: 100, currency: "USD" }, due: "2026-01-10", kind: "Alpha", status: "New" });
    await mk(t, { title: "Bruno", qty: 10, price: { amount: 250.5, currency: "USD" }, due: "2026-02-10", kind: "Beta", status: "Active" });
    await mk(t, { title: "Carla", qty: 15, price: { amount: 999, currency: "USD" }, due: "2026-03-10", kind: "Beta", status: "Done" });
    await mk(t, { title: "Dario", qty: 20, kind: "Gamma", status: "Active" });
    const titles = async (/** @type {any} */ filter, /** @type {any} */ sort) => (await h.store.query("widget", { filter: { tag: t, ...filter }, sort })).rows.map((/** @type {any} */ r) => r.fields.title);
    assert.deepEqual(await titles({ kind: "Beta" }, [{ field: "title" }]), ["Bruno", "Carla"]);
    assert.deepEqual(await titles({ kind: { ne: "Beta" } }, [{ field: "title" }]), ["Anna", "Dario"]);
    assert.deepEqual(await titles({ kind: { in: ["Alpha", "Gamma"] } }, [{ field: "title" }]), ["Anna", "Dario"]);
    assert.deepEqual(await titles({ qty: { gt: 5, lte: 15 } }, [{ field: "title" }]), ["Bruno", "Carla"]);
    assert.deepEqual(await titles({ price: { gte: 250.5 } }, [{ field: "title" }]), ["Bruno", "Carla"]);
    assert.deepEqual(await titles({ due: { lt: "2026-03-01" } }, [{ field: "title" }]), ["Anna", "Bruno"]);
    assert.deepEqual(await titles({ title: { contains: "ar" } }, [{ field: "title" }]), ["Carla", "Dario"]);
    assert.deepEqual(await titles({ price: { isNull: true } }), ["Dario"]);
    assert.deepEqual(await titles({ status: "Active" }, [{ field: "title" }]), ["Bruno", "Dario"]);
    assert.deepEqual(await titles({ or: [{ title: "Anna" }, { qty: 20 }] }, [{ field: "title" }]), ["Anna", "Dario"]);
    assert.deepEqual(await titles({ and: [{ kind: "Beta" }, { not: { title: "Carla" } }] }), ["Bruno"]);
    assert.deepEqual(await titles({}, [{ field: "qty", dir: "desc" }]), ["Dario", "Carla", "Bruno", "Anna"]);
    assert.deepEqual(await titles({}, [{ field: "title", dir: "desc" }]), ["Dario", "Carla", "Bruno", "Anna"]);
    assert.deepEqual(await titles({}, [{ field: "kind" }, { field: "qty", dir: "desc" }]), ["Anna", "Carla", "Bruno", "Dario"]);
    await rejects(() => h.store.query("widget", { filter: { nope: 1 } }), "unknown_field");
    await rejects(() => h.store.query("widget", { filter: { secret: "x" } }), "invalid");
    await rejects(() => h.store.query("widget", { sort: [{ field: "secret" }] }), "invalid");
  });

  test(`${name}: cursor paging covers every row once, in a stable order`, async () => {
    const t = tag("page");
    const ids = [];
    for (let i = 0; i < 23; i++) ids.push((await mk(t, { title: `P${String(i).padStart(2, "0")}`, qty: i % 5 })).id);
    for (const sort of [undefined, [{ field: "qty" }, { field: "title" }]]) {
      const seen = []; let after = null; let pages = 0;
      do { const r = await h.store.query("widget", { filter: { tag: t }, sort, page: { limit: 7, after } }); assert.ok(r.rows.length <= 7); seen.push(...r.rows.map((/** @type {any} */ x) => x.id)); after = r.next; pages++; assert.ok(pages < 10); } while (after);
      assert.equal(seen.length, 23); assert.equal(new Set(seen).size, 23);
      if (!sort) assert.deepEqual(seen, ids, "default order is id order, which is time order");
    }
    assert.equal((await h.store.query("widget", { filter: { tag: t }, page: { limit: 7 } })).total, 23);
  });

  test(`${name}: aggregate matches a reference calculation`, async () => {
    const t = tag("agg");
    const rows = [["Alpha", 1, 10], ["Alpha", 2, 20.5], ["Beta", 3, 30], ["Beta", 4, null], ["Gamma", 5, 50]];
    for (const [kind, qty, price] of rows) await mk(t, { kind, qty, ...(price === null ? {} : { price: { amount: price, currency: "USD" } }), status: qty % 2 ? "New" : "Done" });
    const all = (await h.store.query("widget", { filter: { tag: t }, page: { limit: 100 } })).rows;
    const byKind = await h.store.aggregate("widget", { filter: { tag: t }, groupBy: ["kind"] });
    const want = {}; for (const r of all) want[r.fields.kind] = (want[r.fields.kind] ?? 0) + 1;
    assert.deepEqual(Object.fromEntries(byKind.map((/** @type {any} */ g) => [g.group.kind, g.count])), want);
    const byStatus = await h.store.aggregate("widget", { filter: { tag: t }, groupBy: ["status"] });
    assert.deepEqual(Object.fromEntries(byStatus.map((/** @type {any} */ g) => [g.group.status, g.count])), { New: 3, Done: 2 });
    const m = await h.store.aggregate("widget", { filter: { tag: t }, groupBy: ["kind"], measures: [{ op: "count" }, { op: "sum", field: "qty" }, { op: "avg", field: "price" }, { op: "max", field: "qty" }] });
    const a = Object.fromEntries(m.map((/** @type {any} */ g) => [g.group.kind, g]));
    assert.equal(a.Alpha.sum_qty, 3); assert.equal(a.Alpha.avg_price, 15.25); assert.equal(a.Beta.avg_price, 30); assert.equal(a.Gamma.max_qty, 5);
    const total = await h.store.aggregate("widget", { filter: { tag: t }, measures: [{ op: "count" }, { op: "sum", field: "qty" }] });
    assert.equal(total[0].count, 5); assert.equal(total[0].sum_qty, 15);
    await rejects(() => h.store.aggregate("widget", { groupBy: ["secret"] }), "invalid");
    await rejects(() => h.store.aggregate("widget", { measures: [{ op: "sum", field: "secret" }] }), "invalid");
  });

  test(`${name}: search finds, ranks and never reads a sealed field`, async () => {
    const t = tag("search"); const word = `zebrafish${run}`;
    const exact = await mk(t, { title: word });
    const prefix = await mk(t, { title: `${word} and friends` });
    const inside = await mk(t, { title: `the ${word} club` });
    const viaTag = await mk(`${word}-tag`, { title: "Unrelated title" });
    const hits = await h.store.search(word, { types: ["widget"] });
    const ids = hits.map((/** @type {any} */ x) => x.record.id);
    for (const r of [exact, prefix, inside, viaTag]) assert.ok(ids.includes(r.id), "found");
    assert.ok(ids.indexOf(exact.id) < ids.indexOf(prefix.id), "exact title first");
    assert.ok(ids.indexOf(prefix.id) < ids.indexOf(inside.id), "prefix before contains");
    assert.ok(ids.indexOf(inside.id) < ids.indexOf(viaTag.id), "title match before a match in another field");
    assert.deepEqual(await h.store.search(`nothing-like-${run}`), []);
    assert.deepEqual(await h.store.search("   "), []);
    const sealed = await h.store.search("sealed", { types: ["widget"] });
    assert.ok(!sealed.some((/** @type {any} */ x) => x.record.fields.secret === SEALED_PLACEHOLDER && x.record.tag === t), "the placeholder text is not searchable");
  });

  test(`${name}: changes reports what the store did on its own, in order and complete, and not our own writes`, async () => {
    const t = tag("chg");
    const first = h.store.changes(0);
    let cursor = first.cursor;
    const a = await mk(t, { qty: 1 }), b = await mk(t, { qty: 2 });
    await h.store.update("widget", a.id, { qty: 11 }, a.version);
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(h.store.changes(cursor).changes.filter((/** @type {any} */ c) => c.id === a.id || c.id === b.id), [], "our own writes are not changes");
    await h.behind("widget", a.id, { qty: 101 });
    await h.behind("widget", b.id, { qty: 202 });
    await h.behind("widget", a.id, { qty: 303 });
    assert.ok(await until(async () => h.store.changes(cursor).changes.filter((/** @type {any} */ c) => c.id === a.id || c.id === b.id).length >= 3), "three changes arrive");
    const got = h.store.changes(cursor).changes.filter((/** @type {any} */ c) => c.id === a.id || c.id === b.id);
    assert.equal(got.length, 3);
    assert.deepEqual(got.map((/** @type {any} */ c) => c.after.qty), [101, 202, 303]);
    assert.deepEqual(got.map((/** @type {any} */ c) => c.seq), [...got.map((/** @type {any} */ c) => c.seq)].sort((x, y) => x - y));
    assert.equal(got[0].before.qty, 11, "before comes from the snapshot");
    assert.equal(got[2].before.qty, 101);
    assert.ok(got[0].changed.includes("qty"));
    assert.notEqual(got[0].source, "gateway");
    cursor = h.store.changes(cursor).cursor;
    assert.deepEqual(h.store.changes(cursor).changes, [], "nothing new after the cursor");
  });

  test(`${name}: the version hash covers declared fields only, and a behind edit is detected`, async () => {
    const rec = await mk(tag("hash"), { qty: 4, kind: "Alpha" });
    assert.equal(rec.hash, recordHash("widget", rec.id, rec.fields));
    assert.deepEqual(await h.store.verify("widget", rec.id, rec.hash), { ok: true, actual: rec.hash });
    await h.touch("widget", rec.id);
    await new Promise((r) => setTimeout(r, 300));
    const touched = await h.store.get("widget", rec.id);
    assert.equal(touched.hash, rec.hash, "a field the language does not declare does not change the hash");
    assert.equal((await h.store.verify("widget", rec.id, rec.hash)).ok, true);
    await h.behind("widget", rec.id, { qty: 5 });
    const v = await h.store.verify("widget", rec.id, rec.hash);
    assert.equal(v.ok, false);
    assert.equal(v.reason, "modified_outside");
    assert.equal((await h.store.verify("widget", mintId(), rec.hash)).ok, false);
  });

  test(`${name}: a sealed field never holds a value`, async () => {
    const t = tag("seal");
    await rejects(() => h.store.create("widget", { id: mintId(), fields: { title: "Leak", tag: t, secret: "123-45-6789" } }), "sealed_value");
    const rec = await mk(t, { secret: SEALED_PLACEHOLDER });
    assert.equal((await h.store.get("widget", rec.id)).fields.secret, SEALED_PLACEHOLDER);
    await rejects(() => h.store.update("widget", rec.id, { secret: "987-65-4321" }, rec.version), "sealed_value");
    const dump = []; for await (const x of h.store.export()) dump.push(JSON.stringify(x));
    assert.ok(dump.length > 0);
    assert.ok(!dump.some((s) => s.includes("123-45-6789") || s.includes("987-65-4321")), "no value in an export");
    assert.ok((await h.store.query("widget", { filter: { tag: t } })).rows.every((/** @type {any} */ r) => r.fields.secret === SEALED_PLACEHOLDER || r.fields.secret === null));
  });

  test(`${name}: export then import into an empty store reproduces the data, ids and soft deletes included`, async () => {
    const t = tag("exp");
    const a = await mk(t, { title: "E1", qty: 1, price: { amount: 5.25, currency: "USD" }, kind: "Gamma", due: "2026-05-05" });
    const b = await mk(t, { title: "E2", qty: 2, owner: "person:alex" });
    await mk(t, { title: "E3", status: "Done" });
    await h.store.remove("widget", b.id);
    const rows = []; for await (const x of h.store.export()) rows.push(x);
    const mine = rows.filter((x) => x.record.fields.tag === t);
    assert.equal(mine.length, 3, "an export includes soft-deleted records");
    const e = await harness.empty(current);
    try {
      const r = await e.store.import(mine);
      assert.equal(r.imported, 3);
      const back = (await e.store.query("widget", { filter: { tag: t }, includeDeleted: true, sort: [{ field: "id" }] })).rows;
      assert.deepEqual(back.map((/** @type {any} */ x) => x.id), mine.map((x) => x.record.id).sort());
      for (const m of mine) { const x = back.find((/** @type {any} */ y) => y.id === m.record.id); assert.deepEqual(x.fields, m.record.fields); assert.equal(x.hash, m.record.hash); assert.equal(!!x.deletedAt, !!m.record.deletedAt); }
      assert.equal((await e.store.get("widget", a.id)).fields.title, "E1");
    } finally { await e.cleanup?.(); }
  });

  test(`${name}: health, version and features`, async () => {
    const hl = await h.store.health(); assert.equal(hl.ok, true);
    const v = await h.store.version(); assert.equal(typeof v.engine, "string");
    const f = h.store.features(); assert.equal(f.cursorPaging, true);
  });

  test(`${name}: clean up`, async () => { await h?.cleanup?.(); });
}
