// Whether this device has a server to talk to: the same test the first-run gate (src/shell/SetupGate.tsx) makes. A sample build and a browser page served by its own box always do; a phone, and the Mac app's
// window with no vyred of its own, do once a pairing is saved (or a box address is configured in a dev build).
import { Platform } from "react-native";
import { MOCK } from "../../src/real/box";

export async function hasServer(): Promise<boolean> {
  try {
    const [{ loadPairing }, { boxOrigin }, { isBoxless }] = await Promise.all([import("../../src/api/relay"), import("../../src/api/box"), import("../../src/shell/shell")]);
    const gated = !MOCK && (Platform.OS !== "web" || isBoxless());
    if (!gated) return true;
    return !!(await loadPairing()) || (Platform.OS !== "web" && !!boxOrigin());
  } catch { return true; } // unreadable: assume there is one, so nothing is rerouted on a guess
}
