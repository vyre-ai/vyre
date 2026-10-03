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

const PAYLOAD = "vyre://wink/2?t=AAECAwQFBgcICQoLDA0ODw&r=wss%3A%2F%2Frelay.test";
const withQr = () => JSON.stringify({ data: { qr: PAYLOAD, art: qrArt(PAYLOAD), expires: 1 } });

function rig(t, { installed = false, code = "ok", sudoSays = "", qrencode = false, ask = "none" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-i-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "log");
  fs.writeFileSync(path.join(dir, "installer.sh"), `#!/bin/sh\necho "installer $*" >> "${log}"\ntouch "${dir}/installed"\n`);
  fs.writeFileSync(path.join(dir, "qr.json"), withQr());
  fs.writeFileSync(path.join(dir, "vyre"), `#!/bin/sh
echo "vyre $*" >> "${log}"
[ "$1" = call ] || exit 0
case "$2" in
  system.info) [ -f "${dir}/installed" ] || exit 1; echo '{"data":{}}' ;;
  wink.server.code) ${code === "ok" ? `cat "${dir}/qr.json"` : code === "old" ? `printf '\\033[1m  no_such_tool: \\033[0mno tool wink.server.code\\n' >&2; exit 1` : `printf "  unavailable: Can't connect.\\n"; exit 1`} ;;
  wink.server.pairing) ${ask === "asks" ? `echo '{"data":{"asking":true,"name":"Harlow Legal","words":"amber coral seven"}}'` : `echo '{"data":{"asking":false}}'`} ;;
  wink.server.pair.answer) echo '{"data":{"answered":true}}' ;;
esac
`, { mode: 0o755 });
  if (qrencode) fs.writeFileSync(path.join(dir, "qrencode"), `#!/bin/sh\necho "qrencode $*" >> "${log}"\nprintf 'FAKE-QRENCODE-ART\\n'\n`, { mode: 0o755 });
  if (sudoSays) fs.writeFileSync(path.join(dir, "sudo"), `#!/bin/sh\necho "sudo $*" >> "${log}"\nprintf '%s\\n' "${sudoSays}" >&2\nexit 1\n`, { mode: 0o755 });
  if (installed) fs.writeFileSync(path.join(dir, "installed"), "");
  const run = (env = {}, input = "", args = []) => spawnSync("sh", [SCRIPT, ...args], { encoding: "utf8", input, env: { PATH: `${dir}:${process.env.PATH}`, VYRE_WRAPPER: path.join(dir, "vyre"), VYRE_INSTALLER: path.join(dir, "installer.sh"), VYRE_NO_PROMPT: "1", ...env } });
  return { dir, log, run, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "") };
}

test("install: installs, then prints the QR and the long code to paste, and how to answer the question at the server; no short typed code anywhere", t => {
  const r = rig(t);
  const out = r.run();
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.includes(PAYLOAD), "the long code is printed to paste");
  assert.match(out.stdout, /Scan this with the Vyre app/);
  assert.match(out.stdout, /Pair to:/);
  assert.match(out.stdout, /wink\.server\.pairing/);
  assert.match(out.stdout, /wink\.server\.pair\.answer/);
  assert.doesNotMatch(out.stdout + out.stderr, /WINK-[0-9A-Z]{4}-[0-9A-Z]{4}|type (the|this|that) code|typed|Type the code/i, "a typed code is not mentioned");
  assert.match(r.calls(), /^installer/m, "the release installer ran");
  assert.match(r.calls(), /wink\.server\.code \{"qr":true\}/);
});

test("install: idempotent. An installed server is left alone and a code is still shown", t => {
  const r = rig(t, { installed: true });
  const out = r.run();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /already installed/);
  assert.doesNotMatch(r.calls(), /^installer/m, "nothing was installed again");
  assert.ok(out.stdout.includes(PAYLOAD));
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
  assert.match(out.stderr, /cannot be paired by a scan yet/);
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

test("install: prints the QR drawn by the box when there is no qrencode, and the long code, and no network is touched", t => {
  const r = rig(t);
  const out = r.run({ VYRE_SITE: "https://invalid.invalid" });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Scan this with the Vyre app/);
  const lines = qrLines(PAYLOAD);
  for (const l of lines) assert.ok(out.stdout.includes(`      ${l}\n`), "every row of the box's drawing is printed");
  assert.ok(lines.length > 15 && lines[0].length < 80, "it fits a terminal");
  assert.ok(out.stdout.includes(PAYLOAD), "the long code is printed beside it, to paste into the app on a computer");
});

