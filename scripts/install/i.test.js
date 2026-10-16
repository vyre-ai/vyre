// @ts-check
// scripts/install/i.sh with a fake `vyre` command and a fake release installer: no network, no Docker, a temp folder.
// The terminal QR, the three-word pick and --pair-to are gone: an install line pairs the server, and a line without a code points at the setup page.

import "../mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "i.sh");

function rig(t, { installed = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-i-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "log");
  fs.writeFileSync(path.join(dir, "installer.sh"), `#!/bin/sh\necho "installer $*" >> "${log}"\ntouch "${dir}/installed"\n`);
  fs.writeFileSync(path.join(dir, "vyre"), `#!/bin/sh
echo "vyre $*" >> "${log}"
[ "$1" = call ] || exit 0
case "$2" in
  system.info) [ -f "${dir}/installed" ] || exit 1; echo '{"data":{}}' ;;
esac
`, { mode: 0o755 });
  if (installed) fs.writeFileSync(path.join(dir, "installed"), "");
  const run = (env = {}, args = []) => spawnSync("sh", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: `${dir}:${process.env.PATH}`, VYRE_WRAPPER: path.join(dir, "vyre"), VYRE_INSTALLER: path.join(dir, "installer.sh"), ...env } });
  return { dir, log, run, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "") };
}

test("install: installs, then points at the setup page, and makes no pairing code", t => {
  const r = rig(t);
  const out = r.run();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /http:\/\/\S+\/setup/);
  assert.match(out.stdout, /paste the code the Vyre app shows/);
  assert.doesNotMatch(out.stdout + out.stderr, /vyre:\/\/wink|Scan this|Pair this server|wink\.server\.code/);
  assert.match(r.calls(), /^installer/m, "the release installer ran");
  assert.doesNotMatch(r.calls(), /wink\.server\.code/);
});

test("install: the Vyre app's Add a server line (VYRE_CODE) runs the release installer with the code and shows no terminal pairing", t => {
  const r = rig(t);
  const out = r.run({ VYRE_CODE: "WINK-TEST-CODE" });
  assert.equal(out.status, 0, out.stderr);
  assert.match(r.calls(), /^installer/m, "the release installer ran");
  assert.doesNotMatch(r.calls(), /wink\.server\.(code|pairing)/, "no pairing code is made and nobody is waited for");
  assert.match(out.stdout, /Go back to the Vyre app/);
  assert.doesNotMatch(out.stdout, /Pair this server|Scan this with the Vyre app|vyre:\/\/wink|Nobody asked/);
});

test("install: idempotent. An installed server is left alone and the setup page is named", t => {
  const r = rig(t, { installed: true });
  const out = r.run();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /already installed/);
  assert.match(out.stdout, /\/setup/);
  assert.doesNotMatch(r.calls(), /^installer/m, "nothing was installed again");
});

test("install: refuses a system or a processor Vyre does not run on, in plain words", t => {
  const r = rig(t);
  const a = r.run({ VYRE_UNAME_S: "FreeBSD" });
  assert.notEqual(a.status, 0);
  assert.match(a.stderr, /Linux or a Mac/);
  const b = r.run({ VYRE_UNAME_M: "i686" });
  assert.notEqual(b.status, 0);
  assert.match(b.stderr, /64-bit/);
  assert.equal(r.calls(), "", "nothing ran");
});

test("install: never takes the setup code as an argument and never prints a secret", t => {
  const r = rig(t);
  const out = r.run({ VYRE_CODE: "SECRETSECRETSECRETSECRETSECRETSECRETSECRET1", VYRE_SETUP_CODE: "topsecret" });
  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stdout + out.stderr, /SECRETSECRET|topsecret/);
  assert.doesNotMatch(fs.readFileSync(SCRIPT, "utf8"), /\u2014|\u00a7/, "no em dash and no section sign");
  assert.doesNotMatch(r.calls(), /SECRETSECRET/);
});

test("install: a script piped from curl is read whole first (everything runs from main on the last line)", () => {
  const src = fs.readFileSync(SCRIPT, "utf8").trimEnd().split("\n");
  assert.equal(src[src.length - 1], 'main "$@"');
});

test("install: --pair-to is refused and the installer does not run", t => {
  const r = rig(t);
  const out = r.run({}, ["--pair-to", "alex", "--some-installer-flag"]);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /install line/);
  assert.equal(r.calls(), "", "nothing was installed");
});
