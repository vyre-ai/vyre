// @ts-check
// The GitHub CLI Vyre signs in with: the box image and the Mac installer pin the same version, and each pin carries a real checksum.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docker = fs.readFileSync(path.join(REPO, "box", "Dockerfile"), "utf8");
const mac = fs.readFileSync(path.join(REPO, "scripts", "install-mac-server.sh"), "utf8");
const ci = fs.readFileSync(path.join(REPO, ".github", "workflows", "box-image.yml"), "utf8");

test("gh: the box image and the Mac installer pin the same version, with a 64-hex checksum per architecture", () => {
  const dv = /^ARG GH_VERSION=(\S+)$/m.exec(docker)?.[1];
  const mv = /^GH_VERSION=(\S+)$/m.exec(mac)?.[1];
  assert.ok(dv && /^\d+\.\d+\.\d+$/.test(dv), "the image pins a version");
  assert.equal(dv, mv, "one version in both places");
  for (const arch of ["AMD64", "ARM64"]) {
    assert.match(docker, new RegExp(`^ARG GH_SHA256_${arch}=[0-9a-f]{64}$`, "m"), `the image pins the ${arch} archive's sum`);
    assert.match(mac, new RegExp(`^GH_SHA256_${arch}=[0-9a-f]{64}$`, "m"), `the Mac installer pins the ${arch} zip's sum`);
  }
});

test("gh: the image checks the archive against its sum before unpacking it, installs it at /usr/local/bin/gh, and CI runs gh --version", () => {
  const run = docker.slice(docker.indexOf("ARG GH_VERSION"));
  assert.ok(run.indexOf("sha256sum -c") > 0 && run.indexOf("sha256sum -c") < run.indexOf("tar -xzf /tmp/gh.tgz"), "the sum is checked first");
  assert.match(run, /install -m 0755 .*\/usr\/local\/bin\/gh/);
  assert.match(ci, /docker run --rm --entrypoint gh "\$IMAGE" --version/);
});

test("gh: the Mac installer never installs it with Homebrew, and downloads only a pinned, checked archive", () => {
  const fn = mac.slice(mac.indexOf("setup_gh() {"), mac.indexOf("# write_env:"));
  assert.ok(!/brew install/.test(fn));
  assert.match(fn, /does not match its pinned checksum/);
});
