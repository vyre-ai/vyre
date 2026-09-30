// @ts-check
// The ratchet (ADR 0047 section 7): every example module, and every frozen fixture module per
// released minor, passes conformModule. A release that breaks one fails here. Fixtures under
// test/fixtures/modules/ are never edited, only added.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conformModule } from "../packages/module-sdk/conform.js";

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
const frozen = fs.existsSync(path.join(ROOT, "test/fixtures/modules"))
  ? fs.readdirSync(path.join(ROOT, "test/fixtures/modules")).flatMap(v => modulesIn(`test/fixtures/modules/${v}`)) : [];

test("module api compat: there is an example to hold the contract to", () => {
  assert.ok(examples.includes("examples/modules/bakery"), examples.join(", "));
});

for (const rel of [...examples, ...frozen]) {
  test(`module api compat: ${rel} conforms as an added module`, async () => {
    assert.deepEqual(await conformModule(path.join(ROOT, rel)), []);
  });
}
