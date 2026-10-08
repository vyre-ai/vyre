// @ts-check
// A Windows PC's Windows Hello passkey as its presence key (the TPM key a page script could reach is no yes on a release server; a passkey asks the person at the OS every time it signs). The passkey is made once for
// the site the window is on (identity/passkey.js passkeyRp, shell rule), kept as its id and public key (the credential stays in Windows Hello), and enrols as signer "webauthn_platform" with that site as its `rp`:
// the sealing process checks every yes from it as a WebAuthn assertion over the proof's bytes (kernel/seal/proof.js), and the identity chain's verifier does the same for a list change signed with it.
import { createPasskeyKey, restorePasskeyKey, passkeyRp, passkeyPresenceKey } from "../identity/passkey.js";
import { signPresenceWithPasskey, presenceKeyId } from "./passkey-signer.js";
import { b64 } from "../../modules/vyre-signer/presence-proof.js";

/** @typedef {{ get(key: string): Promise<any> | any, put(key: string, value: any): Promise<void> | void }} KeepStore */

/**
 * This window's passkey: made now if there is none for this site, else the one kept. Null where the page may not make one (the site is not one the shell takes) or the platform has no WebAuthn.
 * @param {{ origin: string, store: KeepStore, name?: string, webauthn?: any, timeout?: number }} d
 * @returns {Promise<{ rp: string, key: any, signer: { signPresence(card: any): Promise<any> }, enrolment: { key_id: string, spki: string, signer: "webauthn_platform", rp: string } } | null>}
 */
export async function windowsPasskey(d) {
  const rp = passkeyRp(d.origin, { shell: true });
  if (!rp) return null;
  const slot = `windows-passkey/${rp}`;
  const kept = await d.store.get(slot);
  /** @type {any} */ let key = null;
  if (kept && kept.kind === "passkey" && kept.rp === rp) key = await restorePasskeyKey(kept, { ...(d.webauthn ? { webauthn: d.webauthn } : {}), ...(d.timeout ? { timeout: d.timeout } : {}) });
  if (!key) {
    key = await createPasskeyKey({ rp, name: d.name || "Vyre", ...(d.webauthn ? { webauthn: d.webauthn } : {}), ...(d.timeout ? { timeout: d.timeout } : {}) });
    await d.store.put(slot, key.keep());
  }
  const pk = passkeyPresenceKey(key.keep());
  if (!pk) return null;
  const spki = /** @type {Uint8Array} */ (chainUnb64(pk.key));
  return {
    rp, key,
    signer: { signPresence: card => signPresenceWithPasskey(card, { key }) },
    enrolment: { key_id: presenceKeyId(spki), spki: b64(spki), signer: "webauthn_platform", rp },
  };
}
const chainUnb64 = (/** @type {string} */ s) => { const t = s.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), c => c.charCodeAt(0)); };
