// @ts-check
// vyre-core's signing identity (ADR 0040 section 4), against a recording run. The real commands run on
// the macOS runner (scripts/mac-proof/run.sh): a Capsule.app in the test release is signed for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ensureIdentity, signApp, removeIdentity, retryPending, IDENTITY, CAPSULE_ID } from "./signing.js";
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
  assert.ok(!fs.existsSync(path.join(dir, "pw")), "no password file: the keychain's password is empty and the folder is the protection");
  const arg = (/** @type {string} */ sub, /** @type {string} */ flag) => f.calls.filter(c => c.args[0] === sub).map(c => c.args[c.args.indexOf(flag) + 1]);
  assert.deepEqual([...arg("create-keychain", "-p"), ...arg("unlock-keychain", "-p"), ...arg("import", "-P"), ...arg("set-key-partition-list", "-k")], ["", "", "vyre-scratch", ""], "the keychain passwords are empty and the scratch p12 carries a fixed public one: nothing secret in `ps`");
  assert.ok(f.calls.filter(c => c.cmd.endsWith("openssl")).every(c => !c.args.some(a => /^pass:./.test(a) && a !== "pass:vyre-scratch")));
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
});

test("signing: removeIdentity deletes the certificate and its trust by sha1, takes the keychain off root's list, and removes the folder", t => {
  const dir = dirOf(t), f = fake();
  const kc = path.join(dir, "vyre-core.keychain-db");
  let list = `    "/Library/Keychains/System.keychain"\n    "${kc}"\n`;
  const run = (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
    if (cmd.endsWith("security") && args[0] === "list-keychains" && args.length === 3) return list;
    if (cmd.endsWith("security") && args[0] === "list-keychains" && args[3] === "-s") { list = args.slice(4).map(k => `    "${k}"\n`).join(""); f.calls.push({ cmd, args }); return ""; }
    return f.run(cmd, args);
  };
  ensureIdentity({ dir, run, systemKeychain: "/tmp/System.keychain" });
  const r = removeIdentity({ dir, run, systemKeychain: "/tmp/System.keychain" });
  assert.deepEqual(r, { pending: null, command: null, listNote: null });
  assert.ok(!fs.existsSync(dir));
  assert.ok(f.calls.some(c => c.args[0] === "delete-certificate" && c.args.join(" ") === `delete-certificate -Z ${SHA1} /tmp/System.keychain`), "the certificate itself, by sha1");
  assert.ok(f.calls.some(c => c.args[0] === "remove-trusted-cert"), "and its trust settings, best effort");
  assert.ok(!list.includes(kc), "the keychain is off root's search list");
  assert.ok(!fs.existsSync(path.join(path.dirname(dir), ".signing-cert-retry")), "no retry record when it worked");
});

test("signing: when macOS will not delete the certificate, the sha1 is written outside the folder, the exact command is returned, and the next install retries", t => {
  const dir = dirOf(t), f = fake();
  let stuck = true;
  const run = (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
    if (cmd.endsWith("security") && args[0] === "delete-certificate" && stuck) throw new Error("timed out");
    if (cmd.endsWith("security") && args[0] === "find-certificate") return stuck ? "SHA-1 hash: " + SHA1 : (() => { throw new Error("not found"); })();
    return f.run(cmd, args);
  };
  ensureIdentity({ dir, run, systemKeychain: "/tmp/System.keychain" });
  const r = removeIdentity({ dir, run, systemKeychain: "/tmp/System.keychain" });
  assert.equal(r.pending, SHA1);
  assert.equal(r.command, `sudo /usr/bin/security delete-certificate -Z ${SHA1} /tmp/System.keychain`);
  assert.ok(!fs.existsSync(dir), "the key folder is gone regardless");
  const rec = path.join(path.dirname(dir), ".signing-cert-retry");
  assert.deepEqual(JSON.parse(fs.readFileSync(rec, "utf8")), { sha1: SHA1 });
  assert.equal(fs.statSync(rec).mode & 0o777, 0o600);
  assert.equal(retryPending({ dir, run, systemKeychain: "/tmp/System.keychain" }), SHA1, "still stuck: still pending");
  stuck = false;
  ensureIdentity({ dir, run, systemKeychain: "/tmp/System.keychain" }); // the next install retries first
  assert.ok(!fs.existsSync(rec), "done, record gone");
});

test("signing: an identity codesign would not list as valid fails at install, with what the keychain said", t => {
  const dir = dirOf(t);
  const f = fake();
  const run = (/** @type {string} */ cmd, /** @type {string[]} */ args) => (cmd.endsWith("security") && args[0] === "find-identity" ? "     0 valid identities found\n" : f.run(cmd, args));
  assert.throws(() => ensureIdentity({ dir, run }), /not valid for code signing.*0 valid identities found/);
  assert.ok(!fs.existsSync(path.join(dir, "identity.json")), "nothing recorded");
});
