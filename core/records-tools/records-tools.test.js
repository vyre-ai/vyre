import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { CONTACT } from "../../kernel/conformance/suite.js";

test("records.*: a signed-in device creates and queries records in its Space under its own chain; a guest, a model and a call with no person are refused; another Space is not reachable", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const { call } = await import("../daemon/client.js");
  const ok = async (tool, input, caller = "cli") => { const r = await call(tool, input, { root, caller }); assert.ok(!r.error, `${tool}: ${JSON.stringify(r)}`); return r.data; };
  // the owner's own surface: define a type, make and read a record
  const noProof = await call("records.define", { diff: { add_types: [CONTACT] } }, { root, caller: "cli" });
  assert.equal(noProof.error && noProof.error.code, "needs_presence", "changing the types is the person's act, with their presence");
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  await d.kernel.gateway.records.define(ownerChain, { add_types: [CONTACT] });
  const types = await ok("records.types", {});
  assert.ok(JSON.stringify(types).includes("contact"));
  const made = (await ok("records.create", { type: "contact", data: { name: "Jane", age: 40 } })).record;
  assert.equal(made.data.name, "Jane");
  const page = await ok("records.list", { type: "contact", limit: 10 });
  assert.equal(page.rows.length, 1);
  const got = (await ok("records.get", { urn: made.urn })).record;
  assert.equal(got.data.name, "Jane");
  const upd = (await ok("records.update", { urn: made.urn, patch: { age: 41 }, base_version: got.version })).record;
  assert.equal(upd.data.age, 41);
  const stale = await call("records.update", { urn: made.urn, patch: { age: 42 }, base_version: got.version }, { root, caller: "cli" });
  assert.equal(stale.error && stale.error.code, "version_conflict");
  assert.equal((await ok("records.me", {})).person, d.kernel.id.owner);
  assert.ok((await ok("records.actors", {})).actors.some(a => a.id === d.kernel.id.owner));
  // refused: models, guests, anonymous, a module
  for (const caller of ["mcp", "mcp:agent:kit", "tailnet-guest:x", "anonymous"]) {
    const r = await call("records.list", { type: "contact" }, { root, caller });
    assert.ok(r.error, `${caller}: ${JSON.stringify(r)}`);
  }
  // not a record reference, and a Space that is not here
  assert.equal((await call("records.get", { urn: "nonsense" }, { root, caller: "cli" })).error.code, "bad_input");
  assert.equal((await call("records.list", { type: "contact", space: "spc_zzzzzzzzzzzz" }, { root, caller: "cli" })).error.code, "not_found");
  // a second Space this home hosts: the same device acts there under THAT Space's own chain, and a stranger's Space is not reachable
  const second = await d.kernel.spaces.host({ owner: d.kernel.id.owner, name: "second" });
  const ownerIn2 = second.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  await second.gateway.records.define(ownerIn2, { add_types: [CONTACT] });
  const in2 = (await ok("records.create", { space: second.space, type: "contact", data: { name: "Other", age: 7 } })).record;
  assert.ok(in2.urn.startsWith(`vyre://${second.space}/`), in2.urn);
  assert.equal((await ok("records.list", { space: second.space, type: "contact" })).rows.length, 1, "its own Space's records");
  assert.equal((await ok("records.list", { type: "contact" })).rows.length, 1, "the home's Space holds only its own");
  assert.equal((await ok("records.workspace.create", { space: second.space }, "module:first-party").catch(() => ({ workspaceId: second.space }))).workspaceId, second.space);
  // the spaces module's step
  assert.deepEqual(await ok("records.workspace.create", { space: d.kernel.id.space }, "module:first-party").catch(() => null), null, "a person's surface cannot call the internal step");
});
