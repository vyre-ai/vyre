// The planner may only push down what it can prove exact: every page of every query below is compared, row for row and cursor for cursor, against the reference store.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createMemoryStore } from "./memory.js";
import { createSqliteStore } from "./sqlite.js";

let T = 1_800_000_000_000;
const clock = () => ++T;
const CITIES = ["Raleigh", "Austin", "Boston", "Denver"];
const TYPE = { name: "person", label: "Person", fields: [
  { name: "name", kind: "text", label: "Name" }, { name: "city", kind: "choice", label: "City", options: CITIES }, { name: "score", kind: "number", label: "Score" },
  { name: "ok", kind: "boolean", label: "Ok" }, { name: "tags", kind: "multi_choice", label: "Tags", options: ["a", "b", "c"] }, { name: "fee", kind: "money", label: "Fee" },
  { name: "born", kind: "date", label: "Born" }, { name: "stars", kind: "rating", label: "Stars" }, { name: "bio", kind: "text", label: "Bio" },
] };
const rng = seed => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const id = n => `01a${String(n).padStart(5, "0")}-0000-4000-8000-000000000000`;

async function world(n, seed, { nonAscii = false, searchRare } = {}) {
  const r = rng(seed), pick = a => a[Math.floor(r() * a.length)];
  const mem = createMemoryStore({ clock }), sql = createSqliteStore({ db: new DatabaseSync(":memory:"), clock, hotRows: 20, ...(searchRare !== undefined ? { searchRare } : {}) });
  for (const s of [mem, sql]) await s.define({ add_types: [TYPE] });
  const rows = [];
  for (let i = 0; i < n; i++) {
    const d = {};
    if (r() < 0.9) d.name = pick(["Ann", "Bob", "Cy", "Dee", "ann", "BOB", "Eve Smith", "Zed"]) + (r() < 0.3 ? ` ${Math.floor(r() * 5)}` : "");
    if (r() < 0.85) d.city = pick(CITIES);
    if (r() < 0.8) d.score = pick([0, 1, 2, 2, 3, 10, 10.5, -4, 100]);
    if (r() < 0.7) d.ok = r() < 0.5;
    if (r() < 0.5) d.tags = [...new Set([pick(["a", "b", "c"]), pick(["a", "b", "c"])])];
    if (r() < 0.6) d.fee = { amount: Math.floor(r() * 9) * 100, currency: "USD" };
    if (r() < 0.7) d.born = pick(["1990-01-01", "1985-05-05", "2001-12-31", "1990-01-02"]);
    if (r() < 0.6) d.stars = 1 + Math.floor(r() * 5);
    if (r() < 0.5) d.bio = nonAscii && r() < 0.3 ? pick(["café", "\u{1F600} smile", "ＡBC"]) : pick(["x", "alpha", "beta", "Gamma", "delta e"]);
    rows.push({ id: id(i), d });
  }
  for (const { id: rid, d } of rows) { await mem.create("person", rid, d); await sql.create("person", rid, d); }
  // some edits and removals, so versions and deleted rows differ
  for (let i = 0; i < n; i += 7) { for (const s of [mem, sql]) { const cur = await s.get("person", id(i)); await s.update("person", id(i), { score: i % 5 }, cur.version); } }
  for (let i = 3; i < n; i += 11) for (const s of [mem, sql]) { const cur = await s.get("person", id(i)); await s.remove("person", id(i), cur.version); }
  return { mem, sql, r, pick };
}

