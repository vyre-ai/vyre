import "../../scripts/mac-test-guard.mjs";
import "../runner/testing/hosted-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { lentServiceFor } from "./lent-service.js";

const chain = (person, device) => ({ space: "spc_aaaaaaaaaaaa", hops: [{ actor: { kind: "person", id: person }, via: { device } }] });
const kernel = (active) => ({ gateway: { grants: { offers: { active: () => active } }, leases: { renew: async () => ({}), bind() {}, unbind() {} } } });

test("a Space this home serves gets a lent service; a kernel with no offers store gets none", () => {
  const root = fs.mkdtempSync(path.join(SCRATCH, "ls-"));
  const f = lentServiceFor({ root });
  assert.equal(f("spc_aaaaaaaaaaaa", {}), null);
  assert.equal(f("spc_aaaaaaaaaaaa", { gateway: {} }), null);
  const s = f("spc_aaaaaaaaaaaa", kernel({ spaceAllows: true, memberAccepts: true }));
  assert.equal(typeof s.start, "function");
  assert.deepEqual(Object.keys(s).filter(k => ["status", "start", "stop", "putFile", "getFile", "putCheckpoint", "getCheckpoint", "appendTranscript", "getTranscript", "usage"].includes(k)).length, 10);
});

test("status answers from the Offers; start refuses with not_found when the daemon gave no definition, and uses lentSpec when it did", async () => {
  const root = fs.mkdtempSync(path.join(SCRATCH, "ls-"));
  const k = kernel({ spaceAllows: true, memberAccepts: true });
  const bare = lentServiceFor({ root })("spc_aaaaaaaaaaaa", k);
  assert.deepEqual(await bare.status(chain("per_bob", "dev_laptop")), { spaceAllows: true, memberAccepts: true, lenderCap: null });
  await assert.rejects(bare.start(chain("per_bob", "dev_laptop"), { session: "s1" }), e => e.code === "not_found");
  const seen = [];
  const withSpec = lentServiceFor({ root, lentSpec: async i => { seen.push(i); return { command: "/usr/bin/agent", args: [], env: {}, routes: [], readOnly: [], labels: {}, network: "provider" }; } })("spc_aaaaaaaaaaaa", k);
  const r = await withSpec.start(chain("per_bob", "dev_laptop"), { session: "s1" });
  assert.equal(r.command, "/usr/bin/agent");
  assert.deepEqual(seen, [{ space: "spc_aaaaaaaaaaaa", session: "s1", person: "per_bob", device: "dev_laptop" }]);
  const closed = lentServiceFor({ root, lentSpec: async () => ({ command: "x", routes: [] }) })("spc_aaaaaaaaaaaa", kernel({ spaceAllows: true, memberAccepts: false }));
  await assert.rejects(closed.start(chain("per_bob", "dev_laptop"), { session: "s1" }), e => e.code === "not_allowed");
});
