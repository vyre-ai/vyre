// The pairing card over an injected `call` (the app's box connection, or a fake box in a test).
import type { Call } from "../settings/real-source";
import { requestsOf, winkAsking, type PairRequest } from "./model.ts";

export function pairingSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    /** A box without link.pending (or one that answers an error) has no requests: the card stays away. */
    pending: async (): Promise<PairRequest[]> => { try { return requestsOf(await ask("link.pending")); } catch { return []; } },
    /** A new device asking over Wink: three words to confirm. */
    winkAsk: async () => { try { return winkAsking(await ask("wink.phone.pairing")); } catch { return null; } },
    /** The code is typed by the person; the box asks for their passkey. Throws the box's words. */
    approve: (code: string) => ask<{ name?: string }>("link.pair.approve", { code }),
    deny: (id: string) => ask("link.pair.deny", { id }),
  };
}
