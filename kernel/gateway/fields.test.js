import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCRATCH } from "../../test/scratch.mjs";
import { bootKernel } from "../boot.js";
import { canonical, sha256 } from "../core/canonical.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob";
const key = Buffer.alloc(32, 7);
const sealer = { presenceCheck: async ({ proof, op, fields }) => (proof && proof.op === op && canonical(proof.fields) === canonical(fields) ? null : "wrong_payload") };
const proofFor = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) } });
const boot = async () => bootKernel({ db: new DatabaseSync(path.join(fs.mkdtempSync(path.join(SCRATCH, "vyre-fields-")), "kernel.db")), space: SPACE, owner: OWNER, owner_uid: 501, key, sealer });
const ownerChain = k => k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });
const bobChain = k => k.chains.fromFacts({ kind: "device", device_key_id: "d-bob", person: BOB, path: "direct" });

const LEAD = { name: "lead", label: "Lead", fields: [
  { name: "name", kind: "text", label: "Name", required: true },
  { name: "budget", kind: "number", label: "Budget", hidden_from: ["member"] },
  { name: "city", kind: "text", label: "City" },
] };

async function rigWithBob() {
  const k = await boot(), o = ownerChain(k), role = { person: BOB, role: "member" };
  await k.gateway.grants.setRole(o, role, { presence: proofFor("grants.role", role, `vyre://${SPACE}/member/${BOB}`) });
  await k.gateway.records.define(o, { add_types: [LEAD] });
  return { k, o, b: bobChain(k) };
}

test("hidden_from: a role never sees the field in a read, a list, a filter, a total or a search, and cannot write it; the owner still can", async () => {
  const { k, o, b } = await rigWithBob(), R = k.gateway.records;
  const lead = await R.create(o, "lead", { name: "Harlow", budget: 5000, city: "Riverton" });
  assert.equal((await R.get(o, "lead", lead.id)).data.budget, 5000);
  assert.equal("budget" in (await R.get(b, "lead", lead.id)).data, false, "not on a read");
  assert.equal("budget" in (await R.query(b, "lead", { page: { limit: 5 } })).rows[0].data, false, "not in a list");
  await assert.rejects(() => R.query(b, "lead", { filter: { field: "budget", op: "gt", value: 1 }, page: { limit: 5 } }), { code: "bad_input" });
  await assert.rejects(() => R.aggregate(b, "lead", { measures: [{ fn: "sum", field: "budget" }] }), { code: "bad_input" });
  await assert.rejects(() => R.update(b, "lead", lead.id, { budget: 1 }, 1), { code: "field_not_allowed" });
  await assert.rejects(() => R.create(b, "lead", { name: "New", budget: 9 }), { code: "field_not_allowed" });
  assert.equal((await R.create(b, "lead", { name: "Fine" })).data.name, "Fine", "the rest of the record is open to the role");
  assert.equal((await R.aggregate(o, "lead", { measures: [{ fn: "sum", field: "budget" }] }))[0].values["sum:budget"], 5000);
});

const CLIENT = { name: "client", label: "Client", fields: [
  { name: "name", kind: "text", label: "Name", required: true },
  { name: "last_contact", kind: "date", label: "Last contact" },
  { name: "budget", kind: "number", label: "Budget", hidden_from: ["member"] },
  { name: "quiet_days", kind: "number", label: "Quiet days", computed: { expr: "days_since(last_contact)" } },
  { name: "budget_k", kind: "number", label: "Budget in thousands", computed: { expr: "round(budget / 1000, 1)" } },
  { name: "fees", kind: "number", label: "Total fees", computed: { over: { type: "case", via: "client", fn: "sum", field: "fee.amount" } } },
  { name: "open_cases", kind: "number", label: "Open cases", computed: { over: { type: "case", via: "client", fn: "count", where: { field: "closed", op: "eq", value: false } } } },
] };
const CASE = { name: "case", label: "Case", fields: [
  { name: "title", kind: "text", label: "Title", required: true },
  { name: "client", kind: "link", to: "client", label: "Client", required: true },
  { name: "fee", kind: "money", label: "Fee" },
  { name: "closed", kind: "boolean", label: "Closed" },
] };

