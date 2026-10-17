// @ts-check
// agent-browser-profile-key: space vault wrap key for agent browser profiles (internal computers path only).

import { keyFromVault } from "./browser-profile-store.js";

/**
 * @param {(tool: string, input: any) => Promise<{ data?: any, error?: any }>} call
 */
export async function resolveAgentBrowserProfileKey(call) {
  const r = await call("vault.space.browser-profile-key", {});
  if (r.error) {
    throw Object.assign(new Error(r.error.message || "could not read agent browser profile key"), {
      code: r.error.code || "failed",
      ...(r.error.detail && typeof r.error.detail === "object" ? { detail: r.error.detail } : {}),
    });
  }
  const material = r.data && r.data.key;
  if (!material) throw new Error("no agent browser profile key");
  return String(material);
}

/** @param {string} material */
export function agentProfileAesKey(material) {
  return keyFromVault(material);
}
