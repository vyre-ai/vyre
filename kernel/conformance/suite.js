// kernel/conformance/suite.js: the conformance suite. It defines what "a store" is (contract 3.5). Any store (the
// in-memory reference, Twenty, a file store) registers these tests against a factory that returns a fresh, empty store.
// A store that passes carries the revision in `version().conformance`. The gateway never relies on a store for
// permissions, so nothing here tests who may see what; it tests that the store keeps our ids, versions and values.
import { mintUuid } from "../core/ids.js";
import { canonical, sha256 } from "../core/canonical.js";

export const SUITE_REVISION = 7;

export const CONTACT = Object.freeze({
  name: "contact", label: "Contact",
  fields: [
    { name: "name", kind: "text", label: "Name", required: true },
    { name: "age", kind: "number", label: "Age" },
    { name: "tags", kind: "multi_choice", label: "Tags", options: ["vip", "lead", "cold"] },
    { name: "status", kind: "choice", label: "Status", options: ["open", "closed"] },
    { name: "fee", kind: "money", label: "Fee" },
    { name: "born", kind: "date", label: "Born" },
    { name: "ssn", kind: "sealed", label: "SSN", seal: { level: "ai", class: "ssn" } },
  ],
});

/** A type with a unique field, for the unique cases (revision 4). */
export const ACCOUNT = Object.freeze({
  name: "account", label: "Account",
  fields: [
    { name: "name", kind: "text", label: "Name", required: true },
    { name: "handle", kind: "text", label: "Handle", unique: true },
    { name: "seats", kind: "number", label: "Seats" },
  ],
});

/** A type with links, for the relation cases (revision 6): one contact (a single link) and a list of contacts (a many link), each with a named inverse. */
export const LEAD = Object.freeze({
  name: "lead", label: "Lead",
  fields: [
    { name: "title", kind: "text", label: "Title", required: true },
    { name: "contact", kind: "link", label: "Contact", to: "contact", inverse: { name: "leads", label: "Leads" } },
    { name: "referrers", kind: "link", label: "Referred by", to: "contact", many: true, inverse: { name: "referred", label: "Referred" } },
  ],
});
/** The Space id the suite's link urns name: a store that holds links as relations needs to be made for this Space (the memory and built-in stores do not care). */
export const SUITE_SPACE = "spc_aaaaaaaaaaaa";
const SPACE_URN = `vyre://${SUITE_SPACE}`;
const ref = (/** @type {string} */ r = "sv_1") => ({ sealed: "ssn", ref: r, present: true, valid_format: true, set_at: 1 });

/**
 * @param {() => Promise<any>} make a fresh empty store
 * @param {{ test: (name: string, fn: () => Promise<void>) => void, assert: any }} t node:test and node:assert/strict
 * @param {string} [label]
 */
