// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "ios-upload.sh");
const SECRET = "-----BEGIN PRIVATE KEY-----\nTOPSECRETKEYTEXT\n-----END PRIVATE KEY-----";

/** A tarball holding an empty Vyre.xcarchive, and a fake xcodebuild that records its arguments and the key file it was given. */
function setup(t) {
  const dir = fs.mkdtempSync(path.join(process.env.SCRATCH || os.tmpdir(), "vyre-ios-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "src/Vyre.xcarchive"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/Vyre.xcarchive/Info.plist"), "x");
  spawnSync("tar", ["-czf", path.join(dir, "a.tgz"), "-C", path.join(dir, "src"), "Vyre.xcarchive"]);
  const fake = path.join(dir, "fake-xcodebuild");
  fs.writeFileSync(fake, `#!/bin/bash\necho "$@" > "${dir}/args"\nk=""; while [ $# -gt 0 ]; do [ "$1" = -authenticationKeyPath ] && k=$2; shift; done\ncp "$k" "${dir}/keycopy"; stat -f %Lp "$k" > "${dir}/mode" 2>/dev/null || stat -c %a "$k" > "${dir}/mode"\necho "$k" > "${dir}/keypath"\n`, { mode: 0o755 });
  const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, "a.tgz"))).digest("hex");
  const env = { PATH: process.env.PATH, ARCHIVE_TGZ: path.join(dir, "a.tgz"), ARCHIVE_SHA256: sha, WORK: path.join(dir, "work"), XCODEBUILD: fake,
    ASC_KEY_ID: "ABC123DEFG", ASC_ISSUER_ID: "11111111-2222-3333-4444-555555555555", ASC_KEY_P8: SECRET, APPLE_TEAM_ID: "TEAM123456" };
  return { dir, env };
}
const run = env => spawnSync("bash", [SCRIPT], { env, encoding: "utf8" });

test("ios-upload: a missing secret is one skip line and success, and xcodebuild never runs", t => {
  for (const k of ["ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_P8", "APPLE_TEAM_ID"]) {
    const { dir, env } = setup(t); delete env[k];
    const r = run(env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^skipped: ${k} is not set in the apple environment`, "m"));
    assert.ok(!fs.existsSync(path.join(dir, "args")), "xcodebuild did not run");
  }
});

test("ios-upload: exports with cloud signing, key file mode 600 and gone after, the key's text never on the command line or in the output", t => {
  const { dir, env } = setup(t);
  const r = run(env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const args = fs.readFileSync(path.join(dir, "args"), "utf8");
  for (const a of ["-exportArchive", "-allowProvisioningUpdates", "-authenticationKeyID ABC123DEFG", "-authenticationKeyIssuerID 11111111-2222-3333-4444-555555555555"]) assert.ok(args.includes(a), a);
  // ::add-mask:: lines are runner commands (the runner swallows them); every other line of output must be free of the key.
  const shown = (r.stdout + r.stderr).split("\n").filter(l => !l.startsWith("::add-mask::")).join("\n");
  assert.ok(!args.includes("TOPSECRET") && !shown.includes("TOPSECRET"));
  assert.match(fs.readFileSync(path.join(dir, "keycopy"), "utf8"), /TOPSECRETKEYTEXT/);
  assert.equal(fs.readFileSync(path.join(dir, "mode"), "utf8").trim(), "600");
  assert.ok(!fs.existsSync(fs.readFileSync(path.join(dir, "keypath"), "utf8").trim()), "the key file is deleted");
  const plist = fs.readFileSync(path.join(dir, "work/ExportOptions.plist"), "utf8");
  assert.match(plist, /<key>destination<\/key><string>upload<\/string>/);
  assert.match(plist, /<key>teamID<\/key><string>TEAM123456<\/string>/);
});

test("ios-upload: an archive that is not the build job's is refused before the key is written", t => {
  const { dir, env } = setup(t); env.ARCHIVE_SHA256 = "0".repeat(64);
  const r = run(env);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /not the one the build job made/);
  assert.ok(!fs.existsSync(path.join(dir, "work/AuthKey.p8")) && !fs.existsSync(path.join(dir, "args")));
});
