// @ts-check
// The DigitalOcean image's first-boot installer (packaging/digitalocean/files/vyre-firstboot): it installs the
// latest release only after the signature and every file's hash check out. A fake release site on disk, signed
// with a THROWAWAY key, and a stub installer; no network, no Docker, nothing started. It needs OpenSSL 3 (Ed25519
// raw verify) and sha256sum, as the Ubuntu image has, so it skips elsewhere (a Mac's LibreSSL).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(REPO, "packaging", "digitalocean", "files", "vyre-firstboot");
const have = (/** @type {string[]} */ cmd) => spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
const ssl = have(["openssl", "version"]);
const SKIP = !/OpenSSL 3\./.test(ssl.stdout || "") || have(["sha256sum", "--version"]).status !== 0 ? "needs OpenSSL 3 and sha256sum (the Ubuntu image has them)" : false;

const sha = (/** @type {string | Buffer} */ b) => crypto.createHash("sha256").update(b).digest("hex");
const FILES = { "install-box.sh": "#!/bin/sh\necho installer-ran >>\"$STUB_LOG\"\necho \"base=$VYRE_BOX_URL args=$*\" >>\"$STUB_LOG\"\n", vyre: "#!/bin/sh\n", "compose.yml": "services: {}\n", "vyre.env.example": "A=1\n", VERSION: "0.2.2\n" };

/** A signed release site in a temp folder. */
function site(/** @type {import("node:test").TestContext} */ t, /** @type {{ sign?: crypto.KeyObject, tamper?: string, drop?: string }} */ o = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-do-test-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const web = path.join(d, "web"); fs.mkdirSync(web);
  const kp = crypto.generateKeyPairSync("ed25519");
  /** @type {Record<string, string>} */ const files = { ...FILES };
  if (o.drop) delete files[o.drop];
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(web, n), c);
  const sums = Buffer.from(Object.entries(files).map(([n, c]) => `${sha(c)}  ${n}`).join("\n") + "\n");
  fs.writeFileSync(path.join(web, "SHA256SUMS"), sums);
  fs.writeFileSync(path.join(web, "SHA256SUMS.sig"), crypto.sign(null, Buffer.concat([Buffer.from("vyre-release-sums\n"), sums]), o.sign || kp.privateKey).toString("base64") + "\n");
  if (o.tamper) fs.writeFileSync(path.join(web, o.tamper), "tampered after signing\n");
  const pem = path.join(d, "key.pem");
  fs.writeFileSync(pem, kp.publicKey.export({ type: "spki", format: "pem" }));
  const state = path.join(d, "state"), log = path.join(d, "stub.log");
  const run = () => spawnSync("sh", [SCRIPT], { encoding: "utf8", timeout: 60_000, env: {
    PATH: process.env.PATH || "", VYRE_BOX_URL: `file://${web}/`, VYRE_RELEASE_KEY_PEM: pem, VYRE_STATE_DIR: state,
    VYRE_FIRSTBOOT_RETRIES: "1", VYRE_FIRSTBOOT_WAIT: "0", STUB_LOG: log } });
  const status = () => (fs.existsSync(path.join(state, "firstboot.status")) ? fs.readFileSync(path.join(state, "firstboot.status"), "utf8").trim() : "");
  const ran = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");
  return { run, status, ran, state, web };
}

test("firstboot: a release signed by the Vyre key installs, from checked copies read off disk", { skip: SKIP }, t => {
  const s = site(t);
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(s.status(), /^ok 0\.2\.2$/);
  assert.match(s.ran(), /installer-ran/);
  assert.match(s.ran(), new RegExp(`base=file://${s.state}/release/ args=--yes`), "the installer reads the checked copies, not the network");
  assert.ok(fs.existsSync(path.join(s.state, "release", "compose.yml")));
});