const FIELDS = ["name", "city", "score", "ok", "fee", "born", "stars", "bio", "id", "version", "tags"];
function randValue(r, pick, f) {
  switch (f) {
    case "name": return pick(["Ann", "Bob", "Cy", "Eve Smith", "ann", "Zed", "Ann 1", null, 5, true]);
    case "city": return pick(CITIES.concat([null, "Nowhere"]));
    case "score": return pick([0, 1, 2, 3, 10, 10.5, -4, 100, null, "2"]);
    case "ok": return pick([true, false, null, 1]);
    case "born": return pick(["1990-01-01", "2001-12-31", "1985-05-05", null]);
    case "stars": return pick([1, 2, 3, 4, 5, null]);
    case "bio": return pick(["x", "alpha", "beta", "Gamma", null, "café"]);
    case "id": return pick([id(5), id(50), id(150)]);
    case "version": return pick([1, 2, 3]);
    case "tags": return pick(["a", "b", "z", 1]);
    default: return pick([null, { amount: 100, currency: "USD" }, 3]);
  }
}
function randFilter(r, pick, depth = 0) {
  const roll = r();
  if (depth < 2 && roll < 0.25) return { and: Array.from({ length: Math.floor(r() * 3) }, () => randFilter(r, pick, depth + 1)) };
  if (depth < 2 && roll < 0.4) return { or: Array.from({ length: Math.floor(r() * 3) }, () => randFilter(r, pick, depth + 1)) };
  if (depth < 2 && roll < 0.5) return { not: randFilter(r, pick, depth + 1) };
  const field = pick(FIELDS);
  const op = pick(["eq", "eq", "ne", "lt", "lte", "gt", "gte", "in", "contains", "is_null"]);
  if (op === "in") return { field, op, value: r() < 0.9 ? Array.from({ length: Math.floor(r() * 4) }, () => randValue(r, pick, field)) : randValue(r, pick, field) };
  if (op === "contains") return { field, op, value: pick(["a", "an", "A", "ob", "x", "", "alp", "e s", "tag", 1]) };
  return { field, op, value: randValue(r, pick, field) };
}
const randSort = (r, pick) => Array.from({ length: Math.floor(r() * 3) }, () => ({ field: pick(FIELDS), dir: pick(["asc", "desc"]) }));

async function drain(store, spec) {
  const out = [], cursors = [];
  let cursor;
  for (let n = 0; n < 200; n++) {
    const p = await store.query("person", { ...spec, page: { limit: spec.page.limit, ...(cursor ? { cursor } : {}) } });
    out.push(...p.rows.map(x => `${x.id}@${x.version}`));
    cursors.push(p.next_cursor ?? null);
    if (!p.next_cursor) break;
    cursor = p.next_cursor;
  }
  return { out, cursors };
}

for (const [name, opts] of [["ASCII data", {}], ["data with characters outside ASCII", { nonAscii: true }]]) {
  test(`planner: ${name}: 600 random queries, every page and cursor equal to the reference`, async () => {
    const { mem, sql, r, pick } = await world(260, name === "ASCII data" ? 7 : 11, opts);
    let pushed = 0;
    for (let q = 0; q < 600; q++) {
      const spec = { filter: r() < 0.85 ? randFilter(r, pick) : undefined, sort: randSort(r, pick), page: { limit: 1 + Math.floor(r() * 40) }, ...(r() < 0.1 ? { include_deleted: true } : {}) };
      const a = await drain(mem, spec).catch(e => ({ error: e.code })), b = await drain(sql, spec).catch(e => ({ error: e.code }));
      assert.deepEqual(b, a, JSON.stringify(spec));
      pushed++;
    }
    assert.equal(pushed, 600);
    const st = sql.stats();
    assert.ok(st.query_pushed > 100, `the planner answered ${st.query_pushed} of ${st.query_pushed + st.query_streamed} pages in SQL`);
  });
}

test("planner: a bad cursor is the same refusal on both stores, and a text sort over non-ASCII data is left to the reference code", async () => {
  const { mem, sql } = await world(40, 3, { nonAscii: true });
  for (const s of [mem, sql]) await assert.rejects(() => s.query("person", { page: { limit: 5, cursor: "not-a-cursor" } }), { code: "invalid" });
  const a = await mem.query("person", { sort: [{ field: "bio", dir: "asc" }], page: { limit: 30 } }), b = await sql.query("person", { sort: [{ field: "bio", dir: "asc" }], page: { limit: 30 } });
  assert.deepEqual(b.rows.map(x => x.id), a.rows.map(x => x.id));
});

