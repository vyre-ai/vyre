// The capture port on the REAL kernel: sessions hands the lines of an indexed session to the work module once, and the Space's memory can then answer from what was said.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRig } from "../../test/kernel-rig.js";
import { tempHome } from "../../test/helpers.js";
import { open } from "../store/index.js";
import mod from "./index.js";
import manifest from "./module.json" with { type: "json" };

async function boot(t) {
  const rig = await createRig({ people: { per_bob: "member" } });
  const mem = rig.k.kernelFor({ name: "memory", needs: { kernel: { actions: ["records.read", "events.read"] } } });
  await mem.records.query(mem.serviceChain(), "x", { page: { limit: 1 } }).catch(() => {});
  const db = open(path.join(tempHome(t), "work.db"));
  t.after(() => db.close());
  const tools = {};
  await mod.start({ tool: (n, d) => { tools[n] = d; }, store: { db }, kernel: { ...rig.kernel, chainFor: () => rig.ownerChain, serviceChain: () => mem.serviceChain(), chainForPerson: () => rig.withService(rig.ownerChain, "memory"), audienceFor: async () => ({ group: false }) } });
  return { rig, tools, call: (n, i) => tools[n].run(i, { caller: "module:sessions" }) };
}
const LINES = [{ seq: 1, role: "user", text: "the court portal password changed on Tuesday", at: 1 }, { seq: 2, role: "assistant", text: "noted: portal password changed", at: 2 }, { seq: 3, role: "user", text: "client ssn is 123-45-6789", at: 3 }];

test("the capture port keeps a session's lines scrubbed and the Space's memory finds them; forget erases them", async t => {
  const w = await boot(t);
  const r = await w.call("work.know.capture", { session: "s1", lines: LINES });
  assert.equal(r.kept, 3);
  assert.ok(r.indexed >= 3);
  const found = await w.call("work.know.search", { query: "court portal password" });
  assert.ok(found.hits.some(h => h.source.startsWith("line:s1#")), JSON.stringify(found.hits.map(h => h.source)));
  assert.doesNotMatch(JSON.stringify(await w.call("work.know.search", { query: "client ssn" })), /123-45-6789/);
  assert.equal((await w.call("work.know.forget", { session: "s1" })).erased, 3);
  assert.deepEqual((await w.call("work.know.search", { query: "court portal password" })).hits, []);
});

test("capture refuses a bad session id, ignores malformed lines, and is declared for first-party modules only", async t => {
  const w = await boot(t);
  await assert.rejects(() => w.call("work.know.capture", { session: "../x", lines: LINES }), { code: "bad_input" });
  assert.equal((await w.call("work.know.capture", { session: "s2", lines: [{ seq: "x", role: "user", text: "a" }, { seq: 1, role: "root", text: "b" }, null] })).kept, 0);
  for (const name of ["work.know.capture", "work.know.forget"]) assert.equal(manifest.does.tools.find(x => x.name === name).reach, "modules");
});
