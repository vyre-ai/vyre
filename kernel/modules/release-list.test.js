import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildModuleList, readReleaseList, verifyRawList, createListCheck } from "./release-list.js";
import { bootHomeKernel } from "../home.js";
import { tempHome } from "../../test/helpers.js";

process.env.VYRE_SEAL_DEV = "1";
delete process.env.VYRE_KERNEL_PATH_RULE;

const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const mod = (root, top, name, version, extra = {}) => { const d = path.join(root, top, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "module.json"), JSON.stringify({ name, version })); fs.writeFileSync(path.join(d, "index.js"), `export default { name: ${JSON.stringify(name)} };`); for (const [f, c] of Object.entries(extra)) fs.writeFileSync(path.join(d, f), c); return d; };
/** A package root with two modules, a modules.json at `counter` and the release's signature over SHA256SUMS. */
function release(t, { counter = 5, key = crypto.generateKeyPairSync("ed25519"), mods = [["alpha", "1.0.0"], ["beta", "2.1.0"]] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rel-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [n, v] of mods) mod(root, "core", n, v);
  const write = (key2, counter2) => {
    const list = buildModuleList(root, { counter: counter2, release: "0.3.0" });
    fs.writeFileSync(path.join(root, "modules.json"), list);
    const sums = `${sha(list)}  modules.json\n${sha("x")}  vyre.tgz\n`;
    fs.writeFileSync(path.join(root, "SHA256SUMS"), sums);
    fs.writeFileSync(path.join(root, "SHA256SUMS.sig"), crypto.sign(null, Buffer.concat([Buffer.from("vyre-release-sums\n"), Buffer.from(sums)]), key2.privateKey).toString("base64"));
  };
  write(key, counter);
  return { root, key, write, dir: n => path.join(root, "core", n), pub: key.publicKey };
}

