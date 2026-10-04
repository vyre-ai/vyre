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
export const peerCall = <T = unknown>(tool: string, input: Record<string, unknown> = {}): Promise<T> => peerCallOnce<T>(tool, input);

async function peerCallOnce<T = unknown>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
  let p = await openPeer();
  try { return (await p.call(tool, input)) as T; }
  catch (e) {
    const code = (e as { code?: string })?.code;
    // a lapsed paired session renews once, with the same key and no owner step (pair-challenge, then start-paired), and the call is made again
    if (code === "person_session_required" && (await renewSession())) { p = await openPeer(); return (await p.call(tool, input)) as T; }
    // a closed connection is reopened once; anything the server answered is the answer
    if (code !== "unreachable") throw e;
    peer = null;
    p = await openPeer();
    return (await p.call(tool, input)) as T;
  }
}

let renewing: Promise<boolean> | null = null;
/** Renew the paired session over a fresh channel; tells the person (src/auth/notice.js) only when it FAILS. */
export function renewSession(): Promise<boolean> {
  return (renewing ??= (async () => {
    const notice = await import("../auth/notice.js");
    try {
      const { loadPairing, relayCrypto, relayKeyStore, about, deviceName } = await import("../api/relay");
      const pairing = await loadPairing();
      if (!pairing) throw Object.assign(new Error("not paired"), { code: "unreachable" });
      const { startPaired, channelCall } = await import("../auth/paired");
      const { pairedKey } = await import("../auth/paired-key");
      const ch = await channelCall({ relay: pairing.relay, route: pairing.route, box: pairing.box, name: deviceName() }, { crypto: relayCrypto(), keyStore: relayKeyStore(), about });
      try { const k = await pairedKey(); await startPaired({ device: String(pairing.device), call: ch.call, sign: k.sign, signEnclave: k.signEnclave, label: deviceName() }); } finally { ch.close(); }
      closePeer();
      return true;
    } catch (e) { notice.noteRenewFailed((e as { code?: string })?.code); return false; }
    finally { renewing = null; }
  })());
}

/** Drop the open peer (sign out, a removed device). */
export function closePeer(): void { try { peer?.close(); } catch { /* closed */ } peer = null; }

/** The duplex the resumable stream client (core/stream/client.js) opens: a chat stream followed over the peer wire (tool stream.follow). Frames come as server messages; a send is ignored (the subscription is the open call's `from`). */
export async function peerDuplex(session: string, from: number): Promise<{ send(m: unknown): void; onMessage(cb: (m: unknown) => void): void; onClose(cb: () => void): void; close(): void; info: { viewer?: string; head?: number; floor?: number } }> {
  const p = await openPeer();
  const msg: Array<(m: unknown) => void> = [];
  const shut: Array<() => void> = [];
  let ended = false;
  const end = () => { if (ended) return; ended = true; for (const cb of shut) cb(); };
  const s = await p.openStream("stream.follow", { session, from }, { onframe: (data) => { for (const cb of msg) cb(data); }, onend: end });
  const r = (s.result ?? {}) as { viewer?: string; head?: number; floor?: number };
  return { send() {}, onMessage: (cb) => { msg.push(cb); }, onClose: (cb) => { shut.push(cb); if (ended) cb(); }, close: () => { try { s.close(); } catch { /* closed */ } end(); }, info: { viewer: r.viewer, head: r.head, floor: r.floor } };
}
