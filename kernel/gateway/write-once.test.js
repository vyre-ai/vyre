// A write-once field holds the first value written: a later write that changes or clears it is refused with words that name the field, a write of the same value passes, and a total over
// linked records follows its parts. The definition refuses write_once on a computed or stage field. Real kernel.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
const ESTATE = { name: "estate", label: "Estate", fields: [
  { name: "title", kind: "text", label: "Title" },
  { name: "valued_on", kind: "date", label: "Valuation date", write_once: true },
  { name: "tags", kind: "multi_choice", label: "Tags", options: ["a", "b"], write_once: true },
  { name: "assets_total", kind: "number", label: "Assets total", computed: { over: { type: "estate_asset", via: "estate", fn: "sum", field: "value" } } }] };
const ASSET = { name: "estate_asset", label: "Asset", fields: [{ name: "value", kind: "number", label: "Value" }, { name: "estate", kind: "link", to: "estate", label: "Estate" }] };

async function rig() {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), presence: { check: async () => null } });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  await k.gateway.records.define(owner, { add_types: [ESTATE, ASSET] });
  return { R: k.gateway.records, owner };
}
const fails = p => p.then(() => null, e => e);

test("a write-once field takes its first value, refuses a change or a clear by name, and lets the same value through", async () => {
  const { R, owner } = await rig();
  const e = await R.create(owner, "estate", { title: "Rivera" });
  const set = await R.update(owner, "estate", e.id, { valued_on: "2026-03-01" }, e.version);
  assert.equal(set.data.valued_on, "2026-03-01", "set once while empty");
  const err = await fails(R.update(owner, "estate", e.id, { valued_on: "2026-04-01" }, set.version));
  assert.equal(err && err.code, "field_locked");
  assert.match(err.message, /Valuation date can only be set once/, "the words name the field");
  assert.equal((await fails(R.update(owner, "estate", e.id, { valued_on: null }, set.version))).code, "field_locked", "clearing is a change");
  const same = await R.update(owner, "estate", e.id, { valued_on: "2026-03-01", title: "Rivera estate" }, set.version);
  assert.equal(same.data.title, "Rivera estate", "the same value passes with another change");
  assert.equal((await R.get(owner, "estate", e.id)).data.valued_on, "2026-03-01");
  const l = await R.update(owner, "estate", e.id, { tags: ["a"] }, same.version);
  assert.equal((await fails(R.update(owner, "estate", e.id, { tags: ["a", "b"] }, l.version))).code, "field_locked", "a list is compared whole");
  const made = await R.create(owner, "estate", { title: "Made with it", valued_on: "2026-01-01" });
  assert.equal(made.data.valued_on, "2026-01-01", "a create may set it");
});

test("a total on the record follows its parts", async () => {
  const { R, owner } = await rig();
  const e = await R.create(owner, "estate", { title: "Rivera" });
  const a = await R.create(owner, "estate_asset", { value: 100, estate: { urn: e.urn } });
  await R.create(owner, "estate_asset", { value: 50, estate: { urn: e.urn } });
  assert.equal((await R.get(owner, "estate", e.id)).data.assets_total, 150);
  await R.update(owner, "estate_asset", a.id, { value: 10 }, a.version);
  assert.equal((await R.get(owner, "estate", e.id)).data.assets_total, 60, "a part changed");
});

test("write_once is refused on a computed field and on a stage field", async () => {
  const { R, owner } = await rig();
  const bad = f => fails(R.define(owner, { add_types: [{ name: "x1", label: "X", fields: [{ name: "n", kind: "number", label: "N" }, f] }] }));
  assert.match((await bad({ name: "c", kind: "number", label: "C", write_once: true, computed: { expr: "n" } })).message, /computed field cannot be write-once/);
  assert.match((await bad({ name: "s", kind: "stage", label: "S", options: ["A"], write_once: true })).message, /stage field cannot be write-once/);
  assert.match((await bad({ name: "w", kind: "text", label: "W", write_once: "yes" })).message, /write_once is true or false/);
});
