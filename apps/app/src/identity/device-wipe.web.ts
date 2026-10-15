import { forgetIdentity } from "./store";
import { webSteps } from "./wipe-web.js";
import { shellRelayBridge } from "../api/shell-relay-key.js";
import type { WipeStep } from "./wipe.js";

export const deviceSteps = (): WipeStep[] => [
  // the identity store keeps the key in memory too; the database deletion below takes the stored copy
  { name: "identity in memory", run: () => forgetIdentity() },
  // the Mac app's relay key lives in the Mac's Keychain, not in this page's storage: the shell drops it (a browser has none to drop)
  { name: "relay key on this Mac", run: async () => { await shellRelayBridge()?.forget?.(); } },
  ...webSteps(globalThis),
];

/** The page's in-memory state (stores, the open peer, the person session) is all from before the wipe: a reload starts clean, at the screen that pairs again. */
export function afterWipe(): void {
  try { sessionStorage.setItem("vyre.removed", "1"); } catch { /* storage refused: the reload still lands on the pairing screen */ }
  globalThis.location?.reload();
}
