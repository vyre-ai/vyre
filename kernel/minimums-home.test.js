import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bootHomeKernel, homeIdentity } from "./home.js";
import { signMinimums, signModule } from "./modules/firstparty.js";
import { isPackaged, devSwitch } from "./devbuild.js";
import { tempHome } from "../test/helpers.js";

process.env.VYRE_SEAL_DEV = "1";
delete process.env.VYRE_KERNEL_PATH_RULE;

test("M-1: the accepted minimums live in the sealed log; deleting or rolling back minimums.json never relaxes them", { timeout: 120_000 }, async t => {
  const release = crypto.generateKeyPairSync("ed25519");
  const root = tempHome(t);
  const id = homeIdentity(root);
  const dbFile = path.join(root, "k.db");
  const mk = version => { const dir = fs.mkdtempSync(path.join(root, "fp-")); fs.writeFileSync(path.join(dir, "module.json"), JSON.stringify({ name: "email", version })); fs.writeFileSync(path.join(dir, "index.js"), "export default {};"); signModule(dir, release.privateKey); return dir; };
  const doc = (min, counter) => fs.writeFileSync(path.join(id.dir, "minimums.json"), JSON.stringify(signMinimums(min, release.privateKey, counter)));
  const boot = async () => bootHomeKernel({ db: new DatabaseSync(dbFile), root, log: () => {}, isFirstParty: () => false, releaseKey: release.publicKey });
  const old = mk("0.2.9"), ok = mk("0.3.0"), newer = mk("0.4.0");

  let k = await boot();
  assert.equal(k.firstPartyCheck(old), true, "a fresh home with no document: a signature only");
  await k.stop();

  doc({ email: "0.3.0" }, 5);
  k = await boot();
  assert.equal(k.firstPartyCheck(old), false);
  assert.equal(k.firstPartyCheck(ok), true);
  assert.equal(k.log.read({ type: "kernel.minimums" }).length, 1);
  assert.equal(fs.existsSync(path.join(id.dir, "minimums.counter")), false, "no counter file a user could lower");
  await k.stop();

  fs.rmSync(path.join(id.dir, "minimums.json"));
  k = await boot();
  assert.equal(k.firstPartyCheck(old), false, "deleting the document does not turn the minimum off");
  await k.stop();

  doc({ email: "0.0.1" }, 4);
  k = await boot();
  assert.equal(k.firstPartyCheck(old), false, "an older signed document is not a way back");
  await k.stop();

  fs.writeFileSync(path.join(id.dir, "minimums.json"), "not json");
  k = await boot();
  assert.equal(k.firstPartyCheck(old), false, "an unreadable document does not relax it either");
  await k.stop();

  doc({ email: "0.4.0" }, 6);
  k = await boot();
  assert.equal(k.firstPartyCheck(ok), false);
  assert.equal(k.firstPartyCheck(newer), true);
  assert.equal(k.log.read({ type: "kernel.minimums" }).length, 2);
  await k.stop();
});

test("M-3: the developer switches count only in a development tree; a packaged one (it carries SHA256SUMS) ignores them", t => {
  const root = tempHome(t);
  assert.equal(isPackaged(root), false);
  assert.equal(devSwitch("1", root), true);
  assert.equal(devSwitch("true", root), false);
  assert.equal(devSwitch(undefined, root), false);
  fs.writeFileSync(path.join(root, "SHA256SUMS.sig"), "x");
  assert.equal(isPackaged(root), true);
  assert.equal(devSwitch("1", root), false, "the switch is ignored in a packaged daemon");
});
