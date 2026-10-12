// A device paired to a server over the relay (the user's install order: identity first, then the server) calls the server's tools over the PEER wire (relay/client/peerclient.js, wink-2):
// the server runs each call as this device with the device's own paired session as the person, so no token and no label ride in the call. The pairing is kept by pairing.ts (savePairing)
// and `usePeer(true)` marks it as the way this device reaches its server; a device with a box of its own (a Mac, the box's own origin) never sets it.

import type { Peer } from "@vyre/relay-client/peerclient.js";

const FLAG = "vyre.peer";
/** One open peer per server this device is paired to, by the server's box id (Pairing.box). */
const peers = new Map<string, Peer>();
const opening = new Map<string, Promise<Peer>>();

/** Mark (or unmark) this device as one that reaches its server over the peer wire. */
export function usePeer(on: boolean): void {
  try { if (on) localStorage.setItem(FLAG, "1"); else localStorage.removeItem(FLAG); } catch { /* storage refused: the flag lives for this page only */ memoryFlag = on; }
}
let memoryFlag = false;
export const peerWanted = (): boolean => { try { return localStorage.getItem(FLAG) === "1" || memoryFlag; } catch { return memoryFlag; } };

/** The saved pairing of the server named (its box id), or of the active one when none is named. A named server this device is not paired to is refused with the next step, never answered by another server. */
/** The box id that means "the active server, on purpose": tool() has already routed the call and found no server to name, so it must not be routed again. */
export const ACTIVE = "@active";

async function pairingOf(box?: string) {
  const { loadPairing, loadPairingFor } = await import("../api/relay");
  const pairing = box && box !== ACTIVE ? await loadPairingFor(box) : await loadPairing();
  if (!pairing) throw Object.assign(new Error(box ? "This device is not paired to that server. Add it in Settings, Servers, then try again." : "This device is not paired to a server."), { code: box ? "server_not_paired" : "unreachable" });
  return pairing;
}

/** The open peer for a server, opened from its saved pairing on first use and again after a close. No server named means the active one. */
export async function openPeer(box?: string): Promise<Peer> {
  const pairing = await pairingOf(box);
  const id = pairing.box;
  const have = peers.get(id);
  if (have && !have.closed) return have;
  const pending = opening.get(id);
  if (pending) return pending;
  const p = (async () => {
    const { relayCrypto, relayKeyStore, about, deviceName } = await import("../api/relay");
    const mod = (await import("@vyre/relay-client/client.js")) as unknown as { connect: (o: unknown) => { ready(): Promise<unknown> } };
    const { openServerPeer } = await import("@vyre/relay-client/peerclient.js");
    const conn = mod.connect({ relay: pairing.relay, route: pairing.route, box: pairing.box, name: deviceName(), crypto: relayCrypto(), keyStore: relayKeyStore(), about });
    const opened = await openServerPeer(conn as { ready(): Promise<any> });
    peers.set(id, opened);
    return opened;
  })().finally(() => { opening.delete(id); });
  opening.set(id, p);
  return p;
}

/**
 * A stand-in for the peer wire, for the proof page that drives the real screens and the real routing against two pretend servers (app/two-servers-proof.tsx). Never set by the app itself. It is asked
 * (tool, input, box id) after the box id is resolved, so a call that reaches the wrong server is seen.
 */
let fake: ((tool: string, input: Record<string, unknown>, box: string) => Promise<unknown>) | null = null;
export function setPeerFake(f: typeof fake): void { fake = f; }

/** One tool call over the peer wire, to the server named (its box id) or the active one. Resolves the tool's data; rejects with { code, message } in the server's words. */
export const peerCall = <T = unknown>(tool: string, input: Record<string, unknown> = {}, box?: string): Promise<T> => peerCallOnce<T>(tool, input, box);

