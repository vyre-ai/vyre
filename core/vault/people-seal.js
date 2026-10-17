// @ts-check
// people-seal: the sealed server copy of a member's personal vault key (owner, 17 Oct 2026: "sealed copy is fine"), so an app connection keeps working for agents and Flows while its owner is locked.
// The same primitives as the Space's own vault key (kernel/identity/vault-at-rest.js): AES-256-GCM under a key-encryption key the OS keystore or a 0600 file under identity/seals holds, the wrap bound
// to the person by its AAD, never a plaintext copy of the key anywhere. It is made when the person unlocks or resets, removed when they leave, and read only by `PeopleVaults.service`, which opens
// connection items and nothing else. The person's own surfaces never use it: their vault still opens only with the master password on a device.

import crypto from "node:crypto";
import path from "node:path";
import { aesUnwrap, aesWrap } from "../../kernel/identity/wrap.js";
import { readJson, rmQuiet, writePrivate } from "../../kernel/identity/files.js";
import { ensureKek, readKek } from "../../kernel/identity/sealed-key.js";
import { keyObject } from "./crypto.js";

const AAD = (/** @type {string} */ person) => `vyre:member-vault:server-wrap:v1:${person}`;
const kekPath = (/** @type {string} */ root) => path.join(root, "identity", "seals", "member-vaults.kek");
export const wrapPath = (/** @type {string} */ root, /** @type {string} */ person) =>
  path.join(root, "vault-people", "wraps", crypto.createHash("sha256").update("vyre-member-wrap\0" + person).digest("hex").slice(0, 40) + ".json");

/** Seal a member's vault key. The key object is left intact. @param {string} root @param {string} person @param {import("node:crypto").KeyObject} key */
export function sealMemberKey(root, person, key) {
  const raw = key.export();
  const kek = ensureKek(kekPath(root));
  try { writePrivate(wrapPath(root, person), JSON.stringify({ v: 1, ...aesWrap(kek, raw, AAD(person)) }) + "\n"); }
  finally { kek.fill(0); raw.fill(0); }
}

/** The member's vault key, or null when there is no seal or it does not open (another person's wrap, a missing key-encryption key, damage). @param {string} root @param {string} person */
export function openMemberKey(root, person) {
  const row = readJson(wrapPath(root, person));
  if (!row || typeof row.ct !== "string") return null;
  const kek = readKek(kekPath(root));
  if (!kek) return null;
  try { const raw = aesUnwrap(kek, row, AAD(person)); const k = keyObject(Buffer.from(raw)); raw.fill(0); return k; }
  catch { return null; }
  finally { kek.fill(0); }
}

/** Remove a member's seal (they left the Space). @param {string} root @param {string} person */
export function forgetMemberKey(root, person) { rmQuiet(wrapPath(root, person)); }