test("planner: 400 random aggregates equal the reference, group for group", async () => {
  const { mem, sql, r, pick } = await world(260, 21, {});
  const GROUPS = ["city", "ok", "stars", "name", "born", "score", "version"];
  const MEAS = [{ fn: "count" }, { fn: "count", field: "city" }, { fn: "sum", field: "score" }, { fn: "min", field: "score" }, { fn: "max", field: "stars" }, { fn: "avg", field: "score" }, { fn: "sum", field: "version" }];
  for (let q = 0; q < 400; q++) {
    const spec = { filter: r() < 0.7 ? randFilter(r, pick) : undefined, group_by: Array.from({ length: Math.floor(r() * 3) }, () => pick(GROUPS)), measures: Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(MEAS)) };
    const a = await mem.aggregate("person", spec).catch(e => ({ error: e.code })), b = await sql.aggregate("person", spec).catch(e => ({ error: e.code }));
    assert.deepEqual(b, a, JSON.stringify(spec));
  }
  assert.ok(sql.stats().query_pushed > 50);
});

const WORDS = ["ann", "bob", "eve", "smith", "alp", "gamma", "delta", "café", "émile", "ZED", "an", "x", "e s", "a\"b", "100%", "r_v", "harlow 1", "\u{1F600}"];
const searchIds = async (s, text, limit = 500) => (await s.search({ text, page: { limit } })).rows.map(h => `${h.id}:${h.score}`);

test("search: the full-text index answers exactly what the reference search answers, through writes, removals and restores", async () => {
  const { mem, sql, r, pick } = await world(200, 5, { nonAscii: true });
  await sql.ftsReady;
  assert.equal(sql.stats().fts_built, true);
  const check = async () => { for (let q = 0; q < 120; q++) { const text = Array.from({ length: 1 + Math.floor(r() * 2) }, () => pick(WORDS)).join(" "); assert.deepEqual(await searchIds(sql, text), await searchIds(mem, text), text); } };
  await check();
  for (let i = 1; i < 200; i += 9) for (const s of [mem, sql]) { const cur = await s.get("person", id(i)); if (cur && !cur.deleted_at) await s.update("person", id(i), { name: i % 2 ? "Zed Smith" : "café Ann", bio: null }, cur.version); }
  await check();
  for (const s of [mem, sql]) { await s.remove("person", id(2), (await s.get("person", id(2)))?.version ?? 1).catch(() => {}); await s.restore?.("person", id(3)).catch(() => {}); }
  await check();
});

test("search: a sealed field is never in the full-text index, and an index built after the records existed answers the same", async () => {
  const db = new DatabaseSync(":memory:");
  const s1 = createSqliteStore({ db, clock, hotRows: 10 });
  await s1.define({ add_types: [{ name: "doc", label: "Doc", fields: [{ name: "title", kind: "text", label: "T" }, { name: "ssn", kind: "sealed", label: "S", seal: { level: "ai" } }] }] });
  await s1.create("doc", id(1), { title: "Plain Harlow", ssn: { sealed: "ssn", ref: "sv_secretword", present: true, valid_format: true, set_at: 1 } });
  for (let i = 2; i < 60; i++) await s1.create("doc", id(i), { title: `Harlow number ${i}` });
  assert.equal(db.prepare(`SELECT count(*) n FROM kernel_ftf WHERE kernel_ftf MATCH '"secretword"'`).get().n, 0, "the sealed reference is not indexed");
  assert.equal((await s1.search({ text: "secretword", page: { limit: 10 } })).rows.length, 0);
  // an older database: records present, no index, no flag
  db.exec("DELETE FROM kernel_ftf; DELETE FROM kernel_flags;");
  const s2 = createSqliteStore({ db, clock, hotRows: 10 });
  assert.equal(s2.stats().fts_built, false);
  assert.deepEqual((await s2.search({ text: "harlow", page: { limit: 100 } })).rows.length, 59, "while the index is built the scan answers");
  await s2.ftsReady;
  assert.equal(s2.stats().fts_built, true);
  assert.equal((await s2.search({ text: "harlow", page: { limit: 100 } })).rows.length, 59);
  assert.equal(db.prepare(`SELECT count(DISTINCT rowid >> 10) n FROM kernel_ftf`).get().n, 59);
});

