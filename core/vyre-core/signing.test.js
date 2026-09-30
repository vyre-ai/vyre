// @ts-check
// vyre-core's signing identity (ADR 0040 section 4), against a recording run. The real commands run on
// the macOS runner (scripts/mac-proof/run.sh): a Capsule.app in the test release is signed for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ensureIdentity, signApp, removeIdentity, IDENTITY, CAPSULE_ID } from "./signing.js";
import { SCRATCH } from "../../test/scratch.mjs";

const SHA1 = "AB".repeat(20);
const fp = SHA1.match(/../g)?.join(":");

/** A run that records, and answers the two commands whose output is read. */
function fake() {
  /** @type {{ cmd: string, args: string[] }[]} */ const calls = [];
  const run = (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
    calls.push({ cmd, args });
    if (cmd.endsWith("openssl") && args[0] === "x509") return `SHA1 Fingerprint=${fp}\n`;
    if (cmd.endsWith("codesign") && args[0] === "-d" && args[1] === "-r-") return `# designated => identifier "${CAPSULE_ID}" and certificate leaf = H"${SHA1.toLowerCase()}"\n`;
    if (cmd.endsWith("codesign") && args[0] === "-dvvv") return "Identifier=sh.vyre.capsule\nCDHash=0123456789abcdef0123456789abcdef01234567\n";
    if (cmd.endsWith("security") && args[0] === "find-identity" && args[1] === "-v") return `  1) ${SHA1} "${IDENTITY}"\n     1 valid identities found\n`;
    if (cmd.endsWith("openssl") && args[0] === "req") { const i = args.indexOf("-keyout"); fs.writeFileSync(args[i + 1], "KEY"); fs.writeFileSync(args[args.indexOf("-out") + 1], "CERT"); }
    if (cmd.endsWith("openssl") && args[0] === "pkcs12") fs.writeFileSync(args[args.indexOf("-out") + 1], "P12");
    if (cmd.endsWith("security") && args[0] === "create-keychain") fs.writeFileSync(args[args.length - 1], "KC");
    return "";
  };
  return { run, calls };
}
const dirOf = (/** @type {import("node:test").TestContext} */ t) => {
  const d = fs.mkdtempSync(path.join(SCRATCH, "sg-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, "signing");
};

test("signing: the identity is made once, in a folder only root can read, trusted for code signing only, key kept off the command line", t => {
  const dir = dirOf(t), f = fake();
  const a = ensureIdentity({ dir, run: f.run, systemKeychain: "/tmp/System.keychain" });
  assert.deepEqual([a.created, a.sha1], [true, SHA1]);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, "pw")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, "identity.json")).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.startsWith(".make-")), [], "no scratch left");
  const trust = f.calls.find(c => c.args[0] === "add-trusted-cert");
  assert.deepEqual(trust?.args.slice(0, 6), ["add-trusted-cert", "-d", "-r", "trustRoot", "-p", "codeSign"], "code signing only, admin domain");
  const cn = fs.readFileSync(path.join(dir, "identity.json"), "utf8");
  assert.ok(cn.includes(IDENTITY));
  const before = f.calls.length;
  const b = ensureIdentity({ dir, run: f.run });
  assert.equal(b.created, false);
  assert.equal(f.calls.length, before, "a second call runs nothing");
});

test("signing: signApp unlocks, signs with the certificate's hash and the Capsule's identifier, verifies, and returns the requirement and cdhash", t => {
  const dir = dirOf(t), f = fake();
  const r = signApp({ app: "/x/Vyre.app", dir, run: f.run });
  assert.equal(r.sha1, SHA1);
  assert.match(r.requirement, /identifier "sh\.vyre\.capsule" and certificate leaf/);
  assert.equal(r.cdhash, "0123456789abcdef0123456789abcdef01234567");
  const sign = f.calls.find(c => c.cmd.endsWith("codesign") && c.args.includes("--sign"));
  assert.ok(sign && sign.args.includes(SHA1) && sign.args.includes(CAPSULE_ID) && sign.args.includes("runtime") && sign.args.includes("/x/Vyre.app"));
  const order = f.calls.filter(c => c.cmd.endsWith("codesign")).map(c => c.args[0]);
  assert.deepEqual(order, ["--force", "--verify", "-d", "-dvvv"]);
  assert.ok(!f.calls.some(c => c.args.some(a => a.includes(fs.readFileSync(path.join(dir, "pw"), "utf8").trim())) && c.cmd.endsWith("codesign")), "the keychain password never reaches codesign");
});

test("signing: removeIdentity takes the trust and the folder away", t => {
  const dir = dirOf(t), f = fake();
  ensureIdentity({ dir, run: f.run });
  removeIdentity({ dir, run: f.run });
  assert.ok(!fs.existsSync(dir));
  assert.ok(f.calls.some(c => c.args[0] === "remove-trusted-cert"));
});

test("signing: an identity codesign would not list as valid fails at install, with what the keychain said", t => {
  const dir = dirOf(t);
  const f = fake();
  const run = (/** @type {string} */ cmd, /** @type {string[]} */ args) => (cmd.endsWith("security") && args[0] === "find-identity" ? "     0 valid identities found\n" : f.run(cmd, args));
  assert.throws(() => ensureIdentity({ dir, run }), /not valid for code signing.*0 valid identities found/);
  assert.ok(!fs.existsSync(path.join(dir, "identity.json")), "nothing recorded");
});
