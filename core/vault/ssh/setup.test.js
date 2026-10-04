// @ts-check
// ssh setup: the lines a person is shown, the allowed-signers line added once, and which files in
// a folder are private keys. The key text here is a made-up sample.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupPlan, addAllowedSigner, findPrivateKeys } from "../../../lib/vault-ssh-setup/setup.js";
import { SCRATCH } from "../../../test/scratch.mjs";

// Private-key PEM headers are assembled here, so no key-shaped header sits whole in the source.
const pemBegin = (kind = "") => ["-----BEGIN", `${kind}PRIVATE KEY-----`].join(" ");

const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHarlowLegalSampleKeyForTestsOnly00000000000 alex@harlow.test";

test("ssh setup: IdentityAgent, SSH_AUTH_SOCK, git signing through the agent, allowed signers", () => {
  const p = setupPlan({ socket: "/home/alex/.vyre/ssh/agent.sock", pub: PUB, email: "alex@harlow.test", allowedSigners: "/home/alex/.config/git/allowed_signers" });
  assert.deepEqual(p.ssh, ["Host *", '  IdentityAgent "/home/alex/.vyre/ssh/agent.sock"']);
  assert.deepEqual(p.shell, ['export SSH_AUTH_SOCK="/home/alex/.vyre/ssh/agent.sock"']);
  assert.deepEqual(p.git[1], ["config", "--global", "user.signingkey", `key::${PUB.split(" ").slice(0, 2).join(" ")}`]);
  assert.equal(p.allowed, `alex@harlow.test namespaces="git" ${PUB.split(" ").slice(0, 2).join(" ")}`);
  assert.equal(setupPlan({ socket: "s", pub: PUB, allowedSigners: "f" }).allowed, null);

  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-ssh-setup-"));
  try {
    const f = path.join(dir, "git", "allowed_signers");
    assert.equal(addAllowedSigner(f, p.allowed), true);
    assert.equal(addAllowedSigner(f, p.allowed), false, "not twice");
    assert.equal(fs.readFileSync(f, "utf8"), p.allowed + "\n");
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("ssh import: private keys only, by their first line, with item names", () => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-ssh-dir-"));
  try {
    const w = (n, s) => fs.writeFileSync(path.join(dir, n), s);
    w("id_ed25519", pemBegin("OPENSSH ") + "\nsample\n-----END OPENSSH PRIVATE KEY-----\n");
    w("id_ed25519.pub", PUB + "\n");
    w("northwind deploy", pemBegin("RSA ") + "\nsample\n");
    w("known_hosts", "github.test ssh-ed25519 AAAA\n");
    w("config", "Host *\n");
    w("id_ed25519-cert.pub", "ssh-ed25519-cert-v01@openssh.com AAAA\n");
    w("notes.txt", "hello\n");
    fs.symlinkSync(path.join(dir, "id_ed25519"), path.join(dir, "linked"));
    assert.deepEqual(findPrivateKeys(dir).map(k => [path.basename(k.file), k.name]), [["id_ed25519", "ssh-id_ed25519"], ["northwind deploy", "ssh-northwind-deploy"]]);
    assert.deepEqual(findPrivateKeys(path.join(dir, "missing")), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
