// "Forget this Mac": forget-mac-model.js with the Mac app's own pieces. Rejects with the shell's words when the person says no, or when this page runs outside the Mac or Windows app.
import { forgetThisMac } from "./forget-mac-model.js";

export async function forgetThisMacHere(): Promise<{ servers: string[] }> {
  const { shellIdentity } = await import("../shell/shell");
  const id = shellIdentity();
  if (!id) throw Object.assign(new Error("Only the Mac or Windows app keeps a key for this computer."), { code: "no_shell" });
  const { listPairings } = await import("../api/relay");
  const { wipeAll } = await import("./wipe.js");
  const { deviceSteps, afterWipe } = await import("./device-wipe");
  return forgetThisMac({ forget: (servers) => id.forget(servers), pairings: listPairings, wipe: () => wipeAll(deviceSteps()), after: afterWipe });
}
