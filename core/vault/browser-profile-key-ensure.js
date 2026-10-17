// @ts-check
// browser-profile-key-ensure: create wrap keys inside the right vault on first need (never exposed to agents).

import { AGENT_BROWSER_PROFILE_KEY, MEMBER_BROWSER_PROFILE_KEY } from "../../lib/browser-profile.js";
import { generateProfileKeyMaterial } from "../../lib/browser-profile-key-material.js";
import { vaultLockedError } from "../../lib/vault-unlock-error.js";

const ITEM_DESC = "Wraps browser profile data on the shared browser (created automatically).";

/**
 * @param {import("./people.js").PeopleVaults} people
 * @param {string} personId
 * @returns {Promise<string>} key material (hex), for module-internal use only
 */
export async function ensureMemberBrowserProfileKey(people, personId) {
  const read = async () => {
    const it = await people.get(personId, { name: MEMBER_BROWSER_PROFILE_KEY });
    const key = it && it.fields && it.fields.key;
    if (!key) throw new Error(`no key field on ${MEMBER_BROWSER_PROFILE_KEY}`);
    return String(key);
  };
  try {
    return await read();
  } catch (e) {
    const err = /** @type {any} */ (e);
    if (err.code === "locked") throw vaultLockedError({ vault: "person" });
    if (!/no item named/.test(String(err.message || e))) throw e;
    try {
      await people.put(personId, {
        name: MEMBER_BROWSER_PROFILE_KEY,
        kind: "secret",
        description: ITEM_DESC,
        fields: { key: generateProfileKeyMaterial() },
      });
      return await read();
    } catch (e2) {
      const err2 = /** @type {any} */ (e2);
      if (err2.code === "locked") throw vaultLockedError({ vault: "person" });
      throw e2;
    }
  }
}

/**
 * @param {import("./vault.js").Vault} vault
 * @returns {Promise<string>} key material (hex), for module-internal use only
 */
export async function ensureAgentBrowserProfileKey(vault) {
  try {
    await vault.key();
  } catch (e) {
    if (/** @type {any} */ (e).code === "locked") throw vaultLockedError({ vault: "space" });
    throw e;
  }
  if (vault.hasAccount() && !vault.pvk) throw vaultLockedError({ vault: "space" });
  const name = AGENT_BROWSER_PROFILE_KEY;
  const row = vault.row(name);
  if (row) {
    const f = await vault.fields(row);
    const existing = f.value || f.key;
    if (existing) return String(existing);
  }
  const key = generateProfileKeyMaterial();
  await vault.put({ name, kind: "secret", description: ITEM_DESC, fields: { value: key } }, "module:vault");
  const after = vault.row(name);
  if (!after) throw new Error(`could not create ${name}`);
  const f2 = await vault.fields(after);
  const material = f2.value || f2.key;
  if (!material) throw new Error(`no value on ${name}`);
  return String(material);
}
