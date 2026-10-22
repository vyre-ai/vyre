// @ts-check
// `vyre kit` and `vyre kit deploy <kit>` as a person runs them: the real bin/vyre against a vyred started in this process with the kernel on.
// And `vyre kit deploy <file>`: a Kit read from a file on this computer, the owner's yes, the same version refused and a higher one proposed again.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { tempHome } from "../../../test/helpers.js";
import { canonical } from "../../../kernel/core/canonical.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");
const run = (/** @type {string} */ root, /** @type {string[]} */ args) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1" }, timeout: 60_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout + stderr })));

/** A Kit in the kernel's own form, as a file holds it. */
const kit = (/** @type {number} */ version) => ({
  format: 1, id: "demo-kit", version, name: "Demo Kit", description: "A Kit to show a deploy from a file",
  includes: { types: [], templates: [], roles: [], teammates: [], flows: [], views: [] },
});

const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 25_000) => {
  const t0 = Date.now();
  for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out: ${what}`); await new Promise(r => setTimeout(r, 100)); }
};
/** The kernel's own stand-in proof, as the other Kit tests use it. */
const presence = () => { const used = new Set(); return { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_proof") }; };

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

test("vyre kit deploy <file> proposes a card, the Space keeps where it came from, the same version is refused and a higher one is proposed again", { timeout: 180_000 }, async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence() });
  t.after(() => d.stop());

  const file = path.join(root, "demo-kit.json");
  fs.writeFileSync(file, JSON.stringify(kit(1)));

  // a Kit from a file: a card is proposed, and nothing is installed until the owner says yes
  const dep = /** @type {any} */ (await run(root, ["kit", "deploy", file, "--json"]));
  assert.equal(dep.code, 0, dep.out);
  const said = JSON.parse(dep.out);
  assert.equal(said.source, file, "the source is the file the Kit was read from");
  assert.equal(said.steps.length, 1);
  assert.equal(said.steps[0].kit, "demo-kit");
  assert.equal(said.steps[0].ok, true, dep.out);
  assert.match(said.steps[0].said, /waiting for your yes/);
  const task = said.steps[0].task;
  assert.ok(task, "the card waits as a task: " + dep.out);

  // the owner's yes
  const chain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const row = await d.kernel.gateway.ask.get(chain, task);
  await d.kernel.gateway.ask.decide(chain, task, { outcome: "approved", proof: { op: "task.decide", fields: { task, payload_hash: row.payload.payload_hash, decision: row.payload.decision }, n: Math.random() } });
  await until(async () => {
    const l = /** @type {any} */ (await run(root, ["kit", "--json"]));
    return (JSON.parse(l.out).space_kits || []).find((/** @type {any} */ r) => r.id === "demo-kit" && r.status === "installed");
  }, "the Kit to install");

  // the Space keeps where the Kit came from, and which version it is at
  const list = /** @type {any} */ (await run(root, ["kit", "--json"]));
  const mine = (JSON.parse(list.out).space_kits || []).find((/** @type {any} */ r) => r.id === "demo-kit");
  assert.ok(mine, list.out);
  assert.equal(mine.source, file);
  assert.equal(Number(mine.version), 1);

  // the same version again: refused, and not tried a second time
  const same = /** @type {any} */ (await run(root, ["kit", "deploy", file, "--json"]));
  assert.equal(same.code, 1, same.out);
  assert.match(same.out, /already installed/);

  // a higher version: proposed again, for the owner's yes
  fs.writeFileSync(file, JSON.stringify(kit(2)));
  const higher = /** @type {any} */ (await run(root, ["kit", "deploy", file, "--json"]));
  assert.equal(higher.code, 0, higher.out);
  assert.match(higher.out, /waiting for your yes/);
  assert.equal(JSON.parse(higher.out).source, file);
});

test("a source that carries a name or a password is refused, in the terminal and on the server", { timeout: 120_000 }, async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence() });
  t.after(() => d.stop());

  // the terminal: a plain http address, and an address with a name in it
  for (const bad of ["http://example.com/kit.json", "https://someone@example.com/kit.json"]) {
    const r = /** @type {any} */ (await run(root, ["kit", "deploy", bad]));
    assert.equal(r.code, 2, `${bad}: ${r.out}`);
    assert.match(r.out, /https|password/);
  }

  // the server: the same rule, whatever the caller is
  const owner = d.kernel.id.owner;
  const chain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const meta = { token: (await d.kernel.surfaces.open(chain, {})).token };
  const r = await d.registry.call("flows.kit.propose", { kit: kit(1), source: "https://someone:secret@example.com/kit.json" }, "cli", meta);
  assert.ok(r.error, "a source with a name and a password is refused: " + JSON.stringify(r));
  assert.equal(r.error.code, "bad_input");
  assert.match(String(r.error.message), /password/);
});

test("a file that is not there, or a token that is not a reference, is said in plain words", { timeout: 120_000 }, async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());

  const missing = /** @type {any} */ (await run(root, ["kit", "deploy", path.join(root, "no-such-kit.json")]));
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.out, /no Kit at/);

  const bad = /** @type {any} */ (await run(root, ["kit", "deploy", path.join(root, "no-such-kit.json"), "--token", "not-a-reference"]));
  assert.equal(bad.code, 2, bad.out);
  assert.match(bad.out, /vault:\/\/item\/field/);
});
