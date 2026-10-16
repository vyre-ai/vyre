// @ts-check
// The personal vault device key at rest, once a master password exists.
// The plaintext vault/key file is removed. A sealed copy stays on this box so lending works with nobody unlocked.
// The key-encryption key is the OS keystore on macOS, or a 0600 file under identity/seals, which a member copy of one space does not include.

import path from "node:path";
import { aesUnwrap, aesWrap } from "./wrap.js";
import { readJson, rmQuiet, writePrivate } from "./files.js";
import { ensureKek, readKek } from "./sealed-key.js";

const AAD = "vyre:vault:server-wrap:v1";

/** @param {string} root */
export const vaultWrapPath = root => path.join(root, "vault", "server-wrap.json");
/** @param {string} root */
export const vaultKekPath = root => path.join(root, "identity", "seals", "personal-vault.kek");
/** @param {string} root */
export const plainVaultKeyPath = root => path.join(root, "vault", "key");

/** Seal the device key and delete any plaintext copy. The buffer passed in is left intact. @param {string} root @param {Buffer} vaultKey */
export function adoptVaultKey(root, vaultKey) {
  if (!vaultKey || !vaultKey.length) return;
  const kek = ensureKek(vaultKekPath(root));
  try {
    const box = aesWrap(kek, vaultKey, AAD);
    writePrivate(vaultWrapPath(root), JSON.stringify({ v: 1, ...box }) + "\n");
  } finally { kek.fill(0); }
  rmQuiet(plainVaultKeyPath(root));
}

/** Remove a plaintext vault/key file. The sealed wrap is the copy this box opens. @param {string} root */
export function dropPlainVaultKey(root) {
  rmQuiet(plainVaultKeyPath(root));
}

/** The device key, or null when the seal is missing or does not open. @param {string} root @returns {Buffer|null} */
export function openVaultKey(root) {
  const row = readJson(vaultWrapPath(root));
  if (!row || typeof row.ct !== "string") return null;
  const kek = readKek(vaultKekPath(root));
  if (!kek) return null;
  try { return aesUnwrap(kek, row, AAD); }
  catch { return null; }
  finally { kek.fill(0); }
}
