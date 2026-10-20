// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { nameOfLabel, bagOf, problemWith, mergeOut, splitIn, bagInQuery, quickFieldsOf, quickRows, forgetQuick, QUICK_MS } from "./quick.js";

const fields = [{ name: "budget", label: "Budget", kind: "number", state: "bag" }, { name: "source", label: "Source", kind: "choice", options: ["Web", "Referral"], state: "bag" }, { name: "tier", label: "Tier", kind: "text", state: "promoting" }];

test("a label becomes a field name", () => {
  assert.equal(nameOfLabel("Next review"), "next_review");
  assert.equal(nameOfLabel("  2nd Phone!! "), "nd_phone");
  assert.equal(nameOfLabel("Budget ($)"), "budget");
});

test("the bag reads from JSON text and survives bad text", () => {
  assert.deepEqual(bagOf('{"a":1}'), { a: 1 });
  assert.deepEqual(bagOf("not json"), {});
  assert.deepEqual(bagOf("[1]"), {});
  assert.deepEqual(bagOf(undefined), {});
});

test("a value must fit its kind", () => {
  assert.equal(problemWith(fields[0], 5), "");
  assert.equal(problemWith(fields[0], "5"), "needs a number");
  assert.equal(problemWith(fields[1], "Web"), "");
  assert.match(problemWith(fields[1], "Fax"), /needs one of: Web, Referral/);
  assert.equal(problemWith({ kind: "date" }, "2026-11-30"), "");
  assert.equal(problemWith({ kind: "date" }, "tomorrow"), "needs a date like 2026-11-30");
  assert.equal(problemWith(fields[0], null), "", "empty is always fine");
});

test("bag values show as ordinary data, and a real value wins", () => {
  const rec = { id: "1", data: { name: "Alex", extra: '{"budget":900,"tier":"gold"}', tier: "silver" } };
  const out = mergeOut(rec, fields);
  assert.equal(out.data.budget, 900);
  assert.equal(out.data.tier, "silver", "the real value is kept over the bag's");
  assert.equal(mergeOut(rec, []), rec);
});

test("a write of a bag field goes to the bag and leaves the others alone", () => {
  const out = splitIn({ name: "Alex", budget: 500, tier: "gold" }, fields, '{"source":"Web"}');
  assert.deepEqual(out, { name: "Alex", tier: "gold", extra: '{"source":"Web","budget":500}' });
  assert.equal(splitIn({ name: "x" }, fields).extra, undefined, "nothing to move, no bag written");
  assert.equal(JSON.parse(splitIn({ budget: null }, fields, '{"budget":1}').extra).budget, undefined, "clearing removes it");
  assert.throws(() => splitIn({ budget: "lots" }, fields), /Budget needs a number/);
});

test("a filter or sort on a bag field is named, a promoting one is not in the way", () => {
  assert.equal(bagInQuery({ filter: { field: "budget", op: "gt", value: 5 } }, fields), "budget");
  assert.equal(bagInQuery({ sort: [{ field: "source", dir: "asc" }] }, fields), "source");
  assert.equal(bagInQuery({ filter: { and: [{ field: "name", op: "eq", value: "x" }, { field: "budget", op: "lt", value: 1 }] } }, fields), "budget");
  assert.equal(bagInQuery({ filter: { field: "tier", op: "eq", value: "a" } }, fields), null);
  assert.equal(bagInQuery({}, fields), null);
});

test("a type's fast fields are read once for many calls, per Space and caller, and read again after a fast field changes", async () => {
  let reads = 0;
  /** @param {string} space @param {string} who */
  const d = (space, who) => ({ space, chain: { hops: [{ actor: { kind: "person", id: who } }] }, gateway: { records: { query: async () => { reads++; return { rows: [{ data: { type: "deal", name: "budget", label: "Budget", kind: "number", state: "bag" } }, { data: { type: "contact", name: "x" } }] }; } } } });
  const a = d("spc_q1", "per_a");
  const got = await Promise.all([quickFieldsOf(a, "deal"), quickFieldsOf(a, "deal"), quickRows(a, "contact")]);
  assert.equal(reads, 1, "a list, a get and a create in a row read the rows once");
  assert.deepEqual(got[0].map((f) => f.name), ["budget"]);
  assert.equal(got[2].length, 1, "each type gets its own");
  await quickFieldsOf(d("spc_q1", "per_b"), "deal");
  assert.equal(reads, 2, "another caller reads her own: what she may see is hers");
  await quickRows(a, "deal", { fresh: true });
  assert.equal(reads, 3, "a change that writes a row reads it now");
  forgetQuick("spc_q1");
  await quickFieldsOf(a, "deal");
  assert.equal(reads, 4, "after a fast field is added or promoted, the Space reads them again");
  assert.ok(QUICK_MS <= 30_000, "kept briefly");
});
