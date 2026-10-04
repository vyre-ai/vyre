// The app's one call to make a space on the server this device is paired to (claimServerSpace, identity/claim-space.js, with its three inputs filled in from what the app keeps):
//   - the stored route: loadPairing() { relay, route, box }, where the paired server is reached;
//   - the paired session: `tool` (box.ts) goes over the peer wire as this device with its own paired session as the person, renewed once on a lapse (peer.ts peerCall);
//   - the presence proof: spaces.host-here is a person-only act, so `tool` answers its presence_required with the passkey or the phone's proof, exactly as for any other act.
// The screen shows `said(e)` for a refusal; a name taken at the directory takes the hosted space back (spaces.retire-here).

import { claimServerSpace } from "../identity/claim-space.js";
import { loadIdentity } from "../identity/store";
import { tool } from "./box";

const DIRECTORY = (process.env.EXPO_PUBLIC_VYRE_NAMES_DIRECTORY || "https://names.vyre.run").replace(/\/+$/, "");

/** The stored route: where this device reaches its paired server. Throws unreachable when not paired. */
export async function pairedRoute(): Promise<{ relay: string; route: string; box: string }> {
  const { loadPairing } = await import("../api/relay");
  const p = await loadPairing();
  if (!p) throw Object.assign(new Error("This device is not paired to a server."), { code: "unreachable" });
  return { relay: p.relay, route: p.route, box: p.box };
}

/** The paired session plus the presence proof: spaces.host-here over the peer wire as this device's paired session (renewed once on a lapse), and the proof answered as for any person-only act. Answers { space }. */
export const hostOnPairedServer = (name: string, o: { acceptBuiltinStore?: boolean } = {}) =>
  tool<{ space: string; rootPublic?: string }>("spaces.host-here", { name, ...(o.acceptBuiltinStore ? { acceptBuiltinStore: true } : {}) });

/** Takes back a space the server started for a claim the directory refused. */
export const retireOnPairedServer = (space: string) => tool("spaces.retire-here", { id: space });

export async function makeSpaceOnPairedServer(o: { name: string; displayName?: string; acceptBuiltinStore?: boolean }) {
  const [mine, route] = await Promise.all([loadIdentity().catch(() => null), pairedRoute()]);
  if (!mine) throw Object.assign(new Error("Choose your Vyre name first."), { code: "no_identity" });
  return claimServerSpace({
    identity: { id: mine.id, name: mine.name, eid: mine.eid, ops: mine.ops as any[], key: mine.key },
    name: o.name, displayName: o.displayName, base: DIRECTORY,
    route,
    host: ({ name }) => hostOnPairedServer(name, o),
    retire: retireOnPairedServer,
  });
}
