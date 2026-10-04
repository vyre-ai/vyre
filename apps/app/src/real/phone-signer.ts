// The phone's key for presence proofs: native-core's iOS key module (signPresence behind Face ID). A phone whose build does not have it yet gets null, and the card says so instead of offering a button that would not work.
import { Platform } from "react-native";
import type { Signer } from "./phone-approve.js";

export async function phoneSigner(): Promise<Signer | null> {
  if (Platform.OS === "web") return null;
  try {
    const m = (await import("../../modules/vyre-signer")) as unknown as { signPresence?: Signer["signPresence"] };
    return typeof m.signPresence === "function" ? { signPresence: m.signPresence } : null;
  } catch { return null; }
}
