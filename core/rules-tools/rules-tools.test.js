import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";

test("rules.*: the owner's device lists, tries and reads rules under its own chain; defining or switching one needs presence; a model, a guest and anonymous are refused", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const { call } = await import("../daemon/client.js");
  const ok = async (tool, input, caller = "cli") => { const r = await call(tool, input, { root, caller }); assert.ok(!r.error, `${tool}: ${JSON.stringify(r)}`); return r.data; };
  const refused = async (tool, input, caller = "cli") => { const r = await call(tool, input, { root, caller }); assert.ok(r.error, `${tool} should be refused: ${JSON.stringify(r)}`); return r.error; };
  const rule = { kind: "never", binds: ["assistants"], covers: { actions: ["records.remove"] }, label: "Assistants never delete a record" };

  const listed = await ok("rules.list", {});
  assert.deepEqual(listed, { rules: [], proposals: [] });
  const tried = await ok("rules.test", { action: "records.remove", rule });
  assert.equal(tried.outcome, "never", "a rule nobody has made yet can be tried");
  assert.equal(tried.binds[0].status, "candidate");
  assert.equal((await ok("rules.test", { action: "records.remove", as: "member", rule })).outcome, "none");
  assert.equal((await refused("rules.test", { action: "nonsense" })).code, "bad_input");
  assert.equal((await refused("rules.get", { id: "rule_nope" })).code, "not_found");
  assert.equal((await refused("rules.define", { rule })).code, "needs_presence", "an owner's act needs their presence");
  assert.equal((await refused("rules.disable", { id: "rule_nope" })).code, "needs_presence");
  assert.equal((await refused("rules.remove", { id: "rule_nope" })).code, "needs_presence");
  assert.equal((await ok("rules.list", {})).rules.length, 0, "nothing was made");
  for (const caller of ["mcp", "mcp:agent:kit", "guest:x", "anonymous"]) await refused("rules.list", {}, caller);
});
