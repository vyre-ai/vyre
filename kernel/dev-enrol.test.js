// @ts-check
// The walk's recipe: scripts/dev-enrol-software-key.mjs puts an owner's software presence key into a home's sealing folder, scripts/dev-sign-proof.mjs signs a proof the sealing process accepts (method "software"), a second enrol
// is refused, and on a release-stamped copy of the tree both scripts refuse.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homeIdentity } from "./home.js";
import { startSealer } from "./seal/client.js";
import { chainCtx } from "./seal/wire.js";
import { tempHome } from "../test/helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (/** @type {string} */ tree, /** @type {string} */ script, /** @type {string[]} */ args) => spawnSync(process.execPath, [path.join(tree, "scripts", script), ...args], { encoding: "utf8" });

test("dev-enrol-software-key and dev-sign-proof: a software owner key is enrolled offline, its proof checks as method software, a second enrol is refused, a release-stamped tree refuses both", { timeout: 120_000 }, async t => {
  const home = tempHome(t), id = homeIdentity(home), sdir = path.join(id.dir, "seal");
  const e = run(ROOT, "dev-enrol-software-key.mjs", ["--home", home]);
  assert.equal(e.status, 0, e.stderr);
  const info = JSON.parse(e.stdout);
  assert.equal(info.person, id.owner);
  assert.equal(fs.statSync(info.key_file).mode & 0o777, 0o600);
  assert.match(e.stderr, /dev-sign-proof\.mjs/, "it says how to sign");
  assert.equal(run(ROOT, "dev-enrol-software-key.mjs", ["--home", home]).status, 2, "a second enrol is refused");
  // a proof for an act, signed with the recipe, is accepted by the sealing process as method "software"
  const chain = { space: id.space, hops: [{ actor: { kind: "person", id: id.owner, space: id.space }, via: { surface: "cli" } }] };
  const s = startSealer({ dir: sdir, dev: true, software: true, timeoutMs: 15_000 });
  t.after(async () => { await s.close(); });
  await s.health(); // the sealing process takes no proof made before it started
  await new Promise(r => setTimeout(r, 50));
  const fields = { task: "t1", payload_hash: "ph", decision: "dec_1" };
  const p = run(ROOT, "dev-sign-proof.mjs", ["--home", home, "--op", "task.decide", "--fields", JSON.stringify(fields)]);
  assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(await s.presenceProve({ chain, op: "task.decide", fields, proof: JSON.parse(p.stdout) }), { ok: true, method: "software" });
  // and from a request line (the admin anchor-reset shape): the proof stands for that exact act
  const ctx = chainCtx(/** @type {any} */ (chain)), { payloadHash } = await import("./seal/wire.js");
  const q = run(ROOT, "dev-sign-proof.mjs", ["--home", home, "--request", JSON.stringify({ request: { op: "anchor.reset", payload_hash: payloadHash("anchor.reset", id.space, {}), chain_hash: ctx.chain_hash } })]);
  await s.anchor.advance({ space: id.space, seq: 3, head: "h".repeat(20) });
  await s.anchor.reset({ chain: /** @type {any} */ (chain), proof: JSON.parse(q.stdout) });
  assert.equal(await s.anchor.read({ space: id.space }), null);
  // a release-stamped copy of the tree refuses both
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "devenrol-")); t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  for (const d of ["kernel", "lib", "scripts"]) fs.cpSync(path.join(ROOT, d), path.join(copy, d), { recursive: true, filter: f => !/\.test\.js$/.test(f) });
  fs.writeFileSync(path.join(copy, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(copy, "lib", "build-kind.js"), 'export const BUILD_KIND = "release";\n');
  const home2 = tempHome(t); homeIdentity(home2);
  const r1 = run(copy, "dev-enrol-software-key.mjs", ["--home", home2]), r2 = run(copy, "dev-sign-proof.mjs", ["--home", home, "--op", "x"]);
  assert.equal(r1.status, 2); assert.match(r1.stderr, /release-kind/);
  assert.equal(r2.status, 2); assert.match(r2.stderr, /release-kind/);
  assert.equal(fs.existsSync(path.join(home2, "dev-owner-key.json")), false);
});
