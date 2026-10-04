// L-2 at the kernel: a rollback to an older release is below the module-list counter the home accepted, so the older build's modules are refused until the owner resets the list
// with a REAL presence proof (a key enrolled through the sealing process's own ceremony, signing the payload the sealer recomputes). Nothing is stubbed: a real sealing process, a real
// home kernel booted twice over the same data, the real `resetModulesList`. (The box wrapper's rollback asks the daemon for this reset before it swaps the image: box/vyre.)
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildModuleList } from "./release-list.js";
import { bootHomeKernel } from "../home.js";
import { startSealer } from "../seal/client.js";
import { signer } from "../seal/testing.js";
import { tempHome } from "../../test/helpers.js";
import { sha256b64 } from "../seal/wire.js";

process.env.VYRE_SEAL_DEV = "1";
delete process.env.VYRE_KERNEL_PATH_RULE;

const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const mod = (root, name, version) => { const d = path.join(root, "core", name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "module.json"), JSON.stringify({ name, version })); fs.writeFileSync(path.join(d, "index.js"), `export default ${JSON.stringify(name + version)};`); return d; };
/** A signed package root: modules at the given versions, modules.json at `counter`, SHA256SUMS signed by `key`. */
function release(t, key, counter, mods) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rb-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [n, v] of mods) mod(root, n, v);
  const list = buildModuleList(root, { counter, release: `0.3.${counter}` });
  fs.writeFileSync(path.join(root, "modules.json"), list);
  const sums = `${sha(list)}  modules.json\n${sha("x")}  vyre.tgz\n`;
  fs.writeFileSync(path.join(root, "SHA256SUMS"), sums);
  fs.writeFileSync(path.join(root, "SHA256SUMS.sig"), crypto.sign(null, Buffer.concat([Buffer.from("vyre-release-sums\n"), Buffer.from(sums)]), key.privateKey).toString("base64"));
  return { root, dir: n => path.join(root, "core", n) };
}

test("L-2: update (counter 7) then rollback to the older build (counter 5): its modules are refused; the reset needs the owner's real presence proof and only a proof for exactly this counter works; then the older build's modules run", { timeout: 180_000 }, async t => {
  const key = crypto.generateKeyPairSync("ed25519");
  const oldBuild = release(t, key, 5, [["alpha", "1.0.0"], ["beta", "2.1.0"]]);
  const newBuild = release(t, key, 7, [["alpha", "1.1.0"], ["beta", "2.2.0"]]);
  const root = tempHome(t), dbFile = path.join(root, "k.db");
  const sealDir = fs.mkdtempSync(path.join(os.tmpdir(), "rbseal-")); t.after(() => fs.rmSync(sealDir, { recursive: true, force: true }));
  // unattested: this test enrols a software key, which a packaged box refuses (it needs a platform attestation); everything after the enrolment is the real path.
  const sealer = startSealer({ dir: sealDir, dev: true, unattested: true });
  t.after(() => sealer.close());
  const boot = (build, logs = []) => bootHomeKernel({ db: new DatabaseSync(dbFile), root, log: m => logs.push(m), isFirstParty: () => false, releaseKey: key.publicKey, packageRoot: build.root, sealer });

  // The update: the new build boots healthy and its list (counter 7) is accepted.
  let k = await boot(newBuild);
  assert.equal(k.firstPartyCheck(newBuild.dir("alpha")), true);
  assert.equal(k.log.read({ type: "kernel.modules-list" }).length, 1);
  const owner = k.chains.fromFacts({ kind: "socket", surface: "cli", uid: process.getuid() });
  const person = k.id.owner;
  // The owner's device key enrols through the sealing process's own ceremony (a one-time token, the owner's chain).
  const sg = signer(person);
  const { token } = await sealer.begin({ chain: owner, person, key_id: sg.key_id, spki: sg.enrolment.spki });
  const enrolled = await sealer.enrol({ chain: owner, person, key_id: sg.key_id, spki: sg.enrolment.spki, signer: sg.enrolment.signer, token });
  assert.ok(enrolled && !enrolled.refused, JSON.stringify(enrolled));
  await k.stop();

  // The rollback: the previous image boots over the same data. Its list is below the accepted counter, so its modules are refused (the box would run none).
  const logs = [];
  k = await boot(oldBuild, logs);
  assert.ok(logs.some(m => /older than one already accepted/.test(m)), logs.join(" | "));
  assert.equal(k.firstPartyCheck(oldBuild.dir("alpha")), false, "without the reset the older build runs no first-party module");
  const owner2 = k.chains.fromFacts({ kind: "socket", surface: "cli", uid: process.getuid() });

  // Without a proof, or with one that is not exactly for this act: refused, nothing is reset.
  assert.equal((await k.resetModulesList(owner2, null)).ok, false, "no proof");
  const wrongCounter = sg.proof(owner2, "grant.modules_list_reset", { counter: 5 });
  assert.notEqual((await k.resetModulesList(owner2, wrongCounter)).ok, true, "a proof for another counter");
  const wrongOp = sg.proof(owner2, "grant.role", { counter: 7 });
  assert.notEqual((await k.resetModulesList(owner2, wrongOp)).ok, true, "a proof for another act");
  const tampered = sg.proof(owner2, "grant.modules_list_reset", { counter: 7 }, { tamper: true });
  assert.notEqual((await k.resetModulesList(owner2, tampered)).ok, true, "a tampered signature");
  const other = signer("per_someone_else");
  assert.notEqual((await k.resetModulesList(owner2, other.proof(owner2, "grant.modules_list_reset", { counter: 7 }))).ok, true, "a key that is not the owner's");
  assert.equal(k.log.read({ type: "kernel.modules-list-reset" }).length, 0, "nothing was reset by any of them");
  // Not the owner's chain: refused before the proof is looked at.
  const stranger = k.chains.fromFacts({ kind: "module", module: "x" });
  assert.equal((await k.resetModulesList(stranger, sg.proof(owner2, "grant.modules_list_reset", { counter: 7 }))).why, "owner_only");

  // With the owner's real proof for exactly this counter: one reset, one event, and a proof works once.
  const good = sg.proof(owner2, "grant.modules_list_reset", { counter: 7 });
  const r = await k.resetModulesList(owner2, good);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(k.log.read({ type: "kernel.modules-list-reset" }).length, 1);
  assert.notEqual((await k.resetModulesList(owner2, good)).ok, true, "a proof is used up");
  await k.stop();

  // The older build, restarted: its own list is read, accepted, and its modules run.
  const logs2 = [];
  k = await boot(oldBuild, logs2);
  assert.equal(k.firstPartyCheck(oldBuild.dir("alpha")), true, logs2.join(" | "));
  assert.equal(k.firstPartyCheck(oldBuild.dir("beta")), true);
  await k.stop();
});
