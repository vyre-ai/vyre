import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { bootHomeKernel } from "./home.js";
import { createMemoryStore } from "./store/memory.js";
import { CONTACT } from "./conformance/suite.js";
import { spaceStoreFactory, twentyName } from "../records/space-store.js";
import { tempHome } from "../test/helpers.js";

process.env.VYRE_SEAL_DEV = "1";

test("the Space's record store is the one the caller brings (the per-Space Twenty), for the home's own kernel; grants, tasks and the log stay in the home's SQLite", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  const seen = [];
  const inner = createMemoryStore({});
  const store = new Proxy(inner, { get: (o, k) => (typeof o[k] === "function" ? (...a) => { seen.push(String(k)); return o[k](...a); } : o[k]) });
  const asked = [];
  const k = await bootHomeKernel({ db: new DatabaseSync(path.join(root, "k.db")), root, log: () => {}, isFirstParty: () => false, storeFor: async (space, meta) => { asked.push([space, meta.personal === true]); return store; } });
  t.after(() => k.stop());
  assert.deepEqual(asked, [[k.id.space, true]], "asked once, for the home's own Space");
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: k.id.owner, path: "direct", session: "s" });
  await k.gateway.records.define(owner, { add_types: [CONTACT] });
  const c = await k.gateway.records.create(owner, "contact", { name: "Jane" });
  assert.equal((await k.gateway.records.get(owner, "contact", c.id)).data.name, "Jane");
  assert.ok(seen.includes("create") && seen.includes("get"), "the records went to the brought store");
});

test("spaceStoreFactory provisions the Space's Twenty and builds the store over its key and webhook secret; a Space id becomes a Twenty name", async () => {
  assert.equal(twentyName("spc_abcdefghijkl"), "s-abcdefghijkl");
  assert.throws(() => twentyName(""), /no Twenty name|name/);
  const calls = [];
  const fs = await import("node:fs");
  const dir = fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "ss-"));
  const keyFile = path.join(dir, "service.key"), hookFile = path.join(dir, "webhook.secret");
  fs.writeFileSync(keyFile, "KEY\n"); fs.writeFileSync(hookFile, "HOOK\n");
  const make = spaceStoreFactory({ home: dir, memory: "small", reach: "ip",
    provision: async o => { calls.push(["provision", o.space, o.reach, o.memory]); return { url: "http://10.0.0.5:3000", keyFile, webhookSecretFile: hookFile, workspaceId: "w" }; },
    createStore: o => { calls.push(["store", o.space, o.webhookSecret, o.client.key()]); return { fake: true }; } });
  assert.deepEqual(await make("spc_abcdefghijkl"), { fake: true });
  assert.deepEqual(calls, [["provision", "s-abcdefghijkl", "ip", "small"], ["store", "spc_abcdefghijkl", "HOOK", "KEY"]]);
});
