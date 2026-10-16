// @ts-check
// browser-profile-store: sealed profile blobs on the space server (per agent context on a shared browser).
//
// Plain blobs are produced by computerd export (cookies/storage tarball) — not wired here yet.
// Agent profiles use the space vault key; every person's profile uses that person's own vault.me
// item (lib/member-browser-profile-key.js), never the space vault.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { openProfile, sealProfile } from "./browser-profile.js";

/** @param {string} dataRoot vyred data directory for this space */
export function computerProfileDir(dataRoot, computerId) {
  return path.join(dataRoot, "browser-profiles", String(computerId));
}

/** @param {string} dataRoot @param {string} computerId @param {string} agentId */
export function agentProfilePath(dataRoot, computerId, agentId) {
  return path.join(computerProfileDir(dataRoot, computerId), `${String(agentId)}.sealed`);
}

/** @param {string} dataRoot @param {string} computerId @param {string} personId member person id */
export function memberProfilePath(dataRoot, computerId, personId) {
  return path.join(computerProfileDir(dataRoot, computerId), `member-${String(personId)}.sealed`);
}

/**
 * @param {Buffer} key 32 bytes
 * @param {string} file
 * @param {Buffer} plain
 */
export async function writeSealedProfile(key, file, plain) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, sealProfile(key, plain));
}

/**
 * @param {Buffer} key 32 bytes
 * @param {string} file
 * @returns {Promise<Buffer|null>}
 */
export async function readSealedProfile(key, file) {
  try {
    const sealed = await fs.readFile(file);
    return openProfile(key, sealed);
  } catch (e) {
    if (/** @type {any} */ (e).code === "ENOENT") return null;
    throw e;
  }
}

/** Derive a 32-byte AES key from a vault string (hex or base64 or raw). @param {string} material */
export function keyFromVault(material) {
  const s = String(material || "");
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, "hex");
  try {
    const b = Buffer.from(s, "base64");
    if (b.length === 32) return b;
  } catch { /* fall through */ }
  return crypto.createHash("sha256").update(s, "utf8").digest();
}