test("firstboot: SHA256SUMS signed by another key installs nothing", { skip: SKIP }, t => {
  const other = crypto.generateKeyPairSync("ed25519");
  const s = site(t, { sign: other.privateKey });
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.match(s.status(), /^failed: the release signature does not verify/);
  assert.equal(s.ran(), "", "the installer never ran");
});

test("firstboot: a file changed after signing installs nothing", { skip: SKIP }, t => {
  const s = site(t, { tamper: "install-box.sh" });
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.match(s.status(), /install-box\.sh does not match the signed release/);
  assert.equal(s.ran(), "");
});

test("firstboot: a release without install-box.sh installs nothing, and says why", { skip: SKIP }, t => {
  const s = site(t, { drop: "install-box.sh" });
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.match(s.status(), /lists no install-box\.sh/);
  assert.equal(s.ran(), "");
});

test("firstboot: an unreachable site stops with a plain message after its tries", { skip: SKIP }, t => {
  const s = site(t);
  fs.rmSync(path.join(s.web, "SHA256SUMS.sig"));
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.match(s.status(), /could not reach .* after 1 tries.*sudo vyre-firstboot/);
});

test("firstboot: the key baked into the image is the release key pinned in release.js, and no secret is stored", () => {
  const baked = fs.readFileSync(path.join(REPO, "packaging", "digitalocean", "files", "release-key.pem"), "utf8").split("\n").filter(l => l && !l.startsWith("-----")).join("");
  const pinned = /export const RELEASE_KEY = "([^"]+)"/.exec(fs.readFileSync(path.join(REPO, "core", "vyre-core", "release.js"), "utf8"))?.[1];
  assert.equal(baked, pinned);
  const text = fs.readFileSync(SCRIPT, "utf8");
  assert.ok(!/password|passwd|VYRE_CODE|VYRE_SETUP_CODE/i.test(text.replace(/Nothing in this script asks for or stores a password[^\n]*\n/, "")), "no code or password is handled by the first boot");
});

test("firstboot: --stage-only checks and stages a release without installing; --from-baked installs it offline and re-checks it", { skip: SKIP }, t => {
  const s = site(t);
  const env = (/** @type {string[]} */ a, /** @type {string} */ web) => spawnSync("sh", [SCRIPT, ...a], { encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH || "", VYRE_BOX_URL: `file://${web}/`, VYRE_RELEASE_KEY_PEM: path.join(path.dirname(s.web), "key.pem"), VYRE_STATE_DIR: s.state, VYRE_FIRSTBOOT_RETRIES: "1", VYRE_FIRSTBOOT_WAIT: "0", STUB_LOG: path.join(path.dirname(s.web), "stub.log") } });
  const a = env(["--stage-only"], s.web);
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.match(s.status(), /^staged 0\.2\.2$/);
  assert.equal(s.ran(), "", "staging installs nothing");
  assert.ok(fs.existsSync(path.join(s.state, "release", "SHA256SUMS.sig")), "the signature is kept for the offline re-check");
  // The network is gone: the baked release installs from disk.
  const b = env(["--from-baked"], "/nonexistent");
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.match(s.status(), /^ok 0\.2\.2$/);
  assert.match(s.ran(), /installer-ran/);
  // A baked file changed after the build is caught by the re-check, and nothing runs.
  fs.rmSync(path.join(path.dirname(s.web), "stub.log"));
  fs.writeFileSync(path.join(s.state, "release", "compose.yml"), "services: {tampered: {}}\n");
  const c = env(["--from-baked"], "/nonexistent");
  assert.notEqual(c.status, 0);
  assert.match(s.status(), /compose\.yml does not match the signed release/);
  assert.equal(s.ran(), "");
  // No baked release: it says so instead of reaching for the network.
  fs.rmSync(path.join(s.state, "release"), { recursive: true });
  assert.notEqual(env(["--from-baked"], "/nonexistent").status, 0);
  assert.match(s.status(), /no baked release in this image/);
});
