// The app's one call to make a space on the server this device is paired to (claimServerSpace, identity/claim-space.js, with its three inputs filled in from what the app keeps):
//   - the stored route: loadPairing() { relay, route, box }, where the paired server is reached;
//   - the paired session: `tool` (box.ts) goes over the peer wire as this device with its own paired session as the person, renewed once on a lapse (peer.ts peerCall);
//   - the presence proof: spaces.host-here is a person-only act, so `tool` answers its presence_required with the passkey or the phone's proof, exactly as for any other act.
// The screen shows `said(e)` for a refusal; a name taken at the directory takes the hosted space back (spaces.retire-here).

import { claimServerSpace } from "../identity/claim-space.js";
import { loadIdentity } from "../identity/store";
import { tool } from "./box";

const DIRECTORY = (process.env.EXPO_PUBLIC_VYRE_NAMES_DIRECTORY || "https://names.vyre.run").replace(/\/+$/, "");

export async function makeSpaceOnPairedServer(o: { name: string; displayName?: string; acceptBuiltinStore?: boolean }) {
  const { loadPairing } = await import("../api/relay");
  const [mine, pairing] = await Promise.all([loadIdentity().catch(() => null), loadPairing()]);
  if (!pairing) throw Object.assign(new Error("This device is not paired to a server."), { code: "unreachable" });
  if (!mine) throw Object.assign(new Error("Choose your Vyre name first."), { code: "no_identity" });
  return claimServerSpace({
    identity: { id: mine.id, name: mine.name, eid: mine.eid, ops: mine.ops as any[], key: mine.key },
    name: o.name, displayName: o.displayName, base: DIRECTORY,
    route: { relay: pairing.relay, route: pairing.route, box: pairing.box },
    host: ({ name }) => tool<{ space: string }>("spaces.host-here", { name, ...(o.acceptBuiltinStore ? { acceptBuiltinStore: true } : {}) }),
    retire: (space) => tool("spaces.retire-here", { id: space }),
  });
}
