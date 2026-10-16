// @ts-check
// profile-store: per-agent browser context keys from the vault (agent-browsers.md credentials).
//
// Agent profiles use a Space vault item; a space member's own browser context uses material from
// the personal vault. Nothing here is a Chrome password: only key derivation for encrypting
// profile blobs at rest on the shared browser volume.

import crypto from "node:crypto";

/** Space vault item: encryption root for agent browser profiles on the shared computer. */
export const AGENT_PROFILE_ITEM = "vyre-browser-agent-profile-key";
/** Personal vault item: encryption root for a member's own browser context (never the Space vault). */
export const MEMBER_PROFILE_ITEM = "vyre-browser-member-profile-key";

/**
 * @param {string} material vault-held secret (never logged)
 * @param {string} agentId stable agents.uid
 * @param {string} purpose label for HKDF info
 */
export function deriveProfileKey(material, agentId, purpose = "browser-profile") {
  const salt = crypto.createHash("sha256").update(`${purpose}:${agentId}`).digest();
  return crypto.hkdfSync("sha256", Buffer.from(String(material), "utf8"), salt, `vyre:${purpose}:${agentId}`, 32);
}

/** @param {Buffer} key @param {Buffer} plain */
export function sealProfile(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

/** @param {Buffer} key @param {Buffer} packed */
export function openProfile(key, packed) {
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const enc = packed.subarray(28);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]);
}

/**
 * @param {{ fetchAgent?: () => Promise<string|null>, fetchMember?: () => Promise<string|null> }} vault
 */
export function createProfileStore(vault) {
  return {
    AGENT_PROFILE_ITEM,
    MEMBER_PROFILE_ITEM,
    /** @param {string} agentId @param {"agent"|"member"} kind */
    async keyFor(agentId, kind = "agent") {
      const material = kind === "member"
        ? (vault.fetchMember ? await vault.fetchMember() : null)
        : (vault.fetchAgent ? await vault.fetchAgent() : null);
      if (!material) return null;
      return deriveProfileKey(material, agentId, kind === "member" ? "member-browser-profile" : "agent-browser-profile");
    },
  };
}
