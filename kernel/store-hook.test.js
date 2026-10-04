import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { bootHomeKernel } from "./home.js";
import { createMemoryStore } from "./store/memory.js";
import { CONTACT } from "./conformance/suite.js";
import { tempHome } from "../test/helpers.js";

process.env.VYRE_SEAL_DEV = "1";

test("the Space's record store is the one the caller brings (the per-Space Twenty), for the home's own kernel; grants, tasks and the log stay in the home's SQLite", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  const seen = [];
  const inner = createMemoryStore({});
  const store = new Proxy(inner, { get: (o, k) => (typeof o[k] === "function" ? (...a) => { seen.push(String(k)); return o[k](...a); } : o[k]) });
  const asked = [];
  const k = await bootHomeKernel({ db: new DatabaseSync(path.join(root, "k.db")), root, log: () => {}, isFirstParty: () => false, storeFor: async (space, meta) => { asked.push([space, typeof meta]); return store; } });
  t.after(() => k.stop());
  assert.deepEqual(asked, [[k.id.space, "object"]], "asked once, for the home's own Space");
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: k.id.owner, path: "direct", session: "s" });
  await k.gateway.records.define(owner, { add_types: [CONTACT] });
  const c = await k.gateway.records.create(owner, "contact", { name: "Jane" });
  assert.equal((await k.gateway.records.get(owner, "contact", c.id)).data.name, "Jane");
  assert.ok(seen.includes("create") && seen.includes("get"), "the records went to the brought store");
});
