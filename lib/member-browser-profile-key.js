// @ts-check
// member-browser-profile-key: one path to the wrap key for every person's browser profile (vault.me item, never the space vault).

import { MEMBER_BROWSER_PROFILE_KEY } from "./browser-profile.js";
import { keyFromVault } from "./browser-profile-store.js";

export { MEMBER_BROWSER_PROFILE_KEY };

/** @param {Record<string, string>|undefined} fields */
export function keyMaterialFromFields(fields) {
  const v = fields && fields.key;
  if (!v) throw new Error(`no key field on ${MEMBER_BROWSER_PROFILE_KEY}`);
  return String(v);
}

/**
 * @param {(tool: string, input: any) => Promise<{ data?: any, error?: any }>} call
 * @param {string} personId
 */
export async function resolveMemberBrowserProfileKey(call, personId) {
  const r = await call("vault.person.browser-profile-key", { person: personId });
  if (r.error) throw new Error(r.error.message || "could not read browser profile key");
  return keyMaterialFromFields({ key: r.data && r.data.key });
}

/** @param {string} material vault item field */
export function memberProfileAesKey(material) {
  return keyFromVault(material);
}
