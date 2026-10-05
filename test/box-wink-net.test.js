// @ts-check
// The built-in network's two programs in the box image (core/wink/netd.js starts them): Headscale pinned with a real checksum per architecture and checked before it is
// installed, the Wink node built from the repo's own Go source in a digest-pinned stage, and no Tailscale product anywhere in the image.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docker = fs.readFileSync(path.join(REPO, "box", "Dockerfile"), "utf8");
const ci = fs.readFileSync(path.join(REPO, ".github", "workflows", "box-image.yml"), "utf8");

test("wink net: headscale is pinned with a 64-hex sum per architecture, checked before it is installed at /usr/local/bin/headscale", () => {
  assert.match(docker, /^ARG HEADSCALE_VERSION=\d+\.\d+\.\d+$/m);
  for (const arch of ["AMD64", "ARM64"]) assert.match(docker, new RegExp(`^ARG HEADSCALE_SHA256_${arch}=[0-9a-f]{64}$`, "m"));
  const run = docker.slice(docker.indexOf("ARG HEADSCALE_VERSION"));
  assert.ok(run.indexOf('sha256sum -c') > 0 && run.indexOf("sha256sum -c") < run.indexOf("install -m 0755 /tmp/headscale"), "the sum is checked first");
  assert.match(run, /install -m 0755 \/tmp\/headscale \/usr\/local\/bin\/headscale/);
});

test("wink net: the node is built from wink/forwarder in a stage pinned by digest and copied to /usr/local/bin/wink-forwarder", () => {
  assert.match(docker, /^FROM golang:\S+@sha256:[0-9a-f]{64} AS winknode$/m);
  assert.match(docker, /go build -trimpath .* -o \/out\/wink-forwarder \./);
  assert.match(docker, /^COPY --from=winknode \/out\/wink-forwarder \/usr\/local\/bin\/wink-forwarder$/m);
  assert.ok(fs.existsSync(path.join(REPO, "wink", "forwarder", "go.sum")), "the dependency is pinned by go.sum");
});

test("wink net: the image installs no Tailscale product, and CI looks for both programs", () => {
  assert.doesNotMatch(docker.split("\n").filter(l => !l.trim().startsWith("#")).join("\n"), /tailscale/i);
  assert.match(ci, /headscale version v\$want/);
  assert.match(ci, /wink-forwarder/);
});
