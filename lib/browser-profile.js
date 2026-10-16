// @ts-check
// browser-profile: vault-backed keys for shared-browser profile blobs (member vs agent contexts).
//
// Every person's browser profile (owner included) uses a key from that person's own vault.me item;
// agent browser contexts alone use the space vault key. cdpmux still holds live contexts in Chrome;
// this module is the vyred-side wrap/unwrap when those blobs are stored on the computer volume.

import crypto from "node:crypto";

/** Space vault item: wraps every agent browser-context export on a shared computer. */
export const AGENT_BROWSER_PROFILE_KEY = "vyre-agent-browser-profile-key";

/** Per-member vault item: wraps that member's own person Chrome profile on the shared browser. */
export const MEMBER_BROWSER_PROFILE_KEY = "vyre-member-browser-profile-key";

const IV = 12;

/**
 * @param {Buffer} key 32 bytes
 * @param {Buffer} plain
 */
export function sealProfile(key, plain) {
  if (key.length !== 32) throw new Error("profile key must be 32 bytes");
  const iv = crypto.randomBytes(IV);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, body]);
}

/**
 * @param {Buffer} key 32 bytes
 * @param {Buffer} sealed iv(12) + tag(16) + ciphertext
 */
export function openProfile(key, sealed) {
  if (key.length !== 32) throw new Error("profile key must be 32 bytes");
  if (sealed.length < IV + 16 + 1) throw new Error("sealed profile is too short");
  const iv = sealed.subarray(0, IV);
  const tag = sealed.subarray(IV, IV + 16);
  const body = sealed.subarray(IV + 16);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);
}
