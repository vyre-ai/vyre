// @ts-check
// The presence key a device offered in its pairing hello, as the home's sealing process takes it (core/wink/pairing.js): a software key only from a computer that says it keeps it in software (the sealing
// process refuses it on a release-kind build), a hardware key only from a signer kind that can hold one. null when the device did not say enough, which the pairing refuses out loud.
import { presenceKeyId } from "../../lib/presence-key-id.js";

/** @param {string} device @param {any} confirmed what the relay holds of the hello's key @param {any} input the pairing's own input @returns {null | { device: string, key_id: string, spki: string, signer: string, rp?: string }} */
export function presenceKeyFor(device, confirmed, input) {
  try {
    if (!confirmed || typeof confirmed.key !== "string" || (confirmed.alg !== undefined && confirmed.alg !== -7)) return null;
    // the device's own word on where it keeps its key beats the relay's "unknown" (the relay fills that in when a hello says nothing): unknown only when nothing is stated anywhere
    const stated = [input && input.keyStorage, confirmed.storage].find(x => typeof x === "string" && x !== "" && x !== "unknown");
    const storage = String(stated || "");
    const kindOk = ["secure_enclave", "tpm", "windows_hello", "strongbox", "webauthn_platform"].includes(String(confirmed.signer || ""));
    const signer = storage === "software" ? "software" : kindOk ? String(confirmed.signer) : null;
    if (!signer) return null;
    const der = Buffer.from(confirmed.key, "base64url");
    return { device, key_id: presenceKeyId(der), spki: der.toString("base64"), signer, ...(signer === "webauthn_platform" && typeof confirmed.rp === "string" ? { rp: confirmed.rp } : {}) };
  } catch { return null; }
}