test("search: every page of a ranked search, by cursor, equals the reference's, and a cursor whose record is gone does too", async () => {
  const { mem, sql, r, pick } = await world(220, 9, { nonAscii: true });
  await sql.ftsReady;
  const pages = async (s, text, limit) => { const out = []; let cursor; for (let i = 0; i < 80; i++) { const p = await s.search({ text, page: { limit, ...(cursor ? { cursor } : {}) } }); out.push(p.rows.map(h => `${h.id}:${h.score}:${h.snippet ?? ""}`), p.next_cursor ?? null); if (!p.next_cursor) break; cursor = p.next_cursor; } return out; };
  for (let q = 0; q < 60; q++) { const text = Array.from({ length: 1 + Math.floor(r() * 2) }, () => pick(WORDS)).join(" "), limit = 1 + Math.floor(r() * 12); assert.deepEqual(await pages(sql, text, limit), await pages(mem, text, limit), `${text} / ${limit}`); }
  const first = await mem.search({ text: "ann bob", page: { limit: 3 } });
  for (const s of [mem, sql]) { const cur = await s.get("person", first.rows[2].id); await s.remove("person", cur.id, cur.version); }
  assert.deepEqual(await sql.search({ text: "ann bob", page: { limit: 3, cursor: first.rows[2].id } }), await mem.search({ text: "ann bob", page: { limit: 3, cursor: first.rows[2].id } }));
});

test("search: a type whose definition changes is indexed again, and searches stay equal to the reference meanwhile and after", async () => {
  const { mem, sql, r, pick } = await world(120, 4, {});
  await sql.ftsReady;
  const next = { ...TYPE, fields: [{ name: "bio", kind: "text", label: "Bio" }, { name: "name", kind: "text", label: "Name" }, { name: "city", kind: "choice", label: "City", options: CITIES }] };
  for (const s of [mem, sql]) await s.define({ change_types: [next] });
  assert.equal(sql.stats().fts_built, false, "the index is rebuilt after the change");
  const same = async () => { for (let q = 0; q < 40; q++) { const text = Array.from({ length: 1 + Math.floor(r() * 2) }, () => pick(WORDS)).join(" "); assert.deepEqual(await searchIds(sql, text), await searchIds(mem, text), text); } };
  await same();
  await sql.ftsReady;
  assert.equal(sql.stats().fts_built, true);
  await same();
});

test("search: a common word beside rare ones is ranked without reading its postings, and every page equals the reference's", async () => {
  // searchRare 6: "ann", "bob" and the like reach more than six field rows, a number or a rare name does not
  const { mem, sql, r, pick } = await world(400, 9, { searchRare: 6 });
  await sql.ftsReady;
  const TEXTS = ["ann", "bob", "smith", "alpha", "delta", "ann 3", "bob 2", "smith 4", "ann zed", "eve smith", "ann 10", "alpha beta", "zed", "gamma ann"];
  const pages = async (s, text, limit) => { const out = []; let cursor; for (let i = 0; i < 90; i++) { const p = await s.search({ text, page: { limit, ...(cursor ? { cursor } : {}) } }); out.push(p.rows.map(h => `${h.id}:${h.score}:${h.snippet ?? ""}`), p.next_cursor ?? null); if (!p.next_cursor) break; cursor = p.next_cursor; } return out; };
  const all = async () => { for (const text of TEXTS) for (const limit of [1, 3, 10, 500]) assert.deepEqual(await pages(sql, text, limit), await pages(mem, text, limit), `${text} / ${limit}`); };
  await all();
  assert.ok(sql.stats().search_fast > 0, "the common-word path ran");
  // writes move the bound and the postings; the answers stay the reference's
  for (let i = 1; i < 400; i += 5) for (const s of [mem, sql]) { const cur = await s.get("person", id(i)); if (cur && !cur.deleted_at) await s.update("person", id(i), { name: i % 3 ? "Ann Ann" : "Bob 3 Ann", bio: i % 2 ? "ann" : null }, cur.version); }
  await all();
  for (const s of [mem, sql]) { await s.remove("person", id(7), (await s.get("person", id(7)))?.version ?? 1).catch(() => {}); }
  await all();
  void r; void pick;
});