test("release list: a module is first party only when the signed list names it, its folder hashes to the listed tree and its version matches", t => {
  const r = release(t);
  const list = readReleaseList(r.root, r.pub);
  assert.equal(list.ok, true, JSON.stringify(list));
  const said = [];
  const check = createListCheck(list, m => said.push(m));
  assert.equal(check(r.dir("alpha")), true);
  assert.equal(check(r.dir("beta")), true);
  // a tampered file, an added file, a different version, an unlisted extra module
  fs.appendFileSync(path.join(r.dir("alpha"), "index.js"), "\n// tampered");
  assert.equal(check(r.dir("alpha")), false);
  assert.ok(said.some(m => /alpha is not first party: it was changed after it was signed/.test(m)), said.join(" | "));
  fs.writeFileSync(path.join(r.dir("beta"), "extra.js"), "1");
  assert.equal(check(r.dir("beta")), false, "an added file");
  const ghost = mod(r.root, "core", "ghost", "1.0.0");
  assert.equal(check(ghost), false, "a module the list does not name");
  assert.ok(said.some(m => /ghost is not first party: the release's signed list does not name it/.test(m)));
  const gamma = mod(r.root, "core", "gamma", "1.0.0");
  const l2 = readReleaseList(r.root, r.pub);
  assert.equal(l2.ok, true, "adding a folder does not change the signed files");
  fs.writeFileSync(path.join(r.dir("alpha"), "module.json"), JSON.stringify({ name: "alpha", version: "9.9.9" }));
  assert.equal(createListCheck(l2)(r.dir("alpha")), false, "a version that differs from the list");
  assert.ok(gamma);
});

test("release list: no signature, a signature by another key, a modules.json edited after signing, and a missing list are all refused with a reason", t => {
  const r = release(t);
  assert.equal(readReleaseList(r.root, crypto.generateKeyPairSync("ed25519").publicKey).ok, false, "another key");
  fs.appendFileSync(path.join(r.root, "modules.json"), " ");
  const edited = readReleaseList(r.root, r.pub);
  assert.equal(edited.ok, false); assert.match(edited.why, /not the file the signed SHA256SUMS lists/);
  r.write(r.key, 5);
  fs.rmSync(path.join(r.root, "SHA256SUMS.sig"));
  assert.match(readReleaseList(r.root, r.pub).why, /has no signature/);
  r.write(r.key, 5);
  fs.rmSync(path.join(r.root, "modules.json"));
  assert.match(readReleaseList(r.root, r.pub).why, /no signed list of modules/);
  r.write(r.key, 5);
  const ok = readReleaseList(r.root, r.pub);
  assert.equal(ok.ok, true);
  assert.deepEqual(verifyRawList(ok.raw, r.pub) && verifyRawList(ok.raw, r.pub).counter, 5);
  assert.equal(verifyRawList({ ...ok.raw, list: ok.raw.list.replace("5", "9") }, r.pub), null, "edited material does not verify");
  assert.equal(verifyRawList(ok.raw, crypto.generateKeyPairSync("ed25519").publicKey), null);
});

test("release list at boot: the signed list makes modules first party, a rollback or a missing file never relaxes it, and a forged log event counts for nothing", { timeout: 120_000 }, async t => {
  const r = release(t, { counter: 5 });
  const root = tempHome(t), dbFile = path.join(root, "k.db");
  const boot = async (logs = []) => bootHomeKernel({ db: new DatabaseSync(dbFile), root, log: m => logs.push(m), isFirstParty: () => false, releaseKey: r.pub, packageRoot: r.root });
  let k = await boot();
  assert.equal(k.firstPartyCheck(r.dir("alpha")), true, "the signed list makes alpha first party");
  assert.equal(k.log.read({ type: "kernel.modules-list" }).length, 1);
  await k.stop();
  // a rolled-back list (counter 3) does not replace the accepted one (5)
  fs.appendFileSync(path.join(r.dir("alpha"), "index.js"), "\n// a later edit");
  r.write(r.key, 3);
  const logs = [];
  k = await boot(logs);
  assert.equal(k.firstPartyCheck(r.dir("alpha")), false, "alpha was edited: not first party by either list");
  assert.ok(logs.some(m => /older than one already accepted/.test(m)), logs.join(" | "));
  // the files go away entirely: the last accepted list stays in force (alpha beta untouched stays first party)
  fs.rmSync(path.join(r.root, "SHA256SUMS.sig"));
  const logs2 = [];
  await k.stop();
  k = await boot(logs2);
  assert.equal(k.firstPartyCheck(r.dir("beta")), true, "beta still first party: nothing relaxed and nothing taken away");
  assert.ok(logs2.some(m => /last accepted module list stays in force/.test(m)));
  // a forged event: a high counter with no signature behind it
  const writer = k.chains.fromFacts({ kind: "module", module: "home", first_party: true });
  await k.log.append(writer, { type: "kernel.modules-list", sv: 1, subject: `vyre://${k.id.space}/kernel/modules-list`, data: { counter: 9999, raw: { list: "{}", sums: "", sig: "" } }, vis: "owner", red: "internal" });
  await k.stop();
  const logs3 = [];
  k = await boot(logs3);
  assert.ok(logs3.some(m => /does not carry a list the release key signed/.test(m)));
  assert.equal(k.firstPartyCheck(r.dir("beta")), true);
  await k.stop();
});

import { signModule } from "./firstparty.js";

test("SG-1 and SG-2: the signed list decides for every name it holds (an old module.sig is no OR), and that name stays reserved so a failing folder is refused", { timeout: 120_000 }, async t => {
  const r = release(t, { counter: 5 });
  const root = tempHome(t), dbFile = path.join(root, "k.db");
  const logs = [];
  const k = await bootHomeKernel({ db: new DatabaseSync(dbFile), root, log: m => logs.push(m), isFirstParty: () => false, releaseKey: r.pub, packageRoot: r.root });
  t.after(() => k.stop());
  assert.equal(k.firstPartyCheck(r.dir("alpha")), true);
  // alpha is edited after the list was signed, then given its OWN valid module.sig by the same release key: the list still says no
  fs.appendFileSync(path.join(r.dir("alpha"), "index.js"), "\n// swapped");
  signModule(r.dir("alpha"), r.key.privateKey);
  assert.equal(k.firstPartyCheck(r.dir("alpha")), false, "a valid module.sig is not an OR with the list");
  // a folder with a name the list holds is reserved even when it fails; a name the list does not hold is not
  assert.equal(k.reservedName("alpha"), true);
  assert.equal(k.reservedName("somebody-elses"), false);
  // the host refuses the failing folder: a module folder named alpha that fails the list never loads as an added module, and a failing copy is not an OR either
  const { Registry, discover } = await import("../../core/modules/index.js");
  const { open } = await import("../../core/store/index.js");
  const { Events } = await import("../../core/events/index.js");
  const db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {}, firstPartyCheck: k.firstPartyCheck, reservedName: k.reservedName });
  await reg.start(discover([path.join(r.root, "core")]), { role: "local" });
  const alpha = [...reg.modules.entries()].filter(([n]) => n === "alpha" || n.startsWith("alpha@"));
  assert.ok(alpha.length >= 1 && alpha.every(([, v]) => v.state === "invalid"), "the failing alpha is refused, never loaded: " + JSON.stringify(alpha.map(([n, v]) => [n, v.state])));
  assert.match(alpha[0][1].error, /belongs to a module shipped with Vyre/);
  assert.equal(reg.modules.get("beta").state !== "invalid", true, "the listed, intact beta loads");
});

