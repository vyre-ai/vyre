// The servers this device can make a Space on: its own pairings where it is paired to servers itself (a phone, a browser, Windows), what its daemon is paired to on the Mac.
import { choicesFromDaemon, choicesFromPairings, type Choice } from "./server-choices.js";
import { peerWanted } from "./peer";
import { tool } from "./box";

export type { Choice };

export async function listServers(): Promise<Choice[]> {
  if (peerWanted()) {
    const { listPairings } = await import("../api/relay");
    const { listAllSpaces } = await import("./space-servers");
    const [pairings, spaces] = await Promise.all([listPairings(), listAllSpaces().catch(() => null)]);
    return choicesFromPairings(pairings, spaces ?? []);
  }
  return choicesFromDaemon(await tool("spaces.servers").catch(() => null));
}