test("computed fields: worked out on read from other fields or from the records that link here, only from what the reader may see, never written or filtered on", async () => {
  const { k, o, b } = await rigWithBob(), R = k.gateway.records;
  await R.define(o, { add_types: [CLIENT, CASE] });
  const daysAgo = n => new Date(Date.now() - n * 86_400_000 - 3600_000).toISOString().slice(0, 10);
  const c = await R.create(o, "client", { name: "Harlow", last_contact: daysAgo(10), budget: 12_345 });
  const d = await R.create(o, "client", { name: "Northwind" });
  await R.create(o, "case", { title: "A", client: { urn: c.urn }, fee: { amount: 300, currency: "USD" }, closed: false });
  await R.create(o, "case", { title: "B", client: { urn: c.urn }, fee: { amount: 200, currency: "USD" }, closed: true });
  const got = (await R.get(o, "client", c.id)).data;
  assert.ok([9, 10, 11].includes(got.quiet_days), `days since: ${got.quiet_days}`);
  assert.equal(got.budget_k, 12.3);
  assert.equal(got.fees, 500);
  assert.equal(got.open_cases, 1);
  const list = (await R.query(o, "client", { sort: [{ field: "name", dir: "asc" }], page: { limit: 10 } })).rows;
  assert.deepEqual(list.map(r => [r.data.name, r.data.fees ?? null, r.data.open_cases]), [["Harlow", 500, 1], ["Northwind", null, 0]], "one total per record in the page; a count with none is 0");
  assert.equal(list[1].data.quiet_days, null, "nothing to work it out from is null, not a guess");
  // a reader who may not see an input gets no value made from it
  const m = (await R.get(b, "client", c.id)).data;
  assert.equal("budget" in m, false);
  assert.equal("budget_k" in m, false, "made from a hidden field, so hidden too");
  assert.equal(m.fees, 500, "a total over records the reader may read");
  // read-only and not queryable
  await assert.rejects(() => R.update(o, "client", d.id, { fees: 5 }, 1), { code: "bad_input" });
  await assert.rejects(() => R.query(o, "client", { filter: { field: "fees", op: "gt", value: 1 }, page: { limit: 5 } }), { code: "bad_input" });
  await assert.rejects(() => R.aggregate(o, "client", { measures: [{ fn: "sum", field: "fees" }] }), { code: "bad_input" });
});

test("computed fields: a bad definition is refused when the type is defined", async () => {
  const { k, o } = await rigWithBob(), R = k.gateway.records;
  const t = f => ({ name: "thing", label: "Thing", fields: [{ name: "a", kind: "number", label: "A" }, { name: "s", kind: "sealed", label: "S", seal: { level: "ai", class: "ssn" } }, f] });
  const bad = (f, why) => assert.rejects(() => R.define(o, { add_types: [t(f)] }), { code: "bad_input" }, why);
  await bad({ name: "x", kind: "number", label: "X", computed: { expr: "a +" } }, "does not parse");
  await bad({ name: "x", kind: "number", label: "X", computed: { expr: "nope + 1" } }, "unknown field");
  await bad({ name: "x", kind: "number", label: "X", computed: { expr: "s" } }, "sealed input");
  await bad({ name: "x", kind: "number", label: "X", computed: { expr: "x + 1" } }, "reads a computed field");
  await bad({ name: "x", kind: "link", to: "thing", label: "X", computed: { expr: "a" } }, "wrong kind");
  await bad({ name: "x", kind: "number", label: "X", computed: { expr: "a", over: { type: "t", via: "v", fn: "count" } } }, "both");
  await bad({ name: "x", kind: "number", label: "X", computed: { over: { type: "t", via: "v", fn: "sum" } } }, "sum needs a field");
  await R.define(o, { add_types: [t({ name: "x", kind: "number", label: "X", computed: { expr: "a * 2" } })] });
});
