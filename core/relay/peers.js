// @ts-check
// peers: the wink peer door the relay bridge is given for each device channel (bridge.js `peers`).
//
// The relay module cannot import the wink module (boundaries), and the bridge needs two functions of it: `allow(deviceId)`, synchronous, from the wink module's
// device registry, and `accept(stream, who)`, from the node host. The composition root (the platform, which owns the host) therefore sets `ctx.peerDoor`, a
// function answering `{ space, allow, accept }` (core/wink/index.js `peerDoor({ wink, host, space })` builds it from the wink module's `peers` seam and
// `host.acceptRelay(space)`). The relay module reads it per channel, so a door that appears after the relay started is used from the next channel on, and a box
// with no door refuses peer streams exactly as before. No tool call is needed: allow must answer synchronously.

/**
 * @param {any} ctx
 * @returns {{ space: string, allow: (deviceId: string) => boolean, accept: (stream: any, who: any) => void } | undefined}
 */
export function peersFor(ctx) {
  const f = ctx && ctx.peerDoor;
  if (typeof f !== "function") return undefined;
  let d;
  try { d = f(); } catch { return undefined; }
  if (!d || typeof d.space !== "string" || typeof d.allow !== "function" || typeof d.accept !== "function") return undefined;
  return d;
}

/**
 * The invitee door: `acceptInvitee(stream, who, head)` of the same `ctx.peerDoor()`, or undefined. @param {any} ctx @returns {{ acceptInvitee: (stream: any, who: { inviteeId: string }, head: any) => void } | undefined}
 */
export function inviteesFor(ctx) {
  const f = ctx && ctx.peerDoor;
  if (typeof f !== "function") return undefined;
  let d;
  try { d = f(); } catch { return undefined; }
  return d && typeof d.acceptInvitee === "function" ? d : undefined;
}

/**
 * The server door: `acceptServer(stream, { serverId })` and `isServer(id)` of the same `ctx.peerDoor()`, or undefined. A paired server of this home reaches it through the relay when the direct path is down
 * and may read the network's status there, nothing else. @param {any} ctx
 * @returns {{ space: string, isServer: (id: string) => boolean, acceptServer: (stream: any, who: { serverId: string }) => void } | undefined}
 */
export function serversFor(ctx) {
  const f = ctx && ctx.peerDoor;
  if (typeof f !== "function") return undefined;
  let d;
  try { d = f(); } catch { return undefined; }
  return d && typeof d.acceptServer === "function" && typeof d.isServer === "function" && typeof d.space === "string" ? d : undefined;
}
