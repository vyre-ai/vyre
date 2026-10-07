import "../scripts/mac-test-guard.mjs";
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
  // the signature check is what is under test: a development build trusts first-party modules by path unless it is told not to (pathRule: false), and then `firstPartyCheck` is the signed one
  let live = null;
  const boot = async () => { live = await bootHomeKernel({ db: new DatabaseSync(dbFile), root, log: () => {}, isFirstParty: () => false, releaseKey: release.publicKey, pathRule: false }); return live; };
  // a failed assertion must not leave a booted kernel holding the process open: the file fails at once instead of hanging until the timeout
  t.after(async () => { try { if (live) await live.stop(); } catch { /* already stopped */ } });
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
  // M-1b: events anyone who can write the log adds are not a document the release key signed: a bare high counter, a document another key signed, and a real one with its
  // counter field changed all count for nothing, and the highest VERIFIED counter (6) still decides
  const writer = k.chains.fromFacts({ kind: "module", module: "home", first_party: true });
  const stranger = crypto.generateKeyPairSync("ed25519");
  const forge = data => k.log.append(writer, { type: "kernel.minimums", sv: 2, subject: `vyre://${id.space}/kernel/minimums`, data, vis: "owner", red: "internal" });
  await forge({ counter: 9999, minimums: { email: "0.0.1" } });
  await forge({ counter: 9998, minimums: { email: "0.0.1" }, doc: signMinimums({ email: "0.0.1" }, stranger.privateKey, 9998) });
  const real = signMinimums({ email: "0.4.0" }, release.privateKey, 6);
  await forge({ counter: 9997, minimums: { email: "0.0.1" }, doc: real });
  await k.stop();
  const logs = [];
  k = live = await bootHomeKernel({ db: new DatabaseSync(dbFile), root, log: m => logs.push(m), isFirstParty: () => false, releaseKey: release.publicKey, pathRule: false });
  assert.equal(k.firstPartyCheck(ok), false, "the forged weak minimums did not outrank the real one");
  assert.equal(k.firstPartyCheck(newer), true);
  assert.equal(logs.filter(m => /does not carry a document the release key signed/.test(m)).length, 2, "the two unsigned events are named");
  await k.stop();
  fs.rmSync(path.join(id.dir, "minimums.json"));
  k = await boot();
  assert.equal(k.firstPartyCheck(ok), false, "still in force with no file at all");
  await k.stop();
});

test("M-3: the developer switches count only in a development build, decided at build time; a missing, edited-away or signed marker means packaged", t => {
  const root = tempHome(t);
  fs.mkdirSync(path.join(root, "lib"));
  assert.equal(isPackaged(root), true, "no marker at all is a packaged build");
  assert.equal(devSwitch("1", root), false);
  fs.writeFileSync(path.join(root, "lib", "build-kind.js"), 'export const BUILD_KIND = "release";\n');
  assert.equal(isPackaged(root), true);
  fs.writeFileSync(path.join(root, "lib", "build-kind.js"), 'export const BUILD_KIND = "development";\n');
  assert.equal(isPackaged(root), false);
  assert.equal(devSwitch("1", root), true);
  assert.equal(devSwitch("true", root), false);
  assert.equal(devSwitch(undefined, root), false);
  fs.writeFileSync(path.join(root, "SHA256SUMS.sig"), "x");
  assert.equal(devSwitch("1", root), false, "a carried release signature means packaged even if the marker says development");
  assert.equal(isPackaged(), false, "this checkout is a development build");
});
