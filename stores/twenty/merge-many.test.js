import "../../scripts/mac-test-guard.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SCRATCH } from "../../test/scratch.mjs";
import { createKernel } from "../../kernel/index.js";
import { createSqliteStore } from "../../kernel/store/sqlite.js";
import { createTwentyStore } from "./store.js";
import { TwentyClient } from "./client.js";
import { FakeTwenty } from "./testing/fake-twenty.js";
import { CORE_TYPES } from "../../records/core-types.js";

const ME = "per_" + "a".repeat(26);
const MATTER = { name: "matter", label: "Matter", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "contacts", kind: "link", label: "Contacts", to: "contact", many: true }] };
const fake = new FakeTwenty(); await fake.start();
after(() => fake.stop());
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

async function world(kind) {
  const space = "spc_" + (kind === "sqlite" ? "aaaaaaaaaaaa" : "bbbbbbbbbbbb");
  let store;
  if (kind === "sqlite") store = createSqliteStore({ db: new DatabaseSync(":memory:") });
  else {
    fake.reset();
    const dir = fs.mkdtempSync(path.join(SCRATCH, "mm-")); dirs.push(dir);
    store = createTwentyStore({ client: new TwentyClient({ url: fake.url, key: () => fake.key, sleep: async () => {} }), space, dir, webhookSecret: crypto.randomBytes(16).toString("hex"), graceMs: 0 });
    await store.define({ add_types: [...CORE_TYPES] });
  }
  const k = await createKernel({ space, owner: ME, owner_uid: 501, key: Buffer.alloc(32, 1), clock: () => Date.now(), presence: { required: () => false, verify: async () => ({ ok: true }) }, store });
  const chain = k.chains.fromFacts({ kind: "device", device_key_id: "d1", person: ME, path: "direct" });
  return { r: k.gateway.records, chain };
}

for (const kind of ["sqlite", "twenty"]) {
  test(`merge over a many-to-many link moves the link rows onto the surviving record (${kind})`, async () => {
    const { r, chain } = await world(kind);
    if (kind === "sqlite") await r.define(chain, { add_types: [...CORE_TYPES] });
    await r.define(chain, { add_types: [MATTER] });
    const a = await r.create(chain, "contact", { name: "Jane Doe", email: "jane@x.test" });
    const b = await r.create(chain, "contact", { name: "J. Doe", email: "jd@x.test" });
    const c = await r.create(chain, "contact", { name: "Other", email: "o@x.test" });
    const m1 = await r.create(chain, "matter", { title: "one", contacts: [{ urn: b.urn }] });
    const m2 = await r.create(chain, "matter", { title: "two", contacts: [{ urn: b.urn }, { urn: c.urn }] });
    const m3 = await r.create(chain, "matter", { title: "three", contacts: [{ urn: a.urn }, { urn: b.urn }] });
    const res = await r.merge(chain, "contact", a.id, b.id).catch(e => { console.log("MERGE FAIL", kind, e.code, e.message, e.stack.split("\n").slice(1,4).join(" | ")); throw e; });
    assert.equal(res.relinked, 3);
    const urns = async m => (await r.get(chain, "matter", m.id)).data.contacts.map(x => x.urn).sort();
    assert.deepEqual(await urns(m1), [a.urn], "m1 after merge");
    assert.deepEqual(await urns(m2), [a.urn, c.urn].sort(), "m2 after merge");
    assert.deepEqual(await urns(m3), [a.urn], "m3: a matter that had both ends with one link, never a repeat");
    const back = await r.unmerge(chain, res.merge_id);
    assert.equal(back.relinked, 3);
    assert.deepEqual(await urns(m1), [b.urn], "m1 after unmerge");
    assert.deepEqual(await urns(m2), [b.urn, c.urn].sort(), "m2 after unmerge");
    assert.deepEqual(await urns(m3), [a.urn, b.urn].sort(), "m3 after unmerge");
  });
}