async function peerCallOnce<T = unknown>(tool: string, input: Record<string, unknown> = {}, box?: string): Promise<T> {
  // A call that names no server (a screen's direct call, not tool()) is routed here, so no path to a server skips the rule: it goes to the server of its Space, its chat or its approval, or is refused.
  if (!box) {
    const { routeCall } = await import("./space-servers");
    const showing = (await import("../../screens/shell/state")).useSpaces.getState().space;
    const route = await routeCall({ tool, input, showing });
    if (route.error) throw Object.assign(new Error(route.error.message), { code: route.error.code });
    box = route.box ?? ACTIVE;
  }
  const id = (await pairingOf(box)).box;
  if (fake) return (await fake(tool, input, id)) as T;
  let p = await openPeer(id);
  try { return (await p.call(tool, input)) as T; }
  catch (e) {
    const code = (e as { code?: string })?.code;
    // the relay says the owner removed this device: it forgets everything it held and pairs again (a refused sign-in or an unreachable server never does this)
    if (code === "relay_removed") { await (await import("../identity/removed")).ifRemoved(code); throw e; }
    // a lapsed paired session renews once, with the same key and no owner step (pair-challenge, then start-paired), and the call is made again
    if (code === "person_session_required" && (await renewSession(id))) { p = await openPeer(id); return (await p.call(tool, input)) as T; }
    // a closed connection is reopened once; anything the server answered is the answer
    if (code !== "unreachable") throw e;
    peers.delete(id);
    p = await openPeer(id);
    return (await p.call(tool, input)) as T;
  }
}

const renewing = new Map<string, Promise<boolean>>();
/** Renew a server's paired session over a fresh channel (the active server's when none is named); tells the person (src/auth/notice.js) only when it FAILS. */
export function renewSession(box?: string): Promise<boolean> {
  const key = box ?? "";
  const going = renewing.get(key);
  if (going) return going;
  const run = (async () => {
    const notice = await import("../auth/notice.js");
    try {
      const pairing = await pairingOf(box);
      const id = pairing.box;
      const { relayCrypto, relayKeyStore, about, deviceName } = await import("../api/relay");
      const { startPaired, channelCall } = await import("../auth/paired");
      const { pairedKey } = await import("../auth/paired-key");
      const ch = await channelCall({ relay: pairing.relay, route: pairing.route, box: pairing.box, name: deviceName() }, { crypto: relayCrypto(), keyStore: relayKeyStore(), about });
      try { const k = await pairedKey(); await startPaired({ device: String(pairing.device), call: ch.call, sign: k.sign, signEnclave: k.signEnclave, label: deviceName() }); } finally { ch.close(); }
      closePeer(id);
      return true;
    } catch (e) { notice.noteRenewFailed((e as { code?: string })?.code); return false; }
    finally { renewing.delete(key); }
  })();
  renewing.set(key, run);
  return run;
}

/** Drop the open peer of one server, or every open peer when none is named (sign out, a removed device). */
export function closePeer(box?: string): void {
  for (const [id, p] of [...peers]) { if (box && id !== box) continue; try { p.close(); } catch { /* closed */ } peers.delete(id); }
}

/** The duplex the resumable stream client (core/stream/client.js) opens: a chat stream followed over the peer wire (tool stream.open-peer { chat, from }, answering { stream, chat, session, viewer, head, floor }). Frames come as server messages; a send is ignored (the subscription is the open call's `from`). */
export async function peerDuplex(session: string, from: number, box?: string): Promise<{ send(m: unknown): void; onMessage(cb: (m: unknown) => void): void; onClose(cb: () => void): void; close(): void; info: { viewer?: string; head?: number; floor?: number } }> {
  const p = await openPeer(box);
  const msg: Array<(m: unknown) => void> = [];
  const shut: Array<() => void> = [];
  let ended = false;
  const end = () => { if (ended) return; ended = true; for (const cb of shut) cb(); };
  const s = await p.openStream("stream.open-peer", { chat: session, from }, { onframe: (data) => { for (const cb of msg) cb(data); }, onend: end });
  const r = (s.result ?? {}) as { viewer?: string; head?: number; floor?: number };
  return { send() {}, onMessage: (cb) => { msg.push(cb); }, onClose: (cb) => { shut.push(cb); if (ended) cb(); }, close: () => { try { s.close(); } catch { /* closed */ } end(); }, info: { viewer: r.viewer, head: r.head, floor: r.floor } };
}
