// @ts-check
// The walk's recipe: scripts/dev-enrol-software-key.mjs puts an owner's software presence key into a home's sealing folder, scripts/dev-sign-proof.mjs signs a proof the sealing process accepts (method "software"), a second enrol
// is refused, and on a release-stamped copy of the tree both scripts refuse.
import "../scripts/mac-test-guard.mjs";
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
  assert.deepEqual(await s.presenceProve({ chain, op: "task.decide", fields, proof: JSON.parse(p.stdout) }), { ok: true, method: "software", strength: "software" });
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

test("a release-kind build ignores VYRE_SEAL_DEV and VYRE_SEAL_SOFTWARE even when a root-run admin step forwards them: a software proof for admin anchor-reset is refused with software_key and nothing is reset", { timeout: 120_000 }, async t => {
  const { DatabaseSync } = await import("node:sqlite");
  const home = tempHome(t), id = homeIdentity(home), sdir = path.join(id.dir, "seal");
  assert.equal(run(ROOT, "dev-enrol-software-key.mjs", ["--home", home]).status, 0);
  const dev = startSealer({ dir: sdir, dev: true, software: true, timeoutMs: 15_000 });
  await dev.anchor.advance({ space: id.space, seq: 5, head: "a".repeat(20) });
  await dev.close();
  new DatabaseSync(path.join(home, "vyre.db")).close();
  // a release-stamped copy, as a packaged image is, run with the dev switches forwarded (what the wrapper's root-run whitelist now passes on)
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "reladmin-")); t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  for (const d of ["kernel", "lib", "scripts"]) fs.cpSync(path.join(ROOT, d), path.join(copy, d), { recursive: true, filter: f => !/\.test\.js$/.test(f) });
  fs.writeFileSync(path.join(copy, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(copy, "lib", "build-kind.js"), 'export const BUILD_KIND = "release";\n');
  const { spawn } = await import("node:child_process");
  const res = await new Promise(resolve => {
    const c = spawn(process.execPath, [path.join(copy, "scripts", "admin-anchor-reset.mjs"), "--home", home, "--seal-dir", sdir, "--wait", "60"], { env: { ...process.env, VYRE_SEAL_DEV: "1", VYRE_SEAL_SOFTWARE: "1" } });
    let o = "", e = "", sent = false;
    c.stdout.on("data", d => { o += d; if (!sent && o.includes("\n")) { sent = true; const p = run(ROOT, "dev-sign-proof.mjs", ["--home", home, "--request", o.split("\n")[0]]); c.stdin.end(p.stdout); } });
    c.stderr.on("data", d => { e += d; });
    c.on("close", code => resolve({ code, o, e }));
  });
  assert.equal(/** @type {any} */ (res).code, 2, /** @type {any} */ (res).e);
  assert.match(/** @type {any} */ (res).e, /refused: software_key/);
  const again = startSealer({ dir: sdir, dev: true, software: true, timeoutMs: 15_000 });
  t.after(async () => { await again.close(); });
  assert.deepEqual(await again.anchor.read({ space: id.space }), { seq: 5, head: "a".repeat(20) }, "the anchor was not reset");
});

