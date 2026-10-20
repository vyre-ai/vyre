// Records opens from this device's last copy: what is kept per Space and type, what is never kept (a sealed value), when a copy is too old or not this type's, and which world draws.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FIRST_PAGE, MAX_AGE_MS, ROWS_KEPT, V, countsOf, nextTab, packOpen, pickRecords, recordsKey, unpackOpen, worldFromPage } from "./records-cache.js";

const T = 1_790_000_000_000;
const clock = () => T;
const contact = { name: "contact", label: "Contact", fields: [{ name: "name", kind: "text" }, { name: "ref", kind: "text" }, { name: "org", kind: "link", to: "organization" }, { name: "ssn", kind: "sealed" }, { name: "pin", kind: "text", seal: { level: "ai" } }] };
const organization = { name: "organization", label: "Organization", fields: [{ name: "name", kind: "text" }] };
const deal = { name: "deal", label: "Deal", fields: [{ name: "name", kind: "text" }] };
const org = { urn: "vyre://s1/organization/o1", id: "o1", type: "organization", data: { name: "Harlow Ltd" } };
const people = Array.from({ length: 130 }, (_, i) => ({ urn: `vyre://s1/contact/c${i}`, id: `c${i}`, type: "contact", data: { name: `P${i}`, ref: `PER-${String(i + 1).padStart(4, "0")}`, org: { urn: org.urn }, ssn: { sealed: true, ref: "seal:1" }, pin: "1234" } }));
const full = { types: [contact, organization, deal], byType: { contact: people, organization: [org], deal: [] }, actors: [{ id: "alex", name: "Alex" }], me: "alex" };

test("a copy is per Space and type", () => {
  assert.equal(recordsKey("s1", "contact"), "records.open.s1.contact");
  assert.equal(recordsKey(null, "contact"), "records.open.home.contact", "no Space showing: the home's own");
  assert.notEqual(recordsKey("s1", "contact"), recordsKey("s2", "contact"));
  assert.ok(FIRST_PAGE <= ROWS_KEPT, "a first page fits in what is kept");
});

test("the copy holds the type's first rows, the counts for every tab, the people and the titles its rows link to, and never a sealed value", () => {
  const p = packOpen(full, "contact", clock);
  assert.equal(p.v, V);
  assert.equal(p.rows.length, ROWS_KEPT, "the first rows only");
  assert.deepEqual(p.counts, { contact: 130, organization: 1, deal: 0 }, "a whole world counts every type");
  assert.equal(p.links[org.urn].title, "Harlow Ltd", "a link cell reads as it did");
  assert.equal(Object.keys(p.links).length, 1, "only the titles the kept rows point at");
  const text = JSON.stringify(p);
  assert.ok(!text.includes("seal:1") && !text.includes("1234"), "a sealed field's value never rides, by its definition or by its shape");
  assert.equal(p.rows[0].data.ref, "PER-0001", "the ID shows as it did");
  assert.deepEqual(JSON.parse(text), p, "plain JSON");
});

test("a copy back is a partial world of that type, or nothing when it is another type's, another version's or too old", () => {
  const w = unpackOpen(packOpen(full, "contact", clock), "contact", clock);
  assert.ok(w && w.partial);
  assert.equal(w.byType.contact.length, ROWS_KEPT);
  assert.equal(w.counts.contact, 130);
  assert.equal(w.me, "alex");
  assert.equal(unpackOpen(packOpen(full, "contact", clock), "deal", clock), null, "not this type's");
  assert.equal(unpackOpen({ ...packOpen(full, "contact", clock), v: 0 }, "contact", clock), null, "another version");
  assert.equal(unpackOpen(packOpen(full, "contact", clock), "contact", () => T + MAX_AGE_MS + 1), null, "too old");
  for (const junk of [null, undefined, 3, "x", {}, { v: V, type: "contact" }]) assert.equal(unpackOpen(junk, "contact", clock), null);
});

test("a first page carries the box's count and keeps what a copy knew of the other tabs", () => {
  const kept = unpackOpen(packOpen(full, "contact", clock), "contact", clock);
  const page = worldFromPage({ type: "contact", types: full.types, rows: people.slice(0, FIRST_PAGE), total: 131 }, kept);
  assert.deepEqual(page.counts, { contact: 131, organization: 1, deal: 0 }, "the fresh count wins, the others stand");
  assert.equal(page.actors.length, 1, "the people a copy knew stand until the box names them");
  assert.deepEqual(countsOf(page), page.counts, "a partial world is counted by what the box said, never by the rows it holds");
  const slow = worldFromPage({ type: "contact", types: full.types, rows: people.slice(0, 5), total: null });
  assert.equal(countsOf(slow).contact, undefined, "a count that was too slow is no count, not five");
});

test("the whole world draws when it is here; before it, the first page; before that, the copy; and only with none the loading rows", () => {
  const a = { n: "full" }, b = { n: "page" }, c = { n: "kept" };
  assert.deepEqual(pickRecords(a, b, c), { world: a, stale: false, from: "box" });
  assert.deepEqual(pickRecords(undefined, b, c), { world: b, stale: true, from: "page" });
  assert.deepEqual(pickRecords(undefined, null, c), { world: c, stale: true, from: "kept" });
  assert.deepEqual(pickRecords(undefined, null, null), { world: undefined, stale: false, from: "none" });
});

test("the tab read ahead is the next one, round to the first", () => {
  const tabs = [{ name: "contact" }, { name: "organization" }, { name: "deal" }];
  assert.equal(nextTab(tabs, "contact"), "organization");
  assert.equal(nextTab(tabs, "deal"), "contact");
  assert.equal(nextTab([{ name: "contact" }], "contact"), null, "no other tab");
});

test("Records draws through the copy: the screen asks records-open, which reads the first page with its count and keeps the next tab", async () => {
  const fs = await import("node:fs");
  const block = fs.readFileSync(new URL("../../screens/records/RecordsBlock.tsx", import.meta.url), "utf8");
  assert.match(block, /useRecordsOpen\(type,/, "the records page opens through the copy");
  assert.ok(!/useRecordsWorld\(/.test(block), "and does not wait on the whole world itself");
  const open = fs.readFileSync(new URL("../../screens/records/records-open.ts", import.meta.url), "utf8");
  assert.match(open, /"records\.list", \{ type, limit: FIRST_PAGE, count: true/, "one call for the first page and its count");
  assert.match(open, /perf\.record\("records\.open"/, "the open is measured for the perf lane");
});
