// @ts-check
// Plain `vyre capsule` builds the native Capsule on first run and again when its source changes,
// and says in one line how to get swiftc when it is missing. swiftc, codesign and security are
// fakes here: nothing is compiled, signed or read from the keychain.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "../../../test/helpers.js";
import { SCRATCH } from "../../../test/scratch.mjs";
import { ensureBuilt, nativeHash, state, appPath, launchArgs, toolchain, identity, recordCLI, CLI } from "./capsule-native.js";

function fakeNative(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-native-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "Sources", "Host"), { recursive: true });
  fs.mkdirSync(path.join(dir, "Tests"));
  fs.writeFileSync(path.join(dir, "build.sh"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(dir, "Sources", "Host", "App.swift"), "// one");
  fs.writeFileSync(path.join(dir, "Tests", "AppTests.swift"), "// a test");
  return dir;
}

/** A runner that plays swiftc/codesign/security, and records what it was asked. */
function fakeRunner({ swiftc = true, identity = false, buildOk = true } = {}) {
  const calls = [];
  /** @type {import("./capsule-native.js").Runner} */
  const r = (cmd, args, opts = {}) => {
    calls.push([cmd, ...args]);
    if (cmd === "xcrun") return swiftc ? { status: 0, stdout: "/usr/bin/swiftc\n" } : { status: 1, stdout: "", stderr: "xcrun: error" };
    if (cmd === "security") return { status: 0, stdout: identity ? '  1) ABC "Vyre Local"\n' : "0 valid identities found\n" };
    if (cmd === "codesign") return { status: 0 };
    if (cmd === "sh") {
      const env = /** @type {any} */ (opts).env;
      calls.push(["sign-with", env.VYRE_SIGN_IDENTITY || "ad hoc"]);
      if (!buildOk) return { status: 1, stderr: "App.swift:1:1: error: nope\n" };
      const bin = path.join(env.VYRE_CAPSULE_BUILD, "Vyre.app", "Contents", "MacOS");
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, "Vyre"), "bin");
      return { status: 0, stdout: "built\n" };
    }
    return { status: 127 };
  };
  return { r, calls };
}

test("capsule native: built on first run, not again while the source is the same, again when it changes", t => {
  const home = tempHome(t);
  const dir = fakeNative(t);
  const { r, calls } = fakeRunner();
  const said = [];
  const a = ensureBuilt({ dir, home, runner: r, say: s => said.push(s) });
  assert.equal(a.ok, true);
  assert.equal(a.built, true);
  assert.equal(a.app, appPath(home));
  assert.ok(fs.existsSync(path.join(a.app, "Contents", "MacOS", "Vyre")));
  assert.match(said[0], /Building Lumen/);
  assert.deepEqual(state(dir, a.app).fresh, true);

  const b = ensureBuilt({ dir, home, runner: r });
  assert.equal(b.built, false, "same source: no rebuild");
  assert.equal(calls.filter(c => c[0] === "sh").length, 1);

  fs.writeFileSync(path.join(dir, "Tests", "AppTests.swift"), "// changed test");
  assert.equal(ensureBuilt({ dir, home, runner: r }).built, false, "tests are not part of the app");

  fs.writeFileSync(path.join(dir, "Sources", "Host", "App.swift"), "// two");
  const said2 = [];
  const c = ensureBuilt({ dir, home, runner: r, say: s => said2.push(s) });
  assert.equal(c.built, true);
  assert.match(said2[0], /changed: rebuilding/);
});

