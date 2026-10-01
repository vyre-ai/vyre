// @ts-check
// vyre-core's own code-signing identity (ADR 0040 section 4). There is no Apple Developer ID, and a
// "Vyre Local" certificate in the person's login keychain is readable by a model on the same uid, so
// the Capsule is signed with an identity made here: a self-made certificate and key in a keychain
// inside a folder only ROOT can read. Only root ever signs (the installer, and the update apply
// step), so the key sits where neither the person's account nor _vyre (a network-facing service
// account) can use it. The Capsule's Secure Enclave key binds to the signature's designated
// requirement, which names THIS certificate, so a swapped or patched Capsule fails it.
//
// Only a Vyre.app (the Capsule) taken from a release whose signature has just been verified is ever signed.
// Every command goes through an injected `run(cmd, args)` (installer.js's Run), so tests record them
// and the macOS runner proof runs them for real.

import fs from "node:fs";
import path from "node:path";

export const IDENTITY = "Vyre Core Capsule";
export const CAPSULE_ID = "sh.vyre.capsule"; // the Capsule's bundle id (local/capsule/native/build.sh)
export const CAPSULE_APP = "Vyre.app"; // the product name; the binary is Contents/MacOS/Vyre
/** The p12 is a scratch file that exists for moments inside root's 0700 folder; this is not a secret. */
const P12_PASS = "vyre-scratch";
const OPENSSL = "/usr/bin/openssl";
const SECURITY = "/usr/bin/security";
const CODESIGN = "/usr/bin/codesign";
const SYSTEM_KEYCHAIN = "/Library/Keychains/System.keychain";

/** @typedef {(cmd: string, args: string[], o?: { input?: string, timeout?: number }) => string} Run */

/**
 * Make the identity if it is not there. Idempotent: a folder that already holds one is left alone.
 * @param {{ dir: string, run: Run, systemKeychain?: string }} o dir: root:wheel 0700
 * @returns {{ sha1: string, keychain: string, created: boolean }}
 */
