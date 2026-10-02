// @ts-check
// The Mac app's sudo helper runs only the installer's one root step (scripts/mac-app/make-pins.sh, vyre-sudo-check). The pins are
// made from scripts/install-mac-server.sh at build time; this test makes them the same way and then feeds the check the exact
// arguments the installer passes to $SUDO, built by the shell from the installer's own literals, so a change to the root step in
// the installer without a rebuild of the pins fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(REPO, "scripts", "install-mac-server.sh");
const SHASUM = fs.existsSync("/usr/bin/shasum");

/** Run the shell on the installer's own assignments (the pins, VERIFY_JS and ROOT_SH) and then `body`. */
function withLiterals(body, env = {}) {
  const src = fs.readFileSync(INSTALLER, "utf8").split("\n");
  const take = name => {
    const start = src.findIndex(l => l.startsWith(name + "='"));
    let end = start;
    while (!(src[end].endsWith("'") && !src[end].endsWith("'\"'\"'") && (end > start || src[end].length > name.length + 2))) end++;
    return src.slice(start, end + 1).join("\n");
  };
  const pins = src.filter(l => /^(NODE_SHA256_ARM64|NODE_SHA256_X64|RELEASE_KEY)=/.test(l)).join("\n");
  const script = `${pins}\n${take("VERIFY_JS")}\n${take("ROOT_SH")}\n${body}`;
  return spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: HOME_DIR, ...env } });
}

function pinned(arch) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vyre-pins-")), "vyre-sudo-check");
  const r = spawnSync("sh", [path.join(REPO, "scripts", "mac-app", "make-pins.sh"), arch, out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return out;
}

const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-home-"));
const OWNER = '--owner-uid "$(id -u)" --owner-name "$(id -un)" --owner-home "$HOME" --vyred-wrapper "$HOME/.vyre-server/bin/vyre-serve"';
const ARGS = (node = '"$NODE_SHA256_ARM64"', verb = "install", key = '"$RELEASE_KEY"', root = '"$ROOT_SH"', owner = OWNER) =>
  `/bin/sh -c ${root} vyre-root ${node} /tmp/r /tmp/n.tgz ${key} "$VERIFY_JS" ${verb} ${owner}`;

test("the check passes the installer's real root step, for each architecture", { skip: !SHASUM }, () => {
  for (const [arch, pin] of [["aarch64", "NODE_SHA256_ARM64"], ["x86_64", "NODE_SHA256_X64"]]) {
    const check = pinned(arch);
    const r = withLiterals(`${check} ${ARGS(`"$${pin}"`)}`);
    assert.equal(r.status, 0, `${arch}: ${r.stderr}`);
  }
});

test("the check accepts the optional flags the installer adds", { skip: !SHASUM }, () => {
  const check = pinned("aarch64");
  const r = withLiterals(`${check} ${ARGS(undefined, undefined, undefined, undefined, OWNER + ' --gh-bin /opt/homebrew/bin/gh --colima-program a --colima-program b')}`);
  assert.equal(r.status, 0, r.stderr);
});

test("the check refuses another script, another checksum, another key, another verb, and any other command", { skip: !SHASUM }, () => {
  const check = pinned("aarch64");
  const bad = [
    ["a different root script", ARGS(undefined, undefined, undefined, `"$ROOT_SH; touch /tmp/pwn"`)],
    ["the other architecture's Node checksum", ARGS('"$NODE_SHA256_X64"')],
    ["another Node checksum", ARGS("0000")],
    ["another release key", ARGS(undefined, undefined, "AAAA")],
    ["another verb", ARGS(undefined, "uninstall")],
    ["another owner uid", ARGS(undefined, undefined, undefined, undefined, '--owner-uid 0 --owner-name root --owner-home "$HOME" --vyred-wrapper "$HOME/w"')],
    ["another owner name", ARGS(undefined, undefined, undefined, undefined, '--owner-uid "$(id -u)" --owner-name root --owner-home "$HOME" --vyred-wrapper "$HOME/w"')],
    ["another owner home", ARGS(undefined, undefined, undefined, undefined, '--owner-uid "$(id -u)" --owner-name "$(id -un)" --owner-home /var/root --vyred-wrapper /var/root/w')],
    ["a wrapper outside the home", ARGS(undefined, undefined, undefined, undefined, '--owner-uid "$(id -u)" --owner-name "$(id -un)" --owner-home "$HOME" --vyred-wrapper /tmp/evil')],
    ["a wrapper that climbs out of the home", ARGS(undefined, undefined, undefined, undefined, '--owner-uid "$(id -u)" --owner-name "$(id -un)" --owner-home "$HOME" --vyred-wrapper "$HOME/../../tmp/evil"')],
    ["an unknown flag", ARGS(undefined, undefined, undefined, undefined, OWNER + " --evil x")],
    ["a flag with no value", ARGS(undefined, undefined, undefined, undefined, OWNER + " --gh-bin")],
    ["a plain command", "/bin/rm -rf /tmp/x"],
    ["sh with a script file", `/bin/sh /tmp/evil.sh a b c d e f g h i j`],
  ];
  for (const [what, args] of bad) {
    const r = withLiterals(`${check} ${args}`);
    assert.equal(r.status, 126, `${what} is refused: ${r.stderr}`);
    assert.match(r.stderr, /refused/);
  }
});
