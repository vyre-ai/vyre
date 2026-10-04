// @ts-check
// The module contract version (ADR 0047 section 8): a module names its contract in "vyre", this
// Vyre says in plain words when it can't run one, and deprecated usages warn without failing.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTRACT, parseContract, supports, moduleContract, newestOf } from "../packages/module-sdk/contract.js";
import { checkManifest, checkManifestFull } from "../packages/module-sdk/manifest.js";
import { createTestContext } from "../packages/module-sdk/testing.js";

/** Kit's module, with keys set to undefined left out. */
const kit = (/** @type {any} */ more = {}) => JSON.parse(JSON.stringify({ name: "kit", version: "0.1.0", vyre: "1", description: "Kit's notes for juno.", does: { tools: [{ name: "kit.read", summary: "read a note" }] }, ...more }));

test("contract: contract.json names the current version, the supported majors and each minor's first release", () => {
  assert.deepEqual(CONTRACT, { current: "1.0", supported: ["1"], versions: { "1.0": "0.2.0" } });
  assert.deepEqual(parseContract("1"), { major: 1, minor: 0, text: "1" });
  assert.deepEqual(parseContract("1.2"), { major: 1, minor: 2, text: "1.2" });
  for (const bad of ["", "v1", "1.2.3", "one", 1, null]) assert.equal(parseContract(bad), null, String(bad));
  assert.equal(newestOf(CONTRACT, 1), "1.0");
  assert.equal(newestOf(CONTRACT, 2), null);
});

test("contract: supports says yes, or one plain line a person can act on", () => {
  assert.deepEqual(supports("1"), { ok: true });
  assert.deepEqual(supports("1.0"), { ok: true });
  const later = { current: "1.0", supported: ["1"], versions: { "1.0": "0.2.0", "1.2": "0.4.0" } };
  assert.deepEqual(supports("1.2", { name: "bakery", contract: later }), { ok: false, message: "bakery needs Vyre 0.4 or later (module contract 1.2); this Vyre has 1.0. Update Vyre, or ask the module's author for an older version." });
  assert.deepEqual(supports("1.2", { name: "bakery", contract: { ...later, current: "1.2" } }), { ok: true });
  assert.match(/** @type {any} */ (supports("1.1", { name: "bakery" })).message, /^bakery needs a newer Vyre \(module contract 1\.1\); this Vyre has 1\.0\./);
  assert.match(/** @type {any} */ (supports("3", { name: "bakery" })).message, /needs a newer Vyre \(module contract 3\)/);
  // An old major this Vyre dropped: the codemod is the way forward.
  const v2 = { current: "2.0", supported: ["2"], versions: { "1.0": "0.2.0", "2.0": "1.0.0" } };
  assert.match(/** @type {any} */ (supports("1", { name: "bakery", contract: v2 })).message, /bakery is written for module contract 1, which this Vyre no longer supports \(it has 2\.0\)\. Run vyre module upgrade/);
  // Two supported majors at once (the 12 month window): both run.
  assert.deepEqual(supports("1", { contract: { ...v2, supported: ["1", "2"] } }), { ok: true });
  assert.match(/** @type {any} */ (supports("x", { name: "kit" })).message, /"vyre" must be a contract version like "1"/);
  assert.equal(moduleContract({ apiVersion: 1 }), "1");
  assert.equal(moduleContract({ vyre: "1.0", apiVersion: 1 }), "1.0");
  assert.equal(moduleContract({}), "1");
  assert.equal(moduleContract({}, { assume: false }), null);
});

test("contract: deprecated usages are warnings, never problems", () => {
  const r = checkManifestFull(kit({ vyre: undefined, apiVersion: 1, does: { tools: [{ name: "kit.read" }], senders: { kit: "kit.read" } }, shows: { cli: ["kit"] } }));
  assert.deepEqual(r.problems, []);
  for (const re of [/apiVersion is deprecated; use "vyre": "1"/, /does\.senders is deprecated/, /shows\.cli is deprecated/]) assert.ok(r.warnings.some(w => re.test(w)), `${re} in ${r.warnings.join("; ")}`);
  const builtIn = checkManifestFull({ name: "kit", version: "0.1.0", does: { tools: ["kit.read"] } }, { firstParty: true });
  assert.deepEqual(builtIn.problems, []);
  assert.ok(builtIn.warnings.some(w => /string tool entries are deprecated/.test(w)));
  // 1.0 rules for added modules stay problems.
  assert.ok(checkManifest(kit({ does: { tools: ["kit.read"] } })).some(p => /must be an object/.test(p)));
  assert.ok(checkManifest(kit({ vyre: undefined })).some(p => /"vyre" is required outside Vyre's own modules; add "vyre": "1"/.test(p)));
  assert.deepEqual(checkManifest(kit({ vyre: "1.0" })), []);
  assert.deepEqual(checkManifest(kit({ vyre: "1.4" })), ["kit needs a newer Vyre (module contract 1.4); this Vyre has 1.0. Update Vyre, or ask the module's author for an older version."]);
  assert.deepEqual(checkManifestFull(kit({ vyre: "1.4" }), { contract: { current: "1.4", supported: ["1"], versions: { "1.0": "0.2.0", "1.4": "0.6.0" } } }).problems, []);
});

test("contract: the harness speaks the current contract, warns on deprecated members and refuses the added-only ones", async t => {
  const h = createTestContext(kit({ teaches: { memory: ["reading"] } }));
  t.after(() => h.stop());
  assert.equal(h.ctx.api.version, "1.0");
  assert.equal(await h.ctx.memory.teach("reading", "juno reads on Sundays"), true);
  assert.deepEqual(h.warnings, ["ctx.memory.teach is deprecated; use ctx.memory.write({ kind: \"fact\", text })"]);
  assert.throws(() => h.ctx.tool("kit.read", { callers: ["cli"], run: () => 1 }), /declare reach in module.json/);
  const fp = createTestContext({ name: "kit", version: "0.1.0", does: { tools: ["kit.read"] } }, { firstParty: true, contract: "1.0" });
  t.after(() => fp.stop());
  fp.ctx.tool("kit.read", { callers: ["cli"], run: () => 1 });
  assert.deepEqual(fp.warnings, ["tool kit.read sets callers, which is deprecated; declare reach in module.json"]);
});
