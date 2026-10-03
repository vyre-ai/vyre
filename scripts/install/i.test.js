// @ts-check
// scripts/install/i.sh with a fake `vyre` command and a fake release installer: no network, no Docker, a temp folder.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { qrArt, qrLines } from "../../relay/client/qr.js";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "i.sh");

function rig(t, { installed = false, confirm = "ok", code = "ok", sudoSays = "", qr = "", strict = false, qrencode = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-i-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "log");
  fs.writeFileSync(path.join(dir, "installer.sh"), `#!/bin/sh\necho "installer $*" >> "${log}"\ntouch "${dir}/installed"\n`);
  fs.writeFileSync(path.join(dir, "vyre"), `#!/bin/sh
echo "vyre $*" >> "${log}"
[ "$1" = call ] || exit 0
case "$2" in
  system.info) [ -f "${dir}/installed" ] || exit 1; echo '{"data":{}}' ;;
  wink.server.code) ${strict ? `case "$3" in *qr*) printf '  bad_input: unknown input qr\\n' >&2; exit 1 ;; esac;` : ""} ${qr ? `case "$3" in *qr*) cat "${dir}/qr.json"; exit 0 ;; esac;` : ""} ${code === "ok" ? `echo '{"data":{"offer":"wo_000-abc","code":"WINK-K7QM-4P2X","expires":1}}'` : code === "old" ? `printf '\\033[1m  no_such_tool: \\033[0mno tool wink.server.code\\n' >&2; exit 1` : `printf "  unavailable: Can't connect.\\n"; exit 1`} ;;
  wink.server.confirm) ${confirm === "ok" ? `echo '{"data":{"ok":true}}'` : `echo '{"data":{"ok":false}}'`} ;;
esac
`, { mode: 0o755 });
  if (qr) fs.writeFileSync(path.join(dir, "qr.json"), qr);
  if (qrencode) fs.writeFileSync(path.join(dir, "qrencode"), `#!/bin/sh\necho "qrencode $*" >> "${log}"\nprintf 'FAKE-QRENCODE-ART\\n'\n`, { mode: 0o755 });
  if (sudoSays) fs.writeFileSync(path.join(dir, "sudo"), `#!/bin/sh\necho "sudo $*" >> "${log}"\nprintf '%s\\n' "${sudoSays}" >&2\nexit 1\n`, { mode: 0o755 });
  if (installed) fs.writeFileSync(path.join(dir, "installed"), "");
  const run = (env = {}, input = "") => spawnSync("sh", [SCRIPT], { encoding: "utf8", input, env: { PATH: `${dir}:${process.env.PATH}`, VYRE_WRAPPER: path.join(dir, "vyre"), VYRE_INSTALLER: path.join(dir, "installer.sh"), VYRE_NO_PROMPT: "1", ...env } });
  return { dir, log, run, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "") };
}

test("install: installs, then prints a pairing code and the command to type the app's code back", t => {
  const r = rig(t);
  const out = r.run();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /WINK-K7QM-4P2X/);
  assert.match(out.stdout, /Pair to:/);
  assert.match(out.stdout, /wink\.server\.confirm/);
  assert.match(r.calls(), /^installer/m, "the release installer ran");
});

test("install: idempotent. An installed server is left alone and a code is still shown", t => {
  const r = rig(t, { installed: true });
  const out = r.run();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /already installed/);
  assert.doesNotMatch(r.calls(), /^installer/m, "nothing was installed again");
  assert.match(out.stdout, /WINK-K7QM-4P2X/);
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
});

test("install: a script piped from curl is read whole first (everything runs from main on the last line)", () => {
  const src = fs.readFileSync(SCRIPT, "utf8").trimEnd().split("\n");
  assert.equal(src[src.length - 1], 'main "$@"');
});

test("install: an old release with no pairing tool is told so at once, not after two minutes", t => {
  const r = rig(t, { code: "old" });
  const out = r.run({ VYRE_CODE_TRIES: "40" });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /cannot be paired by a code yet/);
});

test("install: when the server will not make a code, the reason it gave is shown", t => {
  const r = rig(t, { code: "down" });
  const out = r.run({ VYRE_CODE_TRIES: "1" });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /unavailable: Can't connect/);
});

test("install: the reason the server gave is kept when the sudo retry fails for a reason of its own (the real run showed the update refusal instead of the relay's)", t => {
  const r = rig(t, { code: "down", sudoSays: "vyre: this box builds from a checkout of your own" });
  const out = r.run({ VYRE_CODE_TRIES: "1" });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /unavailable: Can't connect/);
  assert.doesNotMatch(out.stderr, /builds from a checkout/);
});

const PAYLOAD = "vyre://wink/2?t=AAECAwQFBgcICQoLDA0ODw&r=wss%3A%2F%2Frelay.test";
const withQr = () => JSON.stringify({ data: { offer: "wo_000-abc", code: "WINK-K7QM-4P2X", expires: 1, qr: PAYLOAD, art: qrArt(PAYLOAD) } });

test("install: prints a QR as well as the code, drawn by the box when there is no qrencode, and no network is touched", t => {
  const r = rig(t, { qr: withQr() });
  const out = r.run({ VYRE_SITE: "https://invalid.invalid" });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /WINK-K7QM-4P2X/);
  assert.match(out.stdout, /scan this with the Vyre app/);
  const lines = qrLines(PAYLOAD);
  for (const l of lines) assert.ok(out.stdout.includes(`    ${l}\n`), "every row of the box's drawing is printed");
  assert.ok(lines.length > 15 && lines[0].length < 80, "it fits a terminal");
  assert.match(r.calls(), /wink\.server\.code \{"qr":true\}/);
  assert.doesNotMatch(out.stdout + out.stderr, /AAECAwQFBgcICQoLDA0ODw/, "the secret is in the drawing only, never printed as text when a drawing exists");
});

test("install: qrencode is used when the server has it, and the box's drawing is not", t => {
  const r = rig(t, { qr: withQr(), qrencode: true });
  const out = r.run();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /FAKE-QRENCODE-ART/);
  assert.match(r.calls(), /qrencode -t ANSIUTF8 .*vyre:\/\/wink\/2\?t=AAECAwQFBgcICQoLDA0ODw/);
  assert.ok(!out.stdout.includes(qrLines(PAYLOAD)[3]));
});

test("install: a release that does not know the qr option gets the plain call, and the code still prints with no QR", t => {
  const r = rig(t, { strict: true });
  const out = r.run();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /WINK-K7QM-4P2X/);
  assert.doesNotMatch(out.stdout, /scan this/);
  assert.match(r.calls(), /wink\.server\.code \{"qr":true\}/);
  assert.match(r.calls(), /wink\.server\.code \{\}/);
});

test("install: with a QR showing, an empty line at the prompt ends cleanly (the scan finishes the pairing by itself)", () => {
  // The prompt reads /dev/tty, which a test has none of: the behaviour is checked in the source.
  assert.match(fs.readFileSync(SCRIPT, "utf8"), /\[ -z "\$qr" \] \|\| \{ say "  If you scanned the QR, the app finishes the pairing by itself\."; return 0; \}/);
});

test("install: the vendored QR encoder is the pinned file and the QR needs no download", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../relay/client/vendor");
  const pins = JSON.parse(fs.readFileSync(path.join(dir, "PINS-qr.json"), "utf8"));
  assert.equal(pins.source.licence, "MIT");
  assert.ok(fs.existsSync(path.join(dir, "LICENSE.qrcode-generator")));
  const src = fs.readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(src.split("show_qr()")[1].split("# show_code")[0], /curl|wget|fetch /, "show_qr never downloads anything");
});
