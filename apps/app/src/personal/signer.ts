// The key that says the person's yes: this phone's Face ID key on a native build, the passkey in a browser that signed in with one. null where neither exists (the card then says so).
import { Platform } from "react-native";
import { phoneSigner } from "../real/phone-signer";
import { loadIdentity } from "../identity/store";
import { passkeyPresenceKey } from "../identity/passkey.js";
import { signPresenceWithPasskey } from "../real/passkey-signer.js";

export type YesSigner = { signPresence(req: any): Promise<any> };

export async function yesSigner(): Promise<YesSigner | null> {
  if (Platform.OS !== "web") return phoneSigner();
  const mine = await loadIdentity();
  const key = mine?.key as { sign(m: Uint8Array): Promise<Uint8Array>; keep(): unknown } | undefined;
  if (!mine || !key || !passkeyPresenceKey(key.keep() as never)) return null;
  return { signPresence: (req) => signPresenceWithPasskey(req, { key }) };
}