export function ensureIdentity({ dir, run, systemKeychain = SYSTEM_KEYCHAIN }) {
  const meta = path.join(dir, "identity.json");
  retryPending({ dir, run, systemKeychain });
  try {
    const j = JSON.parse(fs.readFileSync(meta, "utf8"));
    if (typeof j.sha1 === "string" && fs.existsSync(j.keychain)) return { sha1: j.sha1, keychain: j.keychain, created: false };
  } catch { /* none yet */ }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmp = fs.mkdtempSync(path.join(dir, ".make-"));
  fs.chmodSync(tmp, 0o700);
  const keychain = path.join(dir, "vyre-core.keychain-db");
  // No secret ever goes in an argument: a password in argv shows in `ps`. The keychain carries an EMPTY
  // password, and the protection is the folder (root:wheel 0700), which is also where a password file would
  // have had to live. (`security import` refuses a p12 with an empty password, so the p12 carries a fixed,
  // public one: the file lives for milliseconds in the 0700 scratch folder and is deleted, so the password
  // protects nothing and hides nothing.)
  const pw = "";
  const key = path.join(tmp, "key.pem"), cert = path.join(tmp, "cert.pem"), p12 = path.join(tmp, "id.p12"), cnf = path.join(tmp, "req.cnf");
  fs.writeFileSync(cnf, `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=${IDENTITY}\n[v3]\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\nbasicConstraints=critical,CA:false\n`, { mode: 0o600 });
  try {
    run(OPENSSL, ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "3650", "-nodes", "-keyout", key, "-out", cert, "-config", cnf]);
    run(OPENSSL, ["pkcs12", "-export", "-inkey", key, "-in", cert, "-out", p12, "-name", IDENTITY, "-passout", `pass:${P12_PASS}`]);
    fs.rmSync(keychain, { force: true });
    run(SECURITY, ["create-keychain", "-p", pw, keychain]);
    run(SECURITY, ["set-keychain-settings", keychain]); // no auto-lock, no timeout
    run(SECURITY, ["unlock-keychain", "-p", pw, keychain]);
    run(SECURITY, ["import", p12, "-k", keychain, "-P", P12_PASS, "-T", CODESIGN]);
    // Without this, codesign asks for the keychain password on a GUI prompt nobody is there to answer.
    run(SECURITY, ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", pw, keychain]);
    // Trusted for code signing only, in the system domain (root can, with no prompt).
    run(SECURITY, ["add-trusted-cert", "-d", "-r", "trustRoot", "-p", "codeSign", "-k", systemKeychain, cert]);
    const fp = run(OPENSSL, ["x509", "-in", cert, "-noout", "-fingerprint", "-sha1"]);
    const sha1 = ((fp.match(/=([0-9A-Fa-f:]{59})/) || [])[1] || "").replace(/:/g, "").toUpperCase();
    if (!/^[0-9A-F]{40}$/.test(sha1)) throw new Error("could not read the signing certificate's fingerprint");
    // codesign lists only identities it finds valid. Check that now, and when it is not, say what
    // the keychain and the trust say instead of codesign's bare "no identity found".
    const tryOut = (/** @type {string[]} */ a) => { try { return String(run(SECURITY, a)); } catch (e) { return `(${/** @type {Error} */ (e).message.split("\n")[0]})`; } };
    const valid = tryOut(["find-identity", "-v", "-p", "codesigning", keychain]);
    if (!valid.toUpperCase().includes(sha1)) {
      throw new Error(`the signing identity is not valid for code signing. valid: ${valid.trim()} | all: ${tryOut(["find-identity", "-p", "codesigning", keychain]).trim()} | verify: ${tryOut(["verify-cert", "-c", cert, "-p", "codeSign", "-k", keychain])}`.replace(/\s+/g, " "));
    }
    fs.writeFileSync(path.join(dir, "cert.pem"), fs.readFileSync(cert), { mode: 0o600 });
    fs.writeFileSync(meta, JSON.stringify({ sha1, keychain, identity: IDENTITY, created: new Date().toISOString() }) + "\n", { mode: 0o600 });
    return { sha1, keychain, created: true };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Sign the Capsule (Vyre.app) at `app`, with the hardened runtime so a same-uid process can't inject a library, with the identity, then check it. Returns the designated requirement
 * (what the Capsule's keychain ACL and core's pin bind to) and the cdhash.
 * @param {{ app: string, dir: string, run: Run }} o
 * @returns {{ requirement: string, cdhash: string, sha1: string }}
 */
export function signApp({ app, dir, run }) {
  const { sha1, keychain } = ensureIdentity({ dir, run });
  run(SECURITY, ["unlock-keychain", "-p", "", keychain]);
  // codesign looks identities up through root's own keychain search list, so put ours on it (root's
  // list only: the person's and _vyre's are never touched).
  const listed = String(run(SECURITY, ["list-keychains", "-d", "user"])).split("\n").map((l) => l.trim().replace(/^"|"$/g, "")).filter(Boolean);
  if (!listed.includes(keychain)) run(SECURITY, ["list-keychains", "-d", "user", "-s", keychain, ...listed]);
  try {
    run(CODESIGN, ["--force", "--deep", "--keychain", keychain, "--sign", sha1, "--identifier", CAPSULE_ID, "--options", "runtime", "--timestamp=none", app]);
  } catch (e) {
    const tryOut = (/** @type {string[]} */ a) => { try { return String(run(SECURITY, a)); } catch (x) { return `(${/** @type {Error} */ (x).message.split("\n")[0]})`; } };
    throw new Error(`${/** @type {Error} */ (e).message.split("\n").slice(0, 2).join(" ")} | list-keychains: ${tryOut(["list-keychains", "-d", "user"]).trim()} | identities: ${tryOut(["find-identity", "-v", "-p", "codesigning"]).trim()} | in ours: ${tryOut(["find-identity", "-p", "codesigning", keychain]).trim()}`.replace(/\s+/g, " "));
  }
  run(CODESIGN, ["--verify", "--strict", "--deep", app]);
  const req = run(CODESIGN, ["-d", "-r-", app]);
  const requirement = (String(req).match(/designated => (.*)/) || [])[1] || "";
  const info = run(CODESIGN, ["-dvvv", app]);
  const cdhash = (String(info).match(/CDHash=([0-9a-f]+)/) || [])[1] || "";
  return { requirement, cdhash, sha1 };
}

/** Where an unfinished certificate removal is written down: root's folder, but outside the signing folder that is deleted. @param {string} dir */
const pendingFile = (dir) => path.join(path.dirname(path.resolve(dir)), ".signing-cert-retry");

/** The exact command that removes the certificate by hand. @param {string} sha1 @param {string} systemKeychain */
export const removeCommand = (sha1, systemKeychain = SYSTEM_KEYCHAIN) => `sudo /usr/bin/security delete-certificate -Z ${sha1} ${systemKeychain}`;

/**
 * Delete the certificate from the system keychain, then, best effort, its trust settings. On a runner the
 * trust-settings write (`remove-trusted-cert`, or `delete-certificate -t`) does not answer, while deleting
 * the certificate does; trust settings for a certificate that is gone, with its key gone, are inert. Each
 * step gets 20 s. @param {string} sha1 @param {string} systemKeychain @param {Run} run @param {string} [pem]
 * @returns {boolean} whether the certificate is gone
 */
function dropCertificate(sha1, systemKeychain, run, pem) {
  let gone = false;
  try { run(SECURITY, ["delete-certificate", "-Z", sha1, systemKeychain], { timeout: 20_000 }); gone = true; } catch { /* maybe never there, maybe stuck: look */ }
  if (!gone) {
    try { run(SECURITY, ["find-certificate", "-Z", "-a", "-c", IDENTITY, systemKeychain], { timeout: 20_000 }); } catch { gone = true; } // no certificate by that name
  }
  if (gone && pem && fs.existsSync(pem)) { try { run(SECURITY, ["remove-trusted-cert", "-d", pem], { timeout: 10_000 }); } catch { /* inert without the certificate */ } }
  return gone;
}

/** Finish a certificate removal an earlier uninstall could not. @param {{ dir: string, run: Run, systemKeychain?: string }} o @returns {string | null} the sha1 still pending */
export function retryPending({ dir, run, systemKeychain = SYSTEM_KEYCHAIN }) {
  const f = pendingFile(dir);
  let j;
  try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
  if (typeof j.sha1 !== "string" || !/^[0-9A-F]{40}$/.test(j.sha1)) { fs.rmSync(f, { force: true }); return null; }
  if (dropCertificate(j.sha1, systemKeychain, run)) { fs.rmSync(f, { force: true }); return null; }
  return j.sha1;
}

/**
 * Remove the identity completely: the certificate and its trust from the system keychain, the keychain
 * from root's search list, and the folder with the key. If macOS will not remove the certificate, the
 * sha1 is written down (root's folder, outside the one deleted) so the next install or uninstall retries,
 * and the exact command is returned.
 * @param {{ dir: string, run: Run, systemKeychain?: string }} o
 * @returns {{ pending: string | null, command: string | null, listNote: string | null }}
 */
export function removeIdentity({ dir, run, systemKeychain = SYSTEM_KEYCHAIN }) {
  let sha1 = null;
  let keychain = null;
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, "identity.json"), "utf8")); sha1 = j.sha1; keychain = j.keychain; } catch { /* none */ }
  let pending = retryPending({ dir, run, systemKeychain });
  if (sha1) {
    fs.mkdirSync(path.dirname(path.resolve(dir)), { recursive: true });
    fs.writeFileSync(pendingFile(dir), JSON.stringify({ sha1 }) + "\n", { mode: 0o600 });
    if (dropCertificate(sha1, systemKeychain, run, path.join(dir, "cert.pem"))) { fs.rmSync(pendingFile(dir), { force: true }); pending = null; } else pending = sha1;
  }
  let listNote = null;
  if (keychain) {
    // Root's own search list only; a failure here must not stop the removal, but it is said, not swallowed.
    try {
      const listed = String(run(SECURITY, ["list-keychains", "-d", "user"])).split("\n").map((l) => l.trim().replace(/^"|"$/g, "")).filter(Boolean);
      if (listed.includes(keychain)) {
        run(SECURITY, ["list-keychains", "-d", "user", "-s", ...listed.filter((k) => k !== keychain)]);
        const after = String(run(SECURITY, ["list-keychains", "-d", "user"]));
        if (after.includes(keychain)) listNote = `root's keychain list still names ${keychain} after the update; list was: ${listed.join(" | ")}`;
      }
    } catch (e) { listNote = `could not update root's keychain list: ${String(/** @type {Error} */ (e).message).split("\n")[0]}`; }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { pending, command: pending ? removeCommand(pending, systemKeychain) : null, listNote };
}
