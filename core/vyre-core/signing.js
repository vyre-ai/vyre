// @ts-check
// vyre-core's own code-signing identity (ADR 0040 section 4). There is no Apple Developer ID, and a
// "Vyre Local" certificate in the person's login keychain is readable by a model on the same uid, so
// the Capsule is signed with an identity made here: a self-made certificate and key in a keychain
// inside a folder only ROOT can read. Only root ever signs (the installer, and the update apply
// step), so the key sits where neither the person's account nor _vyre (a network-facing service
// account) can use it. The Capsule's Secure Enclave key binds to the signature's designated
// requirement, which names THIS certificate, so a swapped or patched Capsule fails it.
//
// Only a Capsule.app taken from a release whose signature has just been verified is ever signed.
// Every command goes through an injected `run(cmd, args)` (installer.js's Run), so tests record them
// and the macOS runner proof runs them for real.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const IDENTITY = "Vyre Core Capsule";
export const CAPSULE_ID = "run.vyre.capsule";
const OPENSSL = "/usr/bin/openssl";
const SECURITY = "/usr/bin/security";
const CODESIGN = "/usr/bin/codesign";
const SYSTEM_KEYCHAIN = "/Library/Keychains/System.keychain";

/** @typedef {(cmd: string, args: string[], o?: { input?: string }) => string} Run */

/**
 * Make the identity if it is not there. Idempotent: a folder that already holds one is left alone.
 * @param {{ dir: string, run: Run, systemKeychain?: string }} o dir: root:wheel 0700
 * @returns {{ sha1: string, keychain: string, created: boolean }}
 */
export function ensureIdentity({ dir, run, systemKeychain = SYSTEM_KEYCHAIN }) {
  const meta = path.join(dir, "identity.json");
  try {
    const j = JSON.parse(fs.readFileSync(meta, "utf8"));
    if (typeof j.sha1 === "string" && fs.existsSync(j.keychain)) return { sha1: j.sha1, keychain: j.keychain, created: false };
  } catch { /* none yet */ }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmp = fs.mkdtempSync(path.join(dir, ".make-"));
  fs.chmodSync(tmp, 0o700);
  const keychain = path.join(dir, "vyre-core.keychain-db");
  const pw = crypto.randomBytes(24).toString("base64url");
  const key = path.join(tmp, "key.pem"), cert = path.join(tmp, "cert.pem"), p12 = path.join(tmp, "id.p12"), cnf = path.join(tmp, "req.cnf");
  fs.writeFileSync(cnf, `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=${IDENTITY}\n[v3]\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\nbasicConstraints=critical,CA:false\n`, { mode: 0o600 });
  try {
    run(OPENSSL, ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "3650", "-nodes", "-keyout", key, "-out", cert, "-config", cnf]);
    run(OPENSSL, ["pkcs12", "-export", "-inkey", key, "-in", cert, "-out", p12, "-name", IDENTITY, "-passout", `pass:${pw}`]);
    fs.rmSync(keychain, { force: true });
    run(SECURITY, ["create-keychain", "-p", pw, keychain]);
    run(SECURITY, ["set-keychain-settings", keychain]); // no auto-lock, no timeout
    run(SECURITY, ["unlock-keychain", "-p", pw, keychain]);
    run(SECURITY, ["import", p12, "-k", keychain, "-P", pw, "-T", CODESIGN]);
    // Without this, codesign asks for the keychain password on a GUI prompt nobody is there to answer.
    run(SECURITY, ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", pw, keychain]);
    // Trusted for code signing only, in the system domain (root can, with no prompt).
    run(SECURITY, ["add-trusted-cert", "-d", "-r", "trustRoot", "-p", "codeSign", "-k", systemKeychain, cert]);
    const fp = run(OPENSSL, ["x509", "-in", cert, "-noout", "-fingerprint", "-sha1"]);
    const sha1 = ((fp.match(/=([0-9A-Fa-f:]{59})/) || [])[1] || "").replace(/:/g, "").toUpperCase();
    if (!/^[0-9A-F]{40}$/.test(sha1)) throw new Error("could not read the signing certificate's fingerprint");
    fs.writeFileSync(path.join(dir, "pw"), pw + "\n", { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "cert.pem"), fs.readFileSync(cert), { mode: 0o600 });
    fs.writeFileSync(meta, JSON.stringify({ sha1, keychain, identity: IDENTITY, created: new Date().toISOString() }) + "\n", { mode: 0o600 });
    return { sha1, keychain, created: true };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Sign the Capsule.app at `app` with the identity, then check it. Returns the designated requirement
 * (what the Capsule's keychain ACL and core's pin bind to) and the cdhash.
 * @param {{ app: string, dir: string, run: Run }} o
 * @returns {{ requirement: string, cdhash: string, sha1: string }}
 */
export function signApp({ app, dir, run }) {
  const { sha1, keychain } = ensureIdentity({ dir, run });
  const pw = fs.readFileSync(path.join(dir, "pw"), "utf8").trim();
  run(SECURITY, ["unlock-keychain", "-p", pw, keychain]);
  run(CODESIGN, ["--force", "--deep", "--keychain", keychain, "--sign", sha1, "--identifier", CAPSULE_ID, "--timestamp=none", app]);
  run(CODESIGN, ["--verify", "--strict", "--deep", app]);
  const req = run(CODESIGN, ["-d", "-r-", app]);
  const requirement = (String(req).match(/designated => (.*)/) || [])[1] || "";
  const info = run(CODESIGN, ["-dvvv", app]);
  const cdhash = (String(info).match(/CDHash=([0-9a-f]+)/) || [])[1] || "";
  return { requirement, cdhash, sha1 };
}

/**
 * Remove the identity: the system trust for its certificate and the folder with the key.
 * @param {{ dir: string, run: Run }} o
 */
export function removeIdentity({ dir, run }) {
  const cert = path.join(dir, "cert.pem");
  if (fs.existsSync(cert)) { try { run(SECURITY, ["remove-trusted-cert", "-d", cert]); } catch { /* not trusted, or already gone */ } }
  fs.rmSync(dir, { recursive: true, force: true });
}
