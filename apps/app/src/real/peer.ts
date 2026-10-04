// A device paired to a server over the relay (the user's install order: identity first, then the server) calls the server's tools over the PEER wire (relay/client/peerclient.js, wink-2):
// the server runs each call as this device with the device's own paired session as the person, so no token and no label ride in the call. The pairing is kept by pairing.ts (savePairing)
// and `usePeer(true)` marks it as the way this device reaches its server; a device with a box of its own (a Mac, the box's own origin) never sets it.

import type { Peer } from "@vyre/relay-client/peerclient.js";

const FLAG = "vyre.peer";
let peer: Peer | null = null;
let opening: Promise<Peer> | null = null;

/** Mark (or unmark) this device as one that reaches its server over the peer wire. */
export function usePeer(on: boolean): void {
  try { if (on) localStorage.setItem(FLAG, "1"); else localStorage.removeItem(FLAG); } catch { /* storage refused: the flag lives for this page only */ memoryFlag = on; }
}
let memoryFlag = false;
export const peerWanted = (): boolean => { try { return localStorage.getItem(FLAG) === "1" || memoryFlag; } catch { return memoryFlag; } };

/** The open peer, opened from the saved pairing on first use and again after a close. */
export async function openPeer(): Promise<Peer> {
  if (peer && !peer.closed) return peer;
  if (opening) return opening;
  opening = (async () => {
    const { loadPairing, relayCrypto, relayKeyStore, about, deviceName } = await import("../api/relay");
    const pairing = await loadPairing();
    if (!pairing) throw Object.assign(new Error("This device is not paired to a server."), { code: "unreachable" });
    const mod = (await import("@vyre/relay-client/client.js")) as unknown as { connect: (o: unknown) => { ready(): Promise<unknown> } };
    const { openServerPeer } = await import("@vyre/relay-client/peerclient.js");
    const conn = mod.connect({ relay: pairing.relay, route: pairing.route, box: pairing.box, name: deviceName(), crypto: relayCrypto(), keyStore: relayKeyStore(), about });
    peer = await openServerPeer(conn as { ready(): Promise<any> });
    return peer;
  })().finally(() => { opening = null; });
  return opening;
}

/** One tool call over the peer wire. Resolves the tool's data; rejects with { code, message } in the server's words. */
export async function peerCall<T = unknown>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
  let p = await openPeer();
  try { return (await p.call(tool, input)) as T; }
  catch (e) {
    // a closed connection is reopened once; anything the server answered is the answer
    if ((e as { code?: string })?.code !== "unreachable") throw e;
    peer = null;
    p = await openPeer();
    return (await p.call(tool, input)) as T;
  }
}

/** Drop the open peer (sign out, a removed device). */
export function closePeer(): void { try { peer?.close(); } catch { /* closed */ } peer = null; }