test("dev-sign-proof --gate: the proof for a kernel-gated act (an invite in a created Space, a role in the home's own Space) is accepted by the real verifier with the nested payload hash", { timeout: 120_000 }, async t => {
  const { canonical, sha256 } = await import("./core/canonical.js");
  const home = tempHome(t), id = homeIdentity(home), sdir = path.join(id.dir, "seal");
  assert.equal(run(ROOT, "dev-enrol-software-key.mjs", ["--home", home]).status, 0);
  const s = startSealer({ dir: sdir, dev: true, software: true, timeoutMs: 15_000 });
  t.after(async () => { await s.close(); });
  await s.health(); await new Promise(r => setTimeout(r, 50));
  const chainIn = (/** @type {string} */ space) => ({ space, hops: [{ actor: { kind: "person", id: id.owner, space }, via: { surface: "cli" } }] });
  // 1. an invite in a CREATED Space: the kernel gates grants.invite on vyre://<space>/invite/new with the invite's own contents as the input (no `space` key)
  const created = "spc_dg3xdpn6yc5w", input = { role: "member" };
  const fields = { resource: `vyre://${created}/invite/new`, input_hash: sha256(canonical({ action: "grants.invite", input })) };
  const a = run(ROOT, "dev-sign-proof.mjs", ["--home", home, "--space", created, "--gate", "grants.invite", "--input", JSON.stringify(input)]);
  assert.equal(a.status, 0, a.stderr);
  assert.deepEqual(await s.presenceProve({ chain: /** @type {any} */ (chainIn(created)), op: "grant.invite", fields, proof: JSON.parse(a.stdout) }), { ok: true, method: "software", strength: "software" });
  // the same proof is for that Space only: it does not stand for the home's Space, nor for other contents
  const b = run(ROOT, "dev-sign-proof.mjs", ["--home", home, "--space", created, "--gate", "grants.invite", "--input", JSON.stringify(input)]);
  assert.equal((await s.presenceProve({ chain: /** @type {any} */ (chainIn(id.space)), op: "grant.invite", fields, proof: JSON.parse(b.stdout) })).ok, false, "another Space");
  const c = run(ROOT, "dev-sign-proof.mjs", ["--home", home, "--space", created, "--gate", "grants.invite", "--input", JSON.stringify({ role: "admin" })]);
  assert.equal((await s.presenceProve({ chain: /** @type {any} */ (chainIn(created)), op: "grant.invite", fields, proof: JSON.parse(c.stdout) })).ok, false, "other contents");
  // 2. an act in the HOME's own Space with no --space: a role change
  const role = { person: "per_carol", role: "member" }, rfields = { resource: `vyre://${id.space}/member/per_carol`, input_hash: sha256(canonical({ action: "grants.role", input: role })) };
  const d = run(ROOT, "dev-sign-proof.mjs", ["--home", home, "--gate", "grants.role", "--resource", rfields.resource, "--input", JSON.stringify(role)]);
  assert.equal(d.status, 0, d.stderr);
  assert.deepEqual(await s.presenceProve({ chain: /** @type {any} */ (chainIn(id.space)), op: "grant.role", fields: rfields, proof: JSON.parse(d.stdout) }), { ok: true, method: "software", strength: "software" });
});

test("dev-sign-proof takes its op names from kernel/remote/proof.js: --call reproduces proofRequest for EVERY call it knows, and --gate names rules acts grant.rule_<x>", { timeout: 120_000 }, async t => {
  const { proofRequest, PROOF_CALLS, opOf } = await import("./remote/proof.js");
  const home = tempHome(t), id = homeIdentity(home);
  assert.equal(run(ROOT, "dev-enrol-software-key.mjs", ["--home", home]).status, 0);
  const sample = /** @type {Record<string, any[]>} */ ({
    create: [{ x: 1 }], revoke: ["g1", "why"], narrow: ["g1", { a: 1 }], setRole: [{ person: "per_b", role: "member" }], ruleSet: [{ id: 1 }], ruleRemove: ["r1"], ruleEnable: ["r1"], ruleDisable: ["r1"], ruleAccept: ["r1"], ruleDismiss: ["r1"],
    transferOwner: [{ to: "per_b" }], removeMember: [{ person: "per_b" }], removeActor: [{ id: "a1", kind: "agent" }], addActor: [{ id: "a1", kind: "agent" }], offer: [{ x: 1 }], unoffer: ["o1"],
    lend: [{ member: "per_b", device: "d1", device_key: "k" }], unlend: [{ member: "per_b", device: "d1" }], inviteCreate: [{ role: "member" }], moveOut: [{ project: "vyre://spc_dg3xdpn6yc5w/project/0190c3f2-1111-4abc-8def-000000000001", to: "spc_aaaaaaaaaaaa", plan_hash: "p".repeat(43) }], inviteConfirm: ["i1", { words: "w" }],
  });
  assert.deepEqual(Object.keys(sample).sort(), [...PROOF_CALLS].sort(), "a new proof call needs a sample here, so the script keeps up");
  const space = "spc_dg3xdpn6yc5w";
  for (const call of PROOF_CALLS) {
    const want = proofRequest(space, call, ...sample[call]);
    const out = run(ROOT, "dev-sign-proof.mjs", ["--home", home, "--space", space, "--call", call, "--args", JSON.stringify(sample[call])]);
    assert.equal(out.status, 0, `${call}: ${out.stderr}`);
    const p = JSON.parse(out.stdout);
    assert.deepEqual([p.decision, p.payload_hash], [want.op, want.payload_hash], call);
  }
  assert.equal(opOf("rules.set"), "grant.rule_set"); assert.equal(opOf("grants.invite"), "grant.invite");
  const g = run(ROOT, "dev-sign-proof.mjs", ["--home", home, "--space", id.space, "--gate", "rules.set", "--resource", `vyre://${id.space}/rule/new`, "--input", "{\"id\":1}"]);
  assert.equal(JSON.parse(g.stdout).decision, "grant.rule_set", "--gate uses the same naming");
});
