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
    // the signer class and the passkey's rp are the DEVICE's own word, sent by the device itself in its adopt call (`input.keySigner`, `input.keyRp`), never what the relay holds of its hello: a relay that adds a signer the device did not state
    // changes nothing here (trust row 56). Platform attestation of the class is backlog 0.3.5.
    const said = input && typeof input.keySigner === "string" ? input.keySigner : "";
    const kindOk = ["secure_enclave", "tpm", "windows_hello", "strongbox", "webauthn_platform"].includes(said);
    const signer = storage === "software" ? "software" : kindOk ? said : null;
    if (!signer) return null;
    const der = Buffer.from(confirmed.key, "base64url");
    return { device, key_id: presenceKeyId(der), spki: der.toString("base64"), signer, ...(signer === "webauthn_platform" && input && typeof input.keyRp === "string" ? { rp: input.keyRp } : {}) };
  } catch { return null; }
}
