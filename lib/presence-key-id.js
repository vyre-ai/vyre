// @ts-check
// The id a presence key is known by in a home's sealing process: `dk_` and the first 16 hex characters of the SHA-256 of its SPKI DER. The device that holds the key (it signs under this id) and the
// home that enrols it at pairing both derive it from the key itself, so neither has to be told.
import crypto from "node:crypto";

/** @param {Buffer | Uint8Array} spkiDer */
export const presenceKeyId = spkiDer => `dk_${crypto.createHash("sha256").update(spkiDer).digest("hex").slice(0, 16)}`;
