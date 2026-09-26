// @ts-check
// Plain `vyre capsule` builds the native Capsule on first run and again when its source changes,
// and says in one line how to get swiftc when it is missing. swiftc, codesign and security are
// fakes here: nothing is compiled, signed or read from the keychain.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "../../../test/helpers.js";
import { SCRATCH } from "../../../test/scratch.mjs";
import { ensureBuilt, nativeHash, state, appPath, launchArgs, toolchain, identity } from "./capsule-native.js";

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
  assert.match(said[0], /Building the Capsule/);
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
  assert.match(said2[0], /source changed/);
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
