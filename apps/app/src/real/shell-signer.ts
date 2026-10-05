// The yes moments on a computer whose app holds a hardware key for them: the Mac's window (Secure Enclave, Touch ID) and the Windows panel (the TPM behind Windows Hello). Same shape as the phone's
// signer (phone-signer.ts): refuse unless the card's fields hash to its payload_hash (proofBody does that), then the hardware key signs the proof's bytes behind the person's prompt. The key is the one in the
// device's identity entry (`enclave`); the page gets a signature, never the key.

import { shellIdentity } from "../shell/shell.ts";
import { macEnclavePublic, macEnclaveSign } from "../identity/mac-key.ts";
import { fromB64url, keyIdOf, proofBody, proofBytes, spkiFromXY, b64url } from "../../modules/vyre-signer/presence-proof.js";
import type { Signer } from "./phone-approve.js";

/** The signer for this computer's hardware key, or null where there is none (a browser, a Mac without a Secure Enclave, a computer without a TPM or Windows Hello). */
export async function shellSigner(): Promise<Signer | null> {
  if (!shellIdentity()?.enclaveSign) return null;
  const point = await macEnclavePublic(false);
  if (!point) return null;
  const pt = fromB64url(point);
  if (pt.length !== 65 || pt[0] !== 4) return null;
  const keyId = keyIdOf(spkiFromXY(pt.slice(1, 33), pt.slice(33, 65)));
  return {
    signPresence: async (card: any) => {
      // the card carries the person (approveCard passes the id the box named); without one the proof refuses (ERR_NO_PERSON)
      const person = card.person || "";
      const body = proofBody({ op: card.op, space: card.space, fields: card.fields, payload_hash: card.payload_hash, person }, { keyId, now: Date.now(), nonce: b64url(crypto.getRandomValues(new Uint8Array(16))), signer: "secure_enclave" });
      const signature = await macEnclaveSign(proofBytes(body), card.prompt || "Approve this change");
      return { ...body, signature: b64url(signature) };
    },
  };
}