test("capsule native: the CLI is recorded in <home>/capsule/cli.json, so a Capsule with vyred down can start it", t => {
  const home = tempHome(t);
  const dir = fakeNative(t);
  const { r } = fakeRunner();
  ensureBuilt({ dir, home, runner: r });
  const f = path.join(home, "capsule", "cli.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { cli: CLI });
  assert.equal(CLI[0], process.execPath);
  assert.ok(fs.existsSync(CLI[1]) && CLI[1].endsWith(path.join("bin", "vyre")), "the package's own bin/vyre");
  assert.equal(recordCLI(home), false, "unchanged: not written again");
  assert.equal(recordCLI(home, ["/usr/local/bin/vyre"]), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { cli: ["/usr/local/bin/vyre"] });
});

test("capsule native: no Command Line Tools is one line that names xcode-select --install", t => {
  const home = tempHome(t);
  const dir = fakeNative(t);
  const { r, calls } = fakeRunner({ swiftc: false });
  const a = ensureBuilt({ dir, home, runner: r });
  assert.equal(a.ok, false);
  assert.match(a.message, /xcode-select --install/);
  assert.equal(a.message.split("\n").length, 1);
  assert.equal(calls.some(c => c[0] === "sh"), false, "nothing is built");
  assert.equal(toolchain(r).ok, false);
});

test("capsule native: signed with Vyre Local when the keychain has it, ad hoc otherwise", t => {
  const home = tempHome(t);
  const dir = fakeNative(t);
  const withId = fakeRunner({ identity: true });
  ensureBuilt({ dir, home, runner: withId.r });
  assert.deepEqual(withId.calls.find(c => c[0] === "sign-with"), ["sign-with", "Vyre Local"]);
  assert.equal(identity(withId.r), "Vyre Local");

  const home2 = tempHome(t);
  const plain = fakeRunner();
  ensureBuilt({ dir, home: home2, runner: plain.r });
  assert.deepEqual(plain.calls.find(c => c[0] === "sign-with"), ["sign-with", "ad hoc"]);
});

test("capsule native: a failed build says the compiler's error and leaves no app", t => {
  const home = tempHome(t);
  const dir = fakeNative(t);
  const { r } = fakeRunner({ buildOk: false });
  const a = ensureBuilt({ dir, home, runner: r });
  assert.equal(a.ok, false);
  assert.match(a.message, /did not build:\nApp\.swift:1:1: error: nope/);
  assert.equal(fs.existsSync(appPath(home)), false);
});

test("capsule native: the launch passes the home and socket through open --env", () => {
  assert.deepEqual(launchArgs("/h/capsule/Vyre.app", { VYRE_HOME: "/h", VYRE_CAPSULE_OPEN: "1" }),
    ["--env", "VYRE_HOME=/h", "--env", "VYRE_CAPSULE_OPEN=1", "/h/capsule/Vyre.app"]);
  assert.equal(typeof nativeHash, "function");
});

// ------------------------------------------------------------------ the stable identity

import { shouldAsk, offerIdentity, createIdentity, IDENTITY_QUESTION, AD_HOC_NOTE } from "./capsule-native.js";

/** A keychain that answers like `security` and `openssl` do, and gains the identity on import. */
function fakeKeychain({ trustFails = false } = {}) {
  const calls = [];
  let has = false;
  /** @type {import("./capsule-native.js").Runner} */
  const r = (cmd, args) => {
    calls.push([cmd.split("/").pop(), args[0]]);
    if (cmd.endsWith("security") && args[0] === "find-identity") return { status: 0, stdout: has ? '  1) ABC "Vyre Local"\n' : "0 valid identities found\n" };
    if (cmd.endsWith("security") && args[0] === "add-trusted-cert") { if (trustFails) return { status: 1, stderr: "User canceled the operation." }; has = true; return { status: 0 }; }
    return { status: 0 };
  };
  return { r, calls };
}

const OWN = { real: true, allowed: true };

test("capsule native: the identity is offered only on the person's own install, with a terminal, once", async t => {
  const home = tempHome(t);
  const k = fakeKeychain();
  assert.equal(shouldAsk({ home, tty: true, runner: k.r }), false, "a temp home is never asked (and tests have no dialogs)");
  assert.equal(shouldAsk({ home, tty: false, runner: k.r, _gate: OWN }), false, "no terminal, no question");
  assert.equal(shouldAsk({ home, tty: true, runner: k.r, _gate: { real: true, allowed: false } }), false, "dialogs off, no question");
  assert.equal(shouldAsk({ home, tty: true, runner: k.r, _gate: OWN }), true);

  const asked = [];
  const line = await offerIdentity({ home, tty: true, runner: k.r, _gate: OWN, tmp: SCRATCH, ask: async q => { asked.push(q); return false; } });
  assert.deepEqual(asked, [IDENTITY_QUESTION]);
  assert.equal(line, AD_HOC_NOTE, "no means ad hoc, and one line that says what that costs");
  assert.equal(k.calls.some(c => c[1] === "import"), false, "nothing touches the keychain on a no");
  assert.equal(await offerIdentity({ home, tty: true, runner: k.r, _gate: OWN, ask: async () => { throw new Error("asked twice"); } }), null);
});

test("capsule native: yes makes the identity in the keychain given, trusted for code signing, and leaves no key on disk", async t => {
  const home = tempHome(t);
  const k = fakeKeychain();
  const tmp = fs.mkdtempSync(path.join(SCRATCH, "sign-tmp-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const line = await offerIdentity({ home, tty: true, runner: k.r, _gate: OWN, tmp, keychain: "/k/test.keychain", ask: async () => true });
  assert.match(line, /made "Vyre Local" in your login keychain/);
  assert.deepEqual(k.calls.filter(c => c[0] !== "security" || c[1] !== "find-identity"),
    [["openssl", "req"], ["openssl", "pkcs12"], ["security", "import"], ["security", "add-trusted-cert"]]);
  assert.deepEqual(fs.readdirSync(tmp), [], "the key and certificate files are gone");
});

test("capsule native: a refused password leaves ad hoc signing and says so", t => {
  const k = fakeKeychain({ trustFails: true });
  const r = createIdentity({ runner: k.r, tmp: SCRATCH, keychain: "/k/test.keychain" });
  assert.equal(r.ok, false);
  assert.match(r.message, /security add-trusted-cert did not work: User canceled/);
});

test("capsule native: an app signed ad hoc is rebuilt once the identity exists", t => {
  const home = tempHome(t);
  const dir = fakeNative(t);
  const plain = fakeRunner();
  ensureBuilt({ dir, home, runner: plain.r });
  const withId = fakeRunner({ identity: true });
  const b = ensureBuilt({ dir, home, runner: withId.r });
  assert.equal(b.built, true);
  assert.deepEqual(withId.calls.find(c => c[0] === "sign-with"), ["sign-with", "Vyre Local"]);
  assert.equal(ensureBuilt({ dir, home, runner: withId.r }).built, false);
});

test("capsule native: with no terminal, createIdentity says so and runs nothing (security would wait for a password)", () => {
  const r = createIdentity({ tty: false, tmp: SCRATCH });
  assert.equal(r.ok, false);
  assert.match(r.message, /needs a terminal/);
});
