// @ts-check
// The Windows install script verifies the release signature in plain PowerShell (.NET BigInteger), because
// Windows PowerShell 5.1 has no Ed25519. This runs that code on Windows, in Windows PowerShell and in
// PowerShell 7, against launch's shared vector (also checked by the box and the Mac installer).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/install-windows.ps1", import.meta.url));
const KEY = "MCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=";
const SUMS = "a".repeat(64) + "  manifest.json\n" + "b".repeat(64) + "  vyre.tgz\n";
const SIG = "X+aWDX+6p5YDh32E4tUXAHKEvCwi36rUm4I889QLs2I6b4hlP0J05o8PNtuyZnsCaqMkiv2MWmqJ3fllTLIzDA==";
const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 7)]), format: "der", type: "pkcs8" });
const BARE = crypto.sign(null, Buffer.from(SUMS), priv).toString("base64");

/** @param {string} shell @param {string} sums @param {string} sig @param {string} key */
function check(shell, sums, sig, key) {
  const b64 = Buffer.from(sums).toString("base64");
  const ps = `$env:VYRE_LIB_ONLY='1'; . '${SCRIPT}'; $b=[Convert]::FromBase64String('${b64}'); [string](Test-ReleaseSignature $b '${sig}' '${key}')`;
  const r = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout.trim().split(/\r?\n/).pop();
}

for (const shell of ["powershell", "pwsh"]) {
  test(`windows installer: the release signature check, in ${shell}`, { skip: process.platform !== "win32" && "Windows only" }, t => {
    if (spawnSync(shell, ["-NoProfile", "-Command", "1"]).error) return t.skip(`${shell} is not installed`);
    assert.equal(check(shell, SUMS, SIG, KEY), "True", "the shared vector verifies");
    assert.equal(check(shell, SUMS + "x", SIG, KEY), "False", "one more byte");
    assert.equal(check(shell, SUMS, BARE, KEY), "False", "a signature without the prefix is refused");
    assert.equal(check(shell, SUMS, SIG, "MCowBQYDK2VwAyEAfFTFccqQNhkHQ3II6EniEoRfWgDDDjQn+GKEJZQIHoE="), "False", "another key");
    assert.equal(check(shell, SUMS, "AAAA", KEY), "False", "garbage");
  });
}

test("windows installer: pins the same release key as vyre-core", async () => {
  const { RELEASE_KEY } = await import("../core/vyre-core/release.js");
  const fs = await import("node:fs");
  assert.ok(fs.readFileSync(SCRIPT, "utf8").includes(`"${RELEASE_KEY}"`), "install-windows.ps1 carries RELEASE_KEY");
});

test("install-windows.ps1: a release key taken from the environment is announced, never silent", () => {
  const ps = fs.readFileSync(new URL("../scripts/install-windows.ps1", import.meta.url), "utf8");
  assert.match(ps, /if \(\$env:VYRE_RELEASE_KEY\) \{ Write-Host "Using a test release key from VYRE_RELEASE_KEY, not Vyre's\./);
});
