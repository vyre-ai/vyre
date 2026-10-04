// @ts-check
// The compatibility guarantee (ADR 0047 section 8, the person's rule): every example module and
// every pinned fixture passes conformModule against every contract version this Vyre supports.
// Fixtures under test/fixtures/modules/v<major>.<minor>/ are never edited, only added. A module
// that names a newer contract is refused cleanly: one plain line, its code never imported.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conformModule, conformModuleFull } from "../packages/module-sdk/conform.js";
import { CONTRACT, newestOf, supports, adapterFor } from "../packages/module-sdk/contract.js";
import * as v1 from "../packages/module-sdk/compat/v1.js";
import { createTestContext } from "../packages/module-sdk/testing.js";
import { discover, validate, Registry } from "../core/modules/index.js";
import { open } from "../core/store/index.js";
import { Events } from "../core/events/index.js";
import { tempHome } from "./helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every folder with a module.json directly under a root. @param {string} root */
const modulesIn = root => {
  const dir = path.join(ROOT, root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "module.json")))
    .map(d => `${root}/${d.name}`);
};

const examples = modulesIn("examples/modules");
const pinnedRoot = path.join(ROOT, "test/fixtures/modules");
const pinned = fs.readdirSync(pinnedRoot).filter(v => /^v\d+\.\d+$/.test(v)).flatMap(v => modulesIn(`test/fixtures/modules/${v}`));
/** Every contract version to test against: the newest minor of each supported major. */
const versions = CONTRACT.supported.map(major => /** @type {string} */ (newestOf(CONTRACT, Number(major))));

test("module api compat: there is an example and a pinned 1.0 fixture to hold the contract to", () => {
  assert.ok(examples.includes("examples/modules/bakery"), examples.join(", "));
  assert.ok(pinned.includes("test/fixtures/modules/v1.0/matters"), pinned.join(", "));
  assert.deepEqual(versions, ["1.0"]);
});

for (const version of versions) {
  for (const rel of [...examples, ...pinned]) {
    test(`module api compat: ${rel} conforms to module contract ${version} as an added module`, async () => {
      const r = await conformModuleFull(path.join(ROOT, rel), { contract: version });
      assert.deepEqual(r.failures, []);
      assert.deepEqual(r.warnings, [], "an example or a pinned fixture carries no deprecated usage");
    });
  }
}

test("module api compat: the v1 adapter is the seam every v1 module goes through, the identity today", () => {
  assert.equal(adapterFor("1"), v1);
  assert.equal(adapterFor("1.0"), v1);
  assert.throws(() => adapterFor("2"), /no adapter for module contract 2/);
  const m = { name: "kit", version: "0.1.0" };
  assert.equal(v1.manifest(m), m);
  const h = createTestContext({ name: "kit", version: "0.1.0", vyre: "1", description: "Kit." });
  assert.equal(h.adapter, v1);
  assert.equal(h.ctx.api.version, CONTRACT.current);
  return h.stop();
});

/** A module folder whose entry leaves a mark (and throws) if it is ever imported. */
function trap(t, vyre, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-compat-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mod = path.join(dir, "harlow");
  fs.mkdirSync(mod);
  fs.writeFileSync(path.join(mod, "module.json"), JSON.stringify({ name: "harlow", version: "3.0.0", vyre, description: "Harlow Legal, from the future.",
    does: { tools: [{ name: "harlow.docket", summary: "the docket", reach: "anyone", "x-later": true }], timeline: ["harlow.docket"] }, ...extra }));
  fs.writeFileSync(path.join(mod, "package.json"), JSON.stringify({ type: "module" }));
  const mark = path.join(dir, "imported");
  fs.writeFileSync(path.join(mod, "index.js"), `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(mark)}, "yes");\nthrow new Error("this module was imported");\n`);
  return { dir, mod, mark };
}

for (const [vyre, message] of [
  ["1.9", "harlow needs a newer Vyre (module contract 1.9); this Vyre has 1.0. Update Vyre, or ask the module's author for an older version."],
  ["2", "harlow needs a newer Vyre (module contract 2); this Vyre has 1.0. Update Vyre, or ask the module's author for a version for contract 1."],
]) {
  test(`module api compat: a module for contract ${vyre} is refused with a plain line, never imported, never a crash`, async t => {
    const { dir, mod, mark } = trap(t, vyre);
    assert.deepEqual(supports(vyre, { name: "harlow" }), { ok: false, message });
    assert.deepEqual(await conformModule(mod), [message]);
    assert.deepEqual(validate(JSON.parse(fs.readFileSync(path.join(mod, "module.json"), "utf8"))), [message]);
    // The loader: the row is invalid with the same line, and the entry file was never imported.
    const home = tempHome(t);
    const db = open(path.join(home, "vyre.db"));
    t.after(() => db.close());
    const logs = [];
    const reg = new Registry({ db, events: new Events(db), config: {}, log: m => logs.push(m) });
    await reg.start(discover([dir]), { role: "box" });
    assert.deepEqual({ state: reg.modules.get("harlow").state, error: reg.modules.get("harlow").error }, { state: "invalid", error: message });
    assert.ok(!reg.tools.has("harlow.docket"));
    assert.ok(!fs.existsSync(mark), "the module's code was never imported");
    assert.throws(() => createTestContext(JSON.parse(fs.readFileSync(path.join(mod, "module.json"), "utf8"))), (/** @type {any} */ e) => e.code === "unsupported" && e.message === message);
    assert.ok(!fs.existsSync(mark));
  });
}

test("module api compat: a module naming 1.0 with keys this Vyre doesn't know loads, and the keys only warn", async t => {
  const { mod, mark } = trap(t, "1.0");
  fs.writeFileSync(path.join(mod, "index.js"), `export default { async start(ctx) { ctx.tool("harlow.docket", { effect: "read", input: { type: "object" }, examples: [{ input: {} }], run: () => ({ cases: 0 }) }); return { async stop() {} }; } };\n`);
  const r = await conformModuleFull(mod);
  assert.deepEqual(r.failures, []);
  assert.ok(r.warnings.some(w => /does\.timeline is not a key in module contract 1\.0/.test(w)), r.warnings.join("; "));
  assert.deepEqual(validate(JSON.parse(fs.readFileSync(path.join(mod, "module.json"), "utf8"))), [], "the loader ignores an unknown key");
  assert.ok(!fs.existsSync(mark));
});
