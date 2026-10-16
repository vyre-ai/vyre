// @ts-check
// The personal vault's device key, once a master password exists (ADR 0054).
// The unwrapped master key is the root. vault/key is the server-held copy of that same key, so agents lend with nobody unlocked.
// A home with no master record keeps the file or keychain keystore.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { currentPersonalKey } from "../../kernel/identity/holder.js";
import { readMaster } from "../../kernel/identity/master.js";
import { adoptVaultKey, openVaultKey, plainVaultKeyPath } from "../../kernel/identity/vault-at-rest.js";
import { keyObject, unwrapVaultKey } from "./crypto.js";
import { readJsonFile } from "./store.js";

/** The agent vault key file. One string, shared with vault.js. */
export const AGENT_VK = path.join("vaults", "agents.json");
const KV = 1;

/** @param {string} cls @param {number} kv @param {string} [acct] */
export const vkAad = (cls, kv, acct = "") => `vyre:vk:v2:${cls}:${acct ? acct + ":" : ""}${kv}`;

const locked = (message) => Object.assign(new Error(message), { code: "locked" });

/**
 * Does this device key unwrap the agent vault key already on disk? A home with no agent key yet can adopt it.
 * @param {string} dir @param {Buffer} raw
 */
function opensAgent(dir, raw) {
  const w = readJsonFile(dir, AGENT_VK);
  if (!w) return true;
  try {
    unwrapVaultKey(keyObject(Buffer.from(raw)), w, vkAad("agents", KV));
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the server copy when it is missing or different. The held buffer stays intact.
 * @param {{ keys: { exists: () => Promise<boolean>, load: (o?: any) => Promise<Buffer|null>, save?: (raw: Buffer) => Promise<void> } }} vault
 * @param {Buffer} held
 */
async function syncServerCopy(vault, held) {
  if (typeof vault.keys.save !== "function") return;
  if (await vault.keys.exists()) {
    const current = await vault.keys.load();
    const same = Boolean(current && current.length === held.length && crypto.timingSafeEqual(current, held));
    if (current) current.fill(0);
    if (same) return;
  }
  const copy = Buffer.from(held);
  try { await vault.keys.save(copy); } finally { copy.fill(0); }
}

/**
 * The device key this vault should adopt. The caller zeroes the buffer.
 * A passphrase keystore stays a passphrase lock. With a master key held in this process, that key wins and the server copy is rewritten from it when it opens the agent vault.
 * With nobody unlocked, the server copy opens the agent vault. A master record with neither a held key nor a server copy does not grow a new key.
 * @param {{ dir: string, kind: string, log?: (m: string) => void, keys: { exists: () => Promise<boolean>, load: (o?: any) => Promise<Buffer|null>, create: (o?: any) => Promise<Buffer>, save?: (raw: Buffer) => Promise<void> } }} vault
 */
export async function deviceKey(vault) {
  if (vault.kind === "passphrase") {
    if (await vault.keys.exists()) {
      const raw = await vault.keys.load();
      if (!raw) throw locked("the vault is locked · vyre vault unlock");
      return raw;
    }
    throw locked("the vault has no passphrase yet · vyre vault unlock sets one");
  }
  const held = currentPersonalKey();
  if (held) {
    if (!opensAgent(vault.dir, held)) {
      held.fill(0);
      throw locked("The master key does not open this vault. Restore the vault key from a backup, then unlock on this device.");
    }
    await syncServerCopy(vault, held);
    return held;
  }
  if (await vault.keys.exists()) {
    const raw = await vault.keys.load();
    if (!raw) throw locked("the vault is locked · vyre vault unlock");
    return raw;
  }
  if (readMaster(path.dirname(vault.dir))) {
    const sealed = openVaultKey(path.dirname(vault.dir));
    if (sealed) {
      await syncServerCopy(vault, sealed);
      return sealed;
    }
    throw locked("The master password is set and this vault has no server copy of its key. Unlock on this device so the vault can adopt it.");
  }
  const raw = await vault.keys.create();
  if (vault.log) vault.log(`vault key created in the ${vault.kind} keystore`);
  return raw;
}

/**
 * Put the held master key into the running vault and drop any plaintext vault/key.
 * A vault that is already open stays open when the held key unwraps the same agent key.
 * A held key that does not is refused, and the open vault is left as it is.
 * The caller is identity.vault.install. vault.key() does not replace an agent key it already holds.
 * @param {{ dir: string, kind: string, vk: import("node:crypto").KeyObject|null, key: () => Promise<import("node:crypto").KeyObject> }} vault
 */
export async function installHeldKey(vault) {
  if (vault.kind === "passphrase") throw locked("This vault stays a passphrase lock. Unlock it with its passphrase.");
  const root = path.dirname(vault.dir);
  const held = currentPersonalKey();
  if (!held) throw locked("Unlock this identity on this device before the vault can take the master key.");
  if (!opensAgent(vault.dir, held)) {
    held.fill(0);
    throw locked("The master key does not open this vault. Restore the vault key from a backup, then unlock on this device.");
  }
  if (!readMaster(root)) {
    held.fill(0);
    throw locked("Set a master password on this device before the vault can take the master key.");
  }
  try {
    if (!vault.vk && !readJsonFile(vault.dir, AGENT_VK)) adoptVaultKey(root, held);
    if (!vault.vk) await vault.key();
    adoptVaultKey(root, held);
  } finally {
    held.fill(0);
  }
  if (fs.existsSync(plainVaultKeyPath(root))) throw locked("The plaintext vault key is still on disk. Unlock on this device and install again.");
  return { installed: true, plaintext: false };
}