export function conformance(make, { test, assert }, label = "store") {
  const T = (/** @type {string} */ name, /** @type {(s: any) => Promise<void>} */ fn) => test(`conformance (${label}): ${name}`, async () => { const s = await make(); await s.define({ add_types: [CONTACT] }); await fn(s); });
  const code = (/** @type {string} */ c) => (/** @type {any} */ e) => { assert.equal(e && e.code, c, `expected ${c}, got ${e && e.code}: ${e && e.message}`); return true; };
  const add = (/** @type {any} */ s, /** @type {any} */ data) => { const id = mintUuid(); return s.create("contact", id, data).then((/** @type {any} */ r) => { assert.equal(r.id, id, "the store must keep the id it was given"); return r; }); };

  T("define is idempotent and reports what changed", async s => {
    const again = await s.define({ add_types: [CONTACT] });
    assert.deepEqual([again.applied, again.changes], [false, []]);
    const changed = await s.define({ change_types: [{ ...CONTACT, label: "Person" }] });
    assert.equal(changed.applied, true);
    assert.ok(changed.changes.length > 0);
    await assert.rejects(() => s.define({ change_types: [{ name: "nope", label: "x", fields: [] }] }), code("unknown_type"));
  });

  T("create keeps our id, starts at version 1 and round-trips every kind", async s => {
    const r = await add(s, { name: "Jane", age: 41, tags: ["vip"], status: "open", fee: { amount: 250, currency: "USD" }, born: "1980-02-03", ssn: ref() });
    assert.equal(r.version, 1);
    assert.deepEqual((await s.get("contact", r.id)).data, r.data);
    assert.equal(r.data.ssn.ref, "sv_1");
  });

  T("a returned record is a copy: changing it changes nothing in the store", async s => {
    const r = await add(s, { name: "Jane" });
    r.data.name = "Mallory";
    const got = await s.get("contact", r.id);
    got.data.name = "Mallory";
    assert.equal((await s.get("contact", r.id)).data.name, "Jane");
  });

  T("create refuses a bad id, a duplicate id, an unknown type, an unknown field and invalid values", async s => {
    await assert.rejects(() => s.create("contact", "not-a-uuid", { name: "x" }), code("invalid"));
    const r = await add(s, { name: "Jane" });
    await assert.rejects(() => s.create("contact", r.id, { name: "Dup" }), code("invalid"));
    await assert.rejects(() => s.create("nope", mintUuid(), {}), code("unknown_type"));
    await assert.rejects(() => add(s, { name: "x", bogus: 1 }), code("unknown_field"));
    await assert.rejects(() => add(s, { age: 3 }), code("invalid"));
    await assert.rejects(() => add(s, { name: "x", age: "old" }), code("invalid"));
    await assert.rejects(() => add(s, { name: "x", status: "limbo" }), code("invalid"));
    await assert.rejects(() => add(s, { name: "x", tags: ["vip", "nope"] }), code("invalid"));
    await assert.rejects(() => add(s, { name: "x", fee: { amount: 1, currency: "usd" } }), code("invalid"));
    await assert.rejects(() => add(s, { name: "x", born: "yesterday" }), code("invalid"));
  });

  T("a sealed field never takes a value, only a reference", async s => {
    await assert.rejects(() => add(s, { name: "x", ssn: "123-45-6789" }), code("sealed_value_refused"));
    const r = await add(s, { name: "x", ssn: ref() });
    await assert.rejects(() => s.update("contact", r.id, { ssn: "987-65-4321" }, 1), code("sealed_value_refused"));
    assert.equal((await s.get("contact", r.id)).data.ssn.ref, "sv_1");
  });

  T("update merges a patch, null removes a field, and the version has to be the one the caller read", async s => {
    const r = await add(s, { name: "Jane", age: 41 });
    const u = await s.update("contact", r.id, { age: null, status: "open" }, 1);
    assert.equal(u.version, 2);
    assert.deepEqual(u.data, { name: "Jane", status: "open" });
    await assert.rejects(() => s.update("contact", r.id, { name: "Old" }, 1), code("version_conflict"));
    await assert.rejects(() => s.update("contact", r.id, { name: null }, 2), code("invalid"));
    await assert.rejects(() => s.update("contact", mintUuid(), { name: "x" }, 1), code("not_found"));
    assert.equal((await s.get("contact", r.id)).version, 2, "a refused update changes nothing");
  });

  T("remove is a soft delete, restore brings it back, both bump the version and check it", async s => {
    const r = await add(s, { name: "Jane" });
    await assert.rejects(() => s.remove("contact", r.id, 9), code("version_conflict"));
    const gone = await s.remove("contact", r.id, 1);
    assert.equal(gone.version, 2);
    assert.ok(gone.deleted_at);
    assert.equal(await s.get("contact", r.id), null);
    assert.equal((await s.get("contact", r.id, { include_deleted: true })).version, 2);
    assert.equal((await s.query("contact", { page: { limit: 10 } })).rows.length, 0);
    assert.equal((await s.query("contact", { page: { limit: 10 }, include_deleted: true })).rows.length, 1);
    await assert.rejects(() => s.remove("contact", r.id, 2), code("not_found"));
    await assert.rejects(() => s.update("contact", r.id, { name: "x" }, 2), code("not_found"));
    const back = await s.restore("contact", r.id);
    assert.equal(back.version, 3);
    assert.equal(back.deleted_at, undefined);
    await assert.rejects(() => s.restore("contact", r.id), code("not_found"));
  });

  T("query filters with every operator, and and/or/not", async s => {
    await add(s, { name: "Ann", age: 20, tags: ["vip"], status: "open" });
    await add(s, { name: "Bob", age: 30, tags: ["lead"], status: "closed" });
    await add(s, { name: "Cy", age: 40, tags: ["vip", "lead"] });
    const q = async (/** @type {any} */ filter) => (await s.query("contact", { filter, sort: [{ field: "name", dir: "asc" }], page: { limit: 50 } })).rows.map((/** @type {any} */ r) => r.data.name);
    assert.deepEqual(await q({ field: "age", op: "gt", value: 20 }), ["Bob", "Cy"]);
    assert.deepEqual(await q({ field: "age", op: "gte", value: 20 }), ["Ann", "Bob", "Cy"]);
    assert.deepEqual(await q({ field: "age", op: "lt", value: 30 }), ["Ann"]);
    assert.deepEqual(await q({ field: "age", op: "lte", value: 30 }), ["Ann", "Bob"]);
    assert.deepEqual(await q({ field: "name", op: "eq", value: "Bob" }), ["Bob"]);
    assert.deepEqual(await q({ field: "name", op: "ne", value: "Bob" }), ["Ann", "Cy"]);
    assert.deepEqual(await q({ field: "name", op: "in", value: ["Ann", "Cy"] }), ["Ann", "Cy"]);
    assert.deepEqual(await q({ field: "tags", op: "contains", value: "lead" }), ["Bob", "Cy"]);
    assert.deepEqual(await q({ field: "name", op: "contains", value: "an" }), ["Ann"]);
    assert.deepEqual(await q({ field: "status", op: "is_null" }), ["Cy"]);
    assert.deepEqual(await q({ and: [{ field: "tags", op: "contains", value: "vip" }, { not: { field: "name", op: "eq", value: "Ann" } }] }), ["Cy"]);
    assert.deepEqual(await q({ or: [{ field: "age", op: "lt", value: 25 }, { field: "age", op: "gt", value: 35 }] }), ["Ann", "Cy"]);
  });

  T("cursor paging: every row once, in order, and stable while rows are added and removed between pages", async s => {
    const names = [];
    for (let i = 0; i < 25; i++) { const n = `n${String(i).padStart(2, "0")}`; names.push(n); await add(s, { name: n, age: i % 5 }); }
    const seen = [];
    let cursor;
    let round = 0;
    for (;;) {
      const p = await s.query("contact", { sort: [{ field: "age", dir: "desc" }, { field: "name", dir: "asc" }], page: { limit: 7, ...(cursor ? { cursor } : {}) } });
      seen.push(...p.rows.map((/** @type {any} */ r) => r.data.name));
      if (round++ === 0) await add(s, { name: "zz-late", age: 0 });
      if (!p.next_cursor) break;
      assert.ok(round < 20, "paging did not finish: the cursor never advances");
      assert.equal(typeof p.next_cursor, "string");
      cursor = p.next_cursor;
    }
    const expect = [...names].sort((a, b) => { const x = Number(a.slice(1)) % 5, y = Number(b.slice(1)) % 5; return y - x || (a < b ? -1 : 1); });
    assert.deepEqual(seen.filter(n => n !== "zz-late"), expect);
    assert.equal(new Set(seen).size, seen.length, "no row twice");
    await assert.rejects(() => s.query("contact", { page: { limit: 5, cursor: "garbage" } }), code("invalid"));
  });

  T("aggregate: count, sum, min, max and avg, grouped and not", async s => {
    await add(s, { name: "A", age: 10, status: "open" });
    await add(s, { name: "B", age: 20, status: "open" });
    await add(s, { name: "C", age: 40, status: "closed" });
    const all = await s.aggregate("contact", { measures: [{ fn: "count" }, { fn: "sum", field: "age" }, { fn: "avg", field: "age" }, { fn: "min", field: "age" }, { fn: "max", field: "age" }] });
    assert.deepEqual(all, [{ group: {}, values: { count: 3, "sum:age": 70, "avg:age": 70 / 3, "min:age": 10, "max:age": 40 } }]);
    const by = await s.aggregate("contact", { group_by: ["status"], measures: [{ fn: "count" }, { fn: "sum", field: "age" }] });
    assert.deepEqual(by.map((/** @type {any} */ r) => [r.group.status, r.values.count, r.values["sum:age"]]).sort(), [["closed", 1, 40], ["open", 2, 30]]);
    const none = await s.aggregate("contact", { filter: { field: "age", op: "gt", value: 99 }, measures: [{ fn: "count" }, { fn: "sum", field: "age" }] });
    assert.deepEqual(none, [{ group: {}, values: { count: 0, "sum:age": null } }]);
  });

  T("search finds text, ranks by hits, skips deleted records and sealed fields, and pages", async s => {
    const a = await add(s, { name: "Jane Harlow", ssn: ref() });
    await add(s, { name: "Harlow Legal" });
    await add(s, { name: "Unrelated" });
    const hits = await s.search({ text: "harlow", page: { limit: 10 } });
    assert.deepEqual(hits.rows.map((/** @type {any} */ h) => h.type), ["contact", "contact"]);
    assert.ok(hits.rows.every((/** @type {any} */ h) => h.score >= 1));
    assert.equal((await s.search({ text: "sv_1", page: { limit: 10 } })).rows.length, 0, "a sealed reference is not indexed");
    const first = await s.search({ text: "harlow", page: { limit: 1 } });
    assert.equal(first.rows.length, 1);
    assert.ok(first.next_cursor);
    assert.equal((await s.search({ text: "harlow", page: { limit: 1, cursor: first.next_cursor } })).rows.length, 1);
    await s.remove("contact", a.id, 1);
    assert.equal((await s.search({ text: "harlow", page: { limit: 10 } })).rows.length, 1);
    assert.equal((await s.search({ text: "harlow", types: ["other"], page: { limit: 10 } })).rows.length, 0);
  });

  T("changes reports every change in order, with a cursor that resumes", async s => {
    const a = await add(s, { name: "A" });
    await s.update("contact", a.id, { age: 5 }, 1);
    await s.remove("contact", a.id, 2);
    await s.restore("contact", a.id);
    const first = await s.changes(null, 2);
    assert.deepEqual(first.entries.map((/** @type {any} */ e) => e.kind), ["created", "updated"]);
    const rest = await s.changes(first.cursor, 10);
    assert.deepEqual(rest.entries.map((/** @type {any} */ e) => e.kind), ["removed", "restored"]);
    assert.deepEqual(rest.entries.map((/** @type {any} */ e) => e.version), [3, 4]);
    assert.deepEqual((await s.changes(rest.cursor, 10)).entries, []);
    await assert.rejects(() => s.changes("zzz", 5), code("invalid"));
  });

  T("describe lists a type's fields with their kinds, and null for no such type", async s => {
    await s.define({ add_types: [CONTACT] });
    const d = await s.describe("contact");
    assert.equal(d.fields.find((/** @type {any} */ f) => f.name === "ssn").kind, "sealed");
    assert.equal(d.fields.length, CONTACT.fields.length);
    assert.equal(await s.describe("nope"), null);
  });

  T("types lists every definition the store holds", async s => {
    await s.define({ add_types: [CONTACT] });
    assert.deepEqual((await s.types()).map((/** @type {any} */ t) => t.name), ["contact"]);
  });

  // ---- revision 4: unique fields ----
  const acct = (/** @type {any} */ s, /** @type {any} */ data) => s.create("account", mintUuid(), data);

  T("unique: two concurrent creates with the same value make one record and one clean refusal", async s => {
    await s.define({ add_types: [ACCOUNT] });
    const results = await Promise.allSettled([acct(s, { name: "A", handle: "harlow" }), acct(s, { name: "B", handle: "harlow" }), acct(s, { name: "C", handle: "harlow" })]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1, "exactly one create wins");
    for (const r of results.filter(r => r.status === "rejected")) assert.equal(/** @type {any} */ (r).reason.code, "unique_violation");
    assert.equal((await s.query("account", { page: { limit: 10 } })).rows.length, 1);
  });

  T("unique: an update into a taken value is refused and the record keeps its value and version", async s => {
    await s.define({ add_types: [ACCOUNT] });
    await acct(s, { name: "A", handle: "harlow" });
    const b = await acct(s, { name: "B", handle: "northwind" });
    await assert.rejects(() => s.update("account", b.id, { handle: "harlow" }, 1), code("unique_violation"));
    const again = await s.get("account", b.id);
    assert.equal(again.data.handle, "northwind"); assert.equal(again.version, 1);
    assert.equal((await s.update("account", b.id, { handle: "northwind", seats: 3 }, 1)).version, 2, "keeping its own value is not a collision");
  });

  T("unique: a removed record frees its value, and restoring it is refused while the value is taken", async s => {
    await s.define({ add_types: [ACCOUNT] });
    const a = await acct(s, { name: "A", handle: "harlow" });
    await s.remove("account", a.id, 1);
    const b = await acct(s, { name: "B", handle: "harlow" });
    await assert.rejects(() => s.restore("account", a.id), code("unique_violation"));
    await s.remove("account", b.id, 1);
    assert.equal((await s.restore("account", a.id)).data.handle, "harlow");
  });

  T("unique: null and absent values never collide", async s => {
    await s.define({ add_types: [ACCOUNT] });
    await acct(s, { name: "A" }); await acct(s, { name: "B" });
    const c = await acct(s, { name: "C", handle: "x" });
    await s.update("account", c.id, { handle: null }, 1);
    await acct(s, { name: "D", handle: "x" });
    assert.equal((await s.query("account", { page: { limit: 10 } })).rows.length, 4);
  });

  T("unique: turning it on over existing duplicates is refused and changes nothing", async s => {
    await s.define({ add_types: [{ ...ACCOUNT, fields: ACCOUNT.fields.map(f => (f.name === "handle" ? { ...f, unique: false } : f)) }] });
    await acct(s, { name: "A", handle: "dup" }); await acct(s, { name: "B", handle: "dup" });
    await assert.rejects(() => s.define({ change_types: [ACCOUNT] }), code("unique_violation"));
    await acct(s, { name: "C", handle: "dup" });
    assert.equal((await s.query("account", { page: { limit: 10 } })).rows.length, 3, "the type is unchanged, so duplicates are still allowed");
  });

  // ---- revision 5: totals have no row cap ----
  T("aggregate: a total is exact over more rows than one page, with no ceiling, and never counts a removed record", async s => {
    const n = 650, gone = [];
    for (let i = 0; i < n; i++) { const r = await add(s, { name: `n${i}`, age: i, status: i % 3 === 0 ? "closed" : "open" }); if (i % 50 === 7) gone.push(r); }
    for (const r of gone) await s.remove("contact", r.id, 1);
    const live = Array.from({ length: n }, (_, i) => i).filter(i => i % 50 !== 7);
    const all = await s.aggregate("contact", { measures: [{ fn: "count" }, { fn: "sum", field: "age" }, { fn: "min", field: "age" }, { fn: "max", field: "age" }] });
    assert.deepEqual(all, [{ group: {}, values: { count: live.length, "sum:age": live.reduce((a, b) => a + b, 0), "min:age": 0, "max:age": n - 1 } }]);
    const by = await s.aggregate("contact", { group_by: ["status"], measures: [{ fn: "count" }] });
    assert.deepEqual(by.map((/** @type {any} */ r) => [r.group.status, r.values.count]).sort(), [["closed", live.filter(i => i % 3 === 0).length], ["open", live.filter(i => i % 3 !== 0).length]]);
  });

  T("types keeps the whole definition: a hidden field, a role mark, and the data of a hidden field is still stored", async s => {
    const t = { name: "client", label: "Client", role: { link: "who", ended: ["Gone"] }, fields: [
      { name: "who", kind: "link", label: "Who", to: "contact", required: true },
      { name: "stage", kind: "stage", label: "Stage", options: ["On", "Gone"] },
      { name: "old", kind: "text", label: "Old", hidden: true },
    ], stages: [{ name: "On" }, { name: "Gone" }] };
    await s.define({ add_types: [t] });
    assert.deepEqual((await s.types()).find((/** @type {any} */ x) => x.name === "client"), t);
    const who = await add(s, { name: "Who" });
    const r = await s.create("client", mintUuid(), { who: { urn: `${SPACE_URN}/contact/${who.id}` }, stage: "On", old: "kept" });
    assert.equal((await s.get("client", r.id)).data.old, "kept");
  });

  T("search: a record holding every word ranks above one holding some", async s => {
    await add(s, { name: "Harlow Legal" });
    const both = await add(s, { name: "Jane Harlow" });
    await add(s, { name: "Jane Doe" });
    await add(s, { name: "Northwind" });
    const hits = await s.search({ text: "jane harlow", page: { limit: 10 } });
    assert.equal(hits.rows[0].id, both.id, "the record with both words is first");
    assert.equal(hits.rows.length, 3, "records with one of the words follow");
    const p1 = await s.search({ text: "jane harlow", page: { limit: 2 } });
    assert.equal(p1.rows.length, 2); assert.ok(p1.next_cursor);
    const p2 = await s.search({ text: "jane harlow", page: { limit: 2, cursor: p1.next_cursor } });
    assert.deepEqual([...p1.rows, ...p2.rows].map((/** @type {any} */ h) => h.id), hits.rows.map((/** @type {any} */ h) => h.id), "pages walk the same order");
  });

  T("health, version and features are honest", async s => {
    const h = await s.health();
    assert.equal(h.ok, true);
    assert.equal(typeof h.checked_at, "number");
    const v = await s.version();
    assert.equal(typeof v.store, "string");
    assert.equal(v.conformance, SUITE_REVISION, "a store reports the suite revision it last passed");
    const f = s.features();
    assert.equal(f.cursor_paging, true);
    for (const k of ["aggregate", "search", "changes"]) assert.equal(typeof f[k], "boolean");
  });

  T("export streams every record in chunks whose checksum covers them", async s => {
    for (let i = 0; i < 130; i++) await add(s, { name: `n${i}` });
    let n = 0, last;
    for await (const c of s.export()) {
      assert.equal(c.checksum, sha256(canonical(c.records)));
      n += c.records.length; last = c;
    }
    assert.equal(n, 130);
    assert.equal(last.done, true);
  });

  // ---- links (revision 6): a link is one end of a relation; a store holds it the best way it can and answers the same ----
  /** @param {any} s */
  const withLead = async s => { await s.define({ add_types: [LEAD] }); };
  const link = (/** @type {string} */ id) => ({ urn: `${SPACE_URN}/contact/${id}` });
  const ids = (/** @type {any[]} */ rows) => rows.map(r => r.id).sort();
  const urns = (/** @type {any} */ v) => (Array.isArray(v) ? v.map((/** @type {any} */ x) => x.urn).sort() : []);

  T("links: a single link keeps its reference, changes, clears, and is found by eq, in and is_null", async s => {
    await withLead(s);
    const a = await add(s, { name: "A" }), b = await add(s, { name: "B" });
    const l = await s.create("lead", mintUuid(), { title: "x", contact: link(a.id) });
    assert.deepEqual((await s.get("lead", l.id)).data.contact, link(a.id));
    assert.deepEqual(ids((await s.query("lead", { filter: { field: "contact", op: "eq", value: link(a.id) }, page: { limit: 10 } })).rows), [l.id]);
    assert.deepEqual(ids((await s.query("lead", { filter: { field: "contact", op: "eq", value: link(b.id) }, page: { limit: 10 } })).rows), []);
    const moved = await s.update("lead", l.id, { contact: link(b.id) }, 1);
    assert.deepEqual(moved.data.contact, link(b.id));
    assert.deepEqual(ids((await s.query("lead", { filter: { field: "contact", op: "in", value: [link(a.id), link(b.id)] }, page: { limit: 10 } })).rows), [l.id]);
    const none = await s.create("lead", mintUuid(), { title: "y" });
    assert.deepEqual(ids((await s.query("lead", { filter: { field: "contact", op: "is_null" }, page: { limit: 10 } })).rows), [none.id]);
    const cleared = await s.update("lead", l.id, { contact: null }, 2);
    assert.equal(cleared.data.contact, undefined);
    assert.deepEqual(ids((await s.query("lead", { filter: { field: "contact", op: "is_null" }, page: { limit: 10 } })).rows), ids([l, none]));
  });

  T("links: a many link keeps a set of references, adds and removes members, and is found by contains", async s => {
    await withLead(s);
    const a = await add(s, { name: "A" }), b = await add(s, { name: "B" }), c = await add(s, { name: "C" });
    const l = await s.create("lead", mintUuid(), { title: "x", referrers: [link(a.id), link(b.id)] });
    assert.deepEqual(urns((await s.get("lead", l.id)).data.referrers), urns([link(a.id), link(b.id)]));
    assert.deepEqual(ids((await s.query("lead", { filter: { field: "referrers", op: "contains", value: link(b.id) }, page: { limit: 10 } })).rows), [l.id]);
    assert.deepEqual(ids((await s.query("lead", { filter: { field: "referrers", op: "contains", value: link(c.id) }, page: { limit: 10 } })).rows), []);
    const u1 = await s.update("lead", l.id, { referrers: [link(b.id), link(c.id)] }, 1);
    assert.deepEqual(urns(u1.data.referrers), urns([link(b.id), link(c.id)]), "a is out, c is in");
    assert.deepEqual(ids((await s.query("lead", { filter: { field: "referrers", op: "contains", value: link(a.id) }, page: { limit: 10 } })).rows), []);
    const u2 = await s.update("lead", l.id, { referrers: [] }, 2);
    assert.deepEqual(u2.data.referrers ?? [], [], "an empty list is no links");
    assert.deepEqual(ids((await s.query("lead", { filter: { field: "referrers", op: "contains", value: link(b.id) }, page: { limit: 10 } })).rows), []);
  });

  T("links: the records that link to one record are found by a filter on the link, in pages, and a two-sided relation lists both ways", async s => {
    await withLead(s);
    const a = await add(s, { name: "A" }), b = await add(s, { name: "B" });
    const mine = [];
    for (let i = 0; i < 5; i++) mine.push((await s.create("lead", mintUuid(), { title: `m${i}`, contact: link(a.id), referrers: [link(b.id)] })).id);
    for (let i = 0; i < 3; i++) await s.create("lead", mintUuid(), { title: `o${i}`, contact: link(b.id) });
    const f = { field: "contact", op: "eq", value: link(a.id) };
    const p1 = await s.query("lead", { filter: f, page: { limit: 2 } });
    assert.equal(p1.rows.length, 2); assert.ok(p1.next_cursor);
    const seen = [...p1.rows];
    // bounded: a store whose cursor repeats the first page forever must fail here, not grow without end (the "teeth" test with a repeating pager once ran a 4 GB heap out)
    let pages = 1;
    for (let cursor = p1.next_cursor; cursor;) { assert.ok(++pages <= 10, "paging did not finish: the cursor never advances"); const p = await s.query("lead", { filter: f, page: { limit: 2, cursor } }); seen.push(...p.rows); cursor = p.next_cursor; }
    assert.deepEqual(ids(seen), mine.slice().sort(), "every linked record once");
    assert.equal(ids((await s.query("lead", { filter: { field: "referrers", op: "contains", value: link(b.id) }, page: { limit: 20 } })).rows).length, 5, "the many side lists the same way");
    const total = await s.aggregate("lead", { group_by: [], measures: [{ fn: "count" }], filter: f });
    assert.equal(total[0].values.count, 5);
  });

  T("links: removing the target never breaks a link, and restoring it brings the link back", async s => {
    await withLead(s);
    const a = await add(s, { name: "A" }), b = await add(s, { name: "B" });
    const l = await s.create("lead", mintUuid(), { title: "x", contact: link(a.id), referrers: [link(a.id), link(b.id)] });
    await s.remove("contact", a.id, a.version);
    await s.restore("contact", a.id, 2);
    const back = (await s.get("lead", l.id)).data;
    assert.deepEqual(back.contact, link(a.id));
    assert.deepEqual(urns(back.referrers), urns([link(a.id), link(b.id)]));
    assert.deepEqual(ids((await s.query("lead", { filter: { field: "contact", op: "eq", value: link(a.id) }, page: { limit: 10 } })).rows), [l.id]);
  });

  T("kernel attributes given at create are there on the first read, with no later write", async s => {
    // a store that offers attr_filter takes the record's attributes with its create (`opts.attrs`, `opts.urn`): the very first query by attribute finds it. A store without the feature has nothing to check.
    if (!s.features().attr_filter) return;
    const id = mintUuid();
    const u = `${SPACE_URN}/contact/${id}`;
    await s.create("contact", id, { name: "Attr" }, { attrs: { space: SUITE_SPACE, created_by: "person:per_a", owner: "per_o" }, urn: u });
    const mine = await s.query("contact", { attr_filter: { urn_prefix: `${SPACE_URN}/contact/`, any: [{ created_by: "person:per_a" }] }, page: { limit: 10 } });
    assert.deepEqual(ids(mine.rows), [id], "the record is found by its created_by on the first read");
    const other = await s.query("contact", { attr_filter: { urn_prefix: `${SPACE_URN}/contact/`, any: [{ created_by: "person:per_b" }] }, page: { limit: 10 } });
    assert.deepEqual(ids(other.rows), [], "and by nobody else's");
  });

  T("links: the definition keeps many and the named inverse as given", async s => {
    await withLead(s);
    const t = (await s.types()).find((/** @type {any} */ x) => x.name === "lead");
    assert.deepEqual(t.fields.find((/** @type {any} */ f) => f.name === "referrers"), LEAD.fields[2]);
    assert.deepEqual(t.fields.find((/** @type {any} */ f) => f.name === "contact").inverse, { name: "leads", label: "Leads" });
  });
}
