// @ts-check
// Is this key one of the home's owner's devices? The registry's `own` presence method (core/presence/index.js) signs with the person's identity key, and this is the check that the key is theirs: a
// published full device key (an Ed25519 key, not a passkey and not one the web or the relay holds) on the owner's identity list in the names directory, the same check install redeem and the sign-in door make.
import { assertPublishedKey } from "../../lib/identity/published-key.js";

/**
 * @param {{ owner: () => string | null, directory: () => { resolveById: (id: string) => Promise<any> } }} o `directory` is asked fresh each call so a restart's config is read
 * @returns {(pub: string) => Promise<boolean>}
 */
export function ownerKeyCheck(o) {
  return async pub => {
    const owner = o.owner();
    if (!owner) return false;
    try { await assertPublishedKey(o.directory(), owner, pub, { fullDevice: true }); return true; } catch { return false; }
  };
}