test("SG-3: the counter advances only after the listed modules verify, and an owner resets it only with presence", { timeout: 120_000 }, async t => {
  const r = release(t, { counter: 5 });
  const root = tempHome(t), dbFile = path.join(root, "k.db");
  const boot = async (logs = []) => bootHomeKernel({ db: new DatabaseSync(dbFile), root, log: m => logs.push(m), isFirstParty: () => false, releaseKey: r.pub, packageRoot: r.root });
  // a build whose folder was changed after signing never raises the counter
  fs.appendFileSync(path.join(r.dir("alpha"), "index.js"), "\n// changed");
  const logs = [];
  let k = await boot(logs);
  assert.equal(k.log.read({ type: "kernel.modules-list" }).length, 0, "nothing was accepted");
  assert.ok(logs.some(m => /do not all match its signed list \(alpha\)/.test(m)), logs.join(" | "));
  assert.equal(k.firstPartyCheck(r.dir("alpha")), false);
  await k.stop();
  // an intact build at counter 5 is accepted; a later intact one at 7 advances it
  const r2 = release(t, { counter: 7, key: r.key });
  k = await bootHomeKernel({ db: new DatabaseSync(dbFile), root, log: () => {}, isFirstParty: () => false, releaseKey: r.pub, packageRoot: r2.root });
  assert.equal(k.log.read({ type: "kernel.modules-list" }).length, 1);
  await k.stop();
  // the older build is below 7: refused, and a reset needs the owner and a presence proof
  const logs3 = [];
  k = await boot(logs3);
  assert.ok(logs3.some(m => /older than one already accepted/.test(m)), logs3.join(" | "));
  assert.equal(k.firstPartyCheck(r.dir("alpha")), false, "the accepted list (7) holds the original alpha; the changed folder fails it");
  const owner = k.chains.fromFacts({ kind: "socket", surface: "cli", uid: process.getuid() });
  assert.equal((await k.resetModulesList(owner, null)).ok, false, "no proof");
  const other = k.chains.fromFacts({ kind: "module", module: "x" });
  assert.equal((await k.resetModulesList(other, null)).why, "owner_only");
  await k.stop();
});

test("SG-6: a kernel.modules-list event not written by the home counts for nothing, even carrying a genuine newer list", { timeout: 120_000 }, async t => {
  const r = release(t, { counter: 5 });
  const newer = release(t, { counter: 50, key: r.key, mods: [["zeta", "1.0.0"]] });
  const root = tempHome(t), dbFile = path.join(root, "k.db");
  const boot = async (logs = []) => bootHomeKernel({ db: new DatabaseSync(dbFile), root, log: m => logs.push(m), isFirstParty: () => false, releaseKey: r.pub, packageRoot: r.root });
  let k = await boot();
  const raw = readReleaseList(newer.root, r.pub).raw;
  const forger = k.chains.fromFacts({ kind: "module", module: "added-thing" });
  await k.log.append(forger, { type: "kernel.modules-list", sv: 1, subject: `vyre://${k.id.space}/kernel/modules-list`, data: { counter: 50, raw }, vis: "owner", red: "internal" });
  await k.stop();
  const logs = [];
  k = await boot(logs);
  assert.ok(logs.some(m => /not written by the home/.test(m)), logs.join(" | "));
  assert.equal(k.firstPartyCheck(r.dir("alpha")), true, "this build is not disabled by it");
  await k.stop();
});
