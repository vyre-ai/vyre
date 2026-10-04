// @ts-check
// The pure-JS APK signer: a tiny aligned zip, signed with EC P-256 and with RSA, then (a) every
// v2/v3 structure parsed back and checked with node:crypto by a verifier that shares no code with
// the signer, and (b) apksigner's own verdict when this machine has one (skipped otherwise).

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../test/helpers.js";
import { sign, misaligned, certSha256, V3_MIN_SDK, V3_MAX_SDK, STRIPPING_PROTECTION_ID } from "./apk-sign.js";
import { selfSigned, toPem } from "./x509.js";
import { storedZip, verifyApk } from "./testing.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** An unsigned APK-shaped zip: a manifest, an odd-length name, and one entry over 1 MiB so the digest spans chunks. */
const fixture = (align = true) => storedZip([
  { name: "AndroidManifest.xml", data: Buffer.from("<manifest package=\"sh.vyre.app\"/>") },
  { name: "res/raw/harlow-legal.txt", data: Buffer.from("Harlow Legal and Northwind Bakery, sample data") },
  { name: "assets/big.bin", data: crypto.randomBytes(1536 * 1024) },
  { name: "classes.dex", data: Buffer.from("dex\n035\0kit") },
], { align });

function signer(type) {
  const pair = type === "rsa" ? crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }) : crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const key = /** @type {string} */ (pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  const cert = toPem(selfSigned({ privateKey: pair.privateKey, cn: "Vyre test-box" }));
  return { key, cert };
}

/** apksigner and a Java 17 to run it, if this machine has both. */
function apksigner() {
  const candidates = [];
  for (const d of (process.env.PATH || "").split(":")) candidates.push(path.join(d, "apksigner"));
  const tools = "/opt/homebrew/share/android-commandlinetools/build-tools";
  try { for (const v of fs.readdirSync(tools).sort().reverse()) candidates.push(path.join(tools, v, "apksigner")); } catch {}
  const bin = candidates.find(c => { try { return fs.statSync(c).isFile(); } catch { return false; } });
  if (!bin) return null;
  let java = process.env.JAVA_HOME || "";
  if (!java) { try { java = execFileSync("/usr/libexec/java_home", ["-v", "17"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {} }
  if (!java && fs.existsSync("/opt/homebrew/opt/openjdk@17/bin/java")) java = "/opt/homebrew/opt/openjdk@17";
  if (!java) return null;
  return { bin, env: { ...process.env, JAVA_HOME: java, PATH: `${path.join(java, "bin")}:${process.env.PATH}` } };
}
const APKSIGNER = apksigner();

for (const type of ["ec", "rsa"]) {
  test(`v2 and v3 signatures (${type}) verify, digest and all`, t => {
    const s = signer(type);
    const unsigned = fixture();
    assert.deepEqual(misaligned(unsigned), []);
    const apk = sign(unsigned, s);
    const v = verifyApk(apk);
    assert.equal(v.chunks, 4, "the entries span two chunks (one entry is 1.5 MiB), then one each for the CD and the EOCD");
    for (const k of ["v2", "v3"]) {
      assert.equal(v[k].alg, type === "ec" ? 0x0201 : 0x0103);
      assert.equal(v[k].cert.subject, "CN=Vyre test-box");
      assert.ok(v[k].cert.verify(v[k].cert.publicKey), "the certificate is self-signed");
      assert.equal(crypto.createHash("sha256").update(v[k].certDer).digest("hex"), certSha256(s.cert));
    }
    assert.deepEqual([v.v3.minSdk, v.v3.maxSdk], [V3_MIN_SDK, V3_MAX_SDK]);
    assert.deepEqual(v.v2.attrs.map(a => [a.id, a.value.readUInt32LE(0)]), [[STRIPPING_PROTECTION_ID, 3]], "v2 says v3 was there too");
    // The entries and central directory are untouched; only the EOCD's offset moved.
    const cd = unsigned.readUInt32LE(unsigned.length - 22 + 16);
    assert.ok(apk.subarray(0, cd).equals(unsigned.subarray(0, cd)));
    assert.ok(apk.subarray(apk.length - (unsigned.length - cd)).subarray(0, -22).equals(unsigned.subarray(cd, -22)));

    // A flipped byte in an entry breaks the digest.
    const bad = Buffer.from(apk); bad[100] ^= 1;
    assert.throws(() => verifyApk(bad), /content digest/);
  });

  test(`apksigner verifies the ${type} signature`, { skip: APKSIGNER ? false : "no apksigner with a Java 17 on this machine" }, t => {
    const dir = tempHome(t);
    const file = path.join(dir, "signed.apk");
    fs.writeFileSync(file, sign(fixture(), signer(type)));
    const r = spawnSync(/** @type {any} */ (APKSIGNER).bin, ["verify", "--verbose", "--min-sdk-version", "24", file], { encoding: "utf8", env: /** @type {any} */ (APKSIGNER).env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Verified using v2 scheme \(APK Signature Scheme v2\): true/);
    assert.match(r.stdout, /Verified using v3 scheme \(APK Signature Scheme v3\): true/);
  });
}

test("refuses what it cannot sign safely", () => {
  const s = signer("ec");
  assert.ok(misaligned(fixture(false)).length > 0);
  assert.throws(() => sign(fixture(false), s), /not zip-aligned/);
  assert.throws(() => sign(sign(fixture(), s), s), /already signed/);
  assert.throws(() => sign(fixture(), { key: s.key, cert: signer("ec").cert }), /not for this key/);
  assert.throws(() => sign(Buffer.from("not a zip at all, from juno"), s), /not a ZIP/);
  const p384 = crypto.generateKeyPairSync("ec", { namedCurve: "P-384" }).privateKey;
  assert.throws(() => selfSigned({ privateKey: p384, cn: "Vyre x" }), /must be P-256/);
});

test("a certificate valid past 2049 uses GeneralizedTime and still parses", () => {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const cert = new crypto.X509Certificate(selfSigned({ privateKey, cn: "Vyre alex", now: new Date("2026-09-27T00:00:00Z") }));
  assert.equal(new Date(cert.validTo).getUTCFullYear(), 2051);
  assert.equal(new Date(cert.validFrom).getUTCFullYear(), 2026);
  assert.ok(cert.verify(cert.publicKey));
  assert.ok(!cert.ca);
});

test("the CI wrapper signs from PEM files", t => {
  const dir = tempHome(t);
  const s = signer("ec");
  const f = n => path.join(dir, n);
  fs.writeFileSync(f("k.pem"), s.key); fs.writeFileSync(f("c.pem"), s.cert); fs.writeFileSync(f("unsigned.apk"), fixture());
  const out = JSON.parse(execFileSync(process.execPath, [path.join(HERE, "sign-apk.mjs"), "--key", f("k.pem"), "--cert", f("c.pem"), "--in", f("unsigned.apk"), "--out", f("signed.apk")], { encoding: "utf8" }));
  const apk = fs.readFileSync(f("signed.apk"));
  assert.equal(out.sha256, crypto.createHash("sha256").update(apk).digest("hex"));
  assert.equal(out.size, apk.length);
  assert.equal(out.cert_sha256, certSha256(s.cert));
  verifyApk(apk);
  const r = spawnSync(process.execPath, [path.join(HERE, "sign-apk.mjs"), "--in", f("unsigned.apk")], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--key is required/);
});
