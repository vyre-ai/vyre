// @ts-check
// `vyre kit` and `vyre kit deploy <kit>` as a person runs them: the real bin/vyre against a vyred started in this process with the kernel on.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { tempHome } from "../../../test/helpers.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");
const run = (/** @type {string} */ root, /** @type {string[]} */ args) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1" }, timeout: 60_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout + stderr })));

test("vyre kit lists the library, and vyre kit deploy law-firm proposes the base Kit and then the law firm Kit, each for a yes", { timeout: 120_000 }, async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());

  const list = /** @type {any} */ (await run(root, ["kit", "--json"]));
  assert.equal(list.code, 0, list.out);
  const kits = JSON.parse(list.out).kits;
  assert.deepEqual(kits.map((/** @type {any} */ k) => k.id), ["base", "estate-planning", "law-firm"]);
  assert.deepEqual(kits.find((/** @type {any} */ k) => k.id === "law-firm").requires, ["base"]);
  assert.ok(kits.every((/** @type {any} */ k) => k.installed === false));

  const bad = /** @type {any} */ (await run(root, ["kit", "deploy", "nope"]));
  assert.equal(bad.code, 1);
  assert.match(bad.out, /no Kit nope/);

  const dep = /** @type {any} */ (await run(root, ["kit", "deploy", "law-firm", "--json"]));
  assert.equal(dep.code, 0, dep.out);
  const steps = JSON.parse(dep.out).steps;
  assert.deepEqual(steps.map((/** @type {any} */ s) => [s.kit, s.ok]), [["base", true], ["law-firm", true]], dep.out);
  assert.match(steps[0].said, /waiting for your yes/);
});
