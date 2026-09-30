// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { signManifest } from "../scripts/sign-manifest.mjs";
import { verifyManifest } from "../core/vyre-core/release.js";

const setup = (/** @type {import("node:test").TestContext} */ t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-sign-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, "vyre.tgz"), "release bytes");
  const kp = crypto.generateKeyPairSync("ed25519");
  return { d, pem: kp.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), pub: kp.publicKey.export({ type: "spki", format: "der" }).toString("base64") };
};

test("sign-manifest: writes a manifest and signature the installer's verifier accepts, hash of the tarball inside", t => {
  const s = setup(t);
  signManifest({ tarball: path.join(s.d, "vyre.tgz"), outDir: s.d, version: "0.2.0", channel: "stable", pem: s.pem, key: s.pub });
  const m = verifyManifest(fs.readFileSync(path.join(s.d, "manifest.json")), fs.readFileSync(path.join(s.d, "manifest.sig")), { key: s.pub });
  assert.equal(m.version, "0.2.0");
  assert.equal(m.tarball, "vyre.tgz");
  assert.equal(m.sha256, crypto.createHash("sha256").update("release bytes").digest("hex"));
});

test("sign-manifest: a secret that is not the pinned key's writes nothing", t => {
  const s = setup(t);
  assert.throws(() => signManifest({ tarball: path.join(s.d, "vyre.tgz"), outDir: s.d, version: "0.2.0", pem: s.pem }), /signature does not verify/);
  assert.ok(!fs.existsSync(path.join(s.d, "manifest.json")) && !fs.existsSync(path.join(s.d, "manifest.sig")));
});