test("install: qrencode is used when the server has it, and the box's drawing is not", t => {
  const r = rig(t, { qrencode: true });
  const out = r.run();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /FAKE-QRENCODE-ART/);
  assert.match(r.calls(), /qrencode -t ANSIUTF8 .*vyre:\/\/wink\/2\?t=AAECAwQFBgcICQoLDA0ODw/);
  assert.ok(!out.stdout.includes(qrLines(PAYLOAD)[3]));
});

test("install: --pair-to names the identity up front, is sent as pairTo, never reaches the release installer, waits for no one, and a bad value is refused", t => {
  const r = rig(t);
  const out = r.run({}, "", ["--pair-to", "Harlow Legal", "--some-installer-flag"]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(r.calls(), /wink\.server\.code \{"qr":true,"pairTo":"Harlow Legal"\}/);
  assert.match(r.calls(), /^installer --some-installer-flag$/m, "the installer got its own arguments and not ours");
  assert.doesNotMatch(r.calls(), /installer .*pair-to/);
  assert.match(out.stdout, /only pair to Harlow Legal/);
  assert.doesNotMatch(r.calls(), /wink\.server\.pairing/, "no question is polled for: nobody answers on an unattended install");
  const eq = rig(t).run({}, "", ["--pair-to=per_abc123"]);
  assert.match(eq.stdout, /only pair to per_abc123/);
  for (const bad of [["--pair-to"], ["--pair-to", 'x"y'], ["--pair-to", "a\\b"], ["--pair-to", "x".repeat(70)]]) {
    const o = rig(t).run({}, "", bad);
    assert.notEqual(o.status, 0, JSON.stringify(bad));
    assert.match(o.stderr, /--pair-to/);
  }
});

test("install: the terminal asks who is asking with the three words and takes y or n (run under a pseudo terminal)", t => {
  const py = spawnSync("python3", ["-c", "import pty"], { encoding: "utf8" });
  if (py.status !== 0) { t.skip("no python3 pty here"); return; }
  const answer = (/** @type {string} */ reply) => {
    const r = rig(t, { ask: "asks" });
    const driver = `
import os, pty, sys, select, time
pid, fd = pty.fork()
if pid == 0:
    os.environ["VYRE_NO_PROMPT"] = "0"
    os.execvp("sh", ["sh", ${JSON.stringify(SCRIPT)}])
out = b""
sent = False
end = time.time() + 20
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.5)
    if r:
        try: d = os.read(fd, 4096)
        except OSError: break
        if not d: break
        out += d
        if b"[y/N]" in out and not sent:
            os.write(fd, ${JSON.stringify(reply + "\n")}.encode()); sent = True
sys.stdout.write(out.decode("utf8", "replace"))
`;
    const run = spawnSync("python3", ["-c", driver], { encoding: "utf8", env: { PATH: `${r.dir}:${process.env.PATH}`, VYRE_WRAPPER: path.join(r.dir, "vyre"), VYRE_INSTALLER: path.join(r.dir, "installer.sh"), VYRE_ASK_TRIES: "3" } });
    return { out: run.stdout, calls: r.calls() };
  };
  const yes = answer("y");
  assert.match(yes.out, /Pair this server to Harlow Legal\? Words: amber coral seven\./);
  assert.match(yes.calls, /wink\.server\.pair\.answer \{"yes":true\}/);
  const no = answer("");
  assert.match(no.calls, /wink\.server\.pair\.answer \{"yes":false\}/, "an empty answer is no");
  assert.match(no.out, /Nothing was paired/);
});

test("install: the vendored QR encoder is the pinned file and the QR needs no download", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../relay/client/vendor");
  const pins = JSON.parse(fs.readFileSync(path.join(dir, "PINS-qr.json"), "utf8"));
  assert.equal(pins.source.licence, "MIT");
  assert.ok(fs.existsSync(path.join(dir, "LICENSE.qrcode-generator")));
  const src = fs.readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(src.split("show_qr()")[1].split("# show_code")[0], /curl|wget|fetch /, "show_qr never downloads anything");
});
