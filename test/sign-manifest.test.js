// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { signRelease } from "../scripts/sign-manifest.mjs";
import { verifySums, checkManifest } from "../core/vyre-core/release.js";

const setup = (/** @type {import("node:test").TestContext} */ t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-sign-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, "vyre.tgz"), "release bytes");
  fs.writeFileSync(path.join(d, "install-box.sh"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(d, "notes.md"), "notes are not an asset");
  fs.writeFileSync(path.join(d, "SHA256SUMS"), "stale");
  const kp = crypto.generateKeyPairSync("ed25519");
  return { d, pem: kp.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), pub: kp.publicKey.export({ type: "spki", format: "der" }).toString("base64") };
};
const sha = (/** @type {string} */ s) => crypto.createHash("sha256").update(s).digest("hex");

test("sign-manifest: one signature over SHA256SUMS, which lists every asset and the manifest; the manifest names the tarball's hash", t => {
  const s = setup(t);
  const { lines } = signRelease({ dir: s.d, version: "0.2.0", channel: "stable", pem: s.pem, key: s.pub });
  const sums = fs.readFileSync(path.join(s.d, "SHA256SUMS"));
  const listed = verifySums(sums, fs.readFileSync(path.join(s.d, "SHA256SUMS.sig")), { key: s.pub });
  assert.equal(lines, 3);
  assert.deepEqual([...listed.keys()].sort(), ["install-box.sh", "manifest.json", "vyre.tgz"], "not notes.md, not itself, not its signature");
  assert.equal(listed.get("vyre.tgz"), sha("release bytes"));
  assert.equal(listed.get("manifest.json"), crypto.createHash("sha256").update(fs.readFileSync(path.join(s.d, "manifest.json"))).digest("hex"));
  const m = checkManifest(fs.readFileSync(path.join(s.d, "manifest.json")));
  assert.deepEqual([m.version, m.tarball, m.sha256, m.channel], ["0.2.0", "vyre.tgz", sha("release bytes"), "stable"]);
  assert.match(sums.toString(), /^[0-9a-f]{64}  install-box\.sh\n/, "the format `sha256sum -c` reads");
});

test("sign-manifest: a secret that is not the pinned key's writes no signature and leaves SHA256SUMS as it was", t => {
  const s = setup(t);
  assert.throws(() => signRelease({ dir: s.d, version: "0.2.0", pem: s.pem }), /does not verify/);
  assert.ok(!fs.existsSync(path.join(s.d, "SHA256SUMS.sig")));
  assert.equal(fs.readFileSync(path.join(s.d, "SHA256SUMS"), "utf8"), "stale");
});
