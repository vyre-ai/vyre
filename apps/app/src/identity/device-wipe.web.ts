import { forgetIdentity } from "./store";
import { webSteps } from "./wipe-web.js";
import type { WipeStep } from "./wipe.js";

export const deviceSteps = (): WipeStep[] => [
  // the identity store keeps the key in memory too; the database deletion below takes the stored copy
  { name: "identity in memory", run: () => forgetIdentity() },
  ...webSteps(globalThis),
];

/** The page's in-memory state (stores, the open peer, the person session) is all from before the wipe: a reload starts clean, at the screen that pairs again. */
export function afterWipe(): void {
  try { sessionStorage.setItem("vyre.removed", "1"); } catch { /* storage refused: the reload still lands on the pairing screen */ }
  globalThis.location?.reload();
}
