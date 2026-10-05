// The pairing card over an injected `call` (the app's box connection, or a fake box in a test).
import type { Call } from "../settings/real-source";
import { winkAsking } from "./model.ts";

export function pairingSource(call: Call) {
  return {
    /** A new device asking over Wink: three words to confirm. A box without it, or one that answers an error, has no request: the card stays away. */
    winkAsk: async () => {
      try {
        const r = await call<unknown>("wink.phone.pairing", {});
        if (r.error) return null;
        return winkAsking(r.data);
      } catch { return null; }
    },
  };
}
