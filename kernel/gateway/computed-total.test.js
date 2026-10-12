// A computed total over linked records (`computed.over`) is an aggregate the gateway runs for the reader. Where the store may not total natively (a record of the type is privileged, or the gateway cannot tell), the
// gateway totals the rows it allows one by one; that path must work out a total over a path into a field (`fee.amount` of a money field) and never answer null. A durable log and a privileged row.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCRATCH } from "../../test/scratch.mjs";
import { bootKernel } from "../boot.js";
import { canonical } from "../core/canonical.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
const sealer = { presenceCheck: async ({ proof, op, fields }) => (proof && proof.op === op && canonical(proof.fields) === canonical(fields) ? null : "wrong_payload") };
const CLIENT = { name: "client", label: "Client", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "fees", kind: "number", label: "Fees", computed: { over: { type: "case", via: "client", fn: "sum", field: "fee.amount" } } }] };
const CASE = { name: "case", label: "Case", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "client", kind: "link", to: "client", label: "Client", required: true }, { name: "fee", kind: "money", label: "Fee" }] };

test("a computed total over linked records is worked out row by row when a record of the type is privileged: the sum of the rows the reader may see, never null", async () => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-computed-total-"));
  const k = await bootKernel({ db: new DatabaseSync(path.join(dir, "kernel.db")), space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), sealer });
  const o = k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });
  const R = k.gateway.records;
  await R.define(o, { add_types: [CLIENT, CASE] });
  const a = await R.create(o, "client", { name: "Harlow" });
  const make = (amount, attrs) => R.create(o, "case", { title: "x", client: { urn: a.urn }, fee: { amount, currency: "USD" } }, attrs ? { attrs } : {});
  await make(300); await make(200);
  const total = async () => (await R.get(o, "client", a.id)).data.fees;
  assert.equal(await total(), 500, "control: with no privileged row the total is 500");
  const secret = await make(1000, { sensitivity: "privileged" });
  assert.ok(secret, "a privileged case now exists");
  const readable = (await R.query(o, "case", { page: { limit: 20 } })).rows.reduce((n, r) => n + r.data.fee.amount, 0);
  assert.ok(readable >= 500, "the owner reads at least the two plain rows");
  assert.equal(await total(), readable, "with a privileged row in the type the total is still worked out, over the rows the reader may read: not null");
});
