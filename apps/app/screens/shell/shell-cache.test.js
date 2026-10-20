// @ts-check
// The shell's kept copy (shell-cache.js): the Spaces and the person's line come back whole; a broken, old or empty copy does not.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { GATE_BUDGET_MS, MAX_AGE_MS, packShell, unpackShell } from "./shell-cache.js";

const T = 1_790_000_000_000;
const data = { me: { name: "Alex", sub: "", vyreName: "alex.vyre.run" }, spaces: [{ id: "spc_h", name: "Home" }, { id: "spc_a", name: "Harbor" }] };

test("the shell comes back as it went in, with the Space that was showing", () => {
  const back = unpackShell(JSON.parse(JSON.stringify(packShell(data, "spc_a", () => T))), () => T + 1000);
  assert.deepEqual(back, { data, space: "spc_a" });
});

test("a copy from another version, an old one, a broken one or one with no Spaces is not used", () => {
  const ok = packShell(data, "spc_h", () => T);
  assert.equal(unpackShell({ ...ok, v: 2 }, () => T), null);
  assert.equal(unpackShell(ok, () => T + MAX_AGE_MS + 1), null);
  assert.equal(unpackShell(null), null);
  assert.equal(unpackShell(packShell({ ...data, spaces: [] }, "", () => T), () => T), null);
  assert.equal(unpackShell(packShell({ ...data, spaces: [{ name: "x" }] }, "", () => T), () => T), null);
  assert.ok(GATE_BUDGET_MS > 0);
});
