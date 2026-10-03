// @ts-check
// composeWinkHome: the one function the daemon calls to put the Wink home together (platform's ask, team/0.2/CHAT.md "three wiring seams", item 3). The composition
// root owns the node host (the forwarder program, the state directories, the control URL), so it builds the host and passes it in; this builds everything that hangs off
// it and returns the pieces to wire:
//
//   const w = composeWinkHome({ ctx, host, kernel, wink, space, serve, identity });
//   ctx.peerDoor is now set (the relay module's bridge reads it); then
//   await w.serveHome({ ... })   or   host.serveHome(space, { identity, serve: w.serve, relayServe: w.serve, onSession: w.holdsOnSession })
//   createWink({ handover: w.handover })     the app side's seam: what a server needs to find its home
//   withKernelCall(serve, { serverFor, personOf, pathOf: w.pathOf })   (done for you when `kernel.withKernelCall` is given)
//
// Secrets: the server's own hand-over (auth key, peer secret) is read in-process from the Wink module (`wink.ownHandover()`, not a tool), and goes to the node host and
// nobody else (reviewer-3's H-1: `wink.server.handover` answers only the Wink module). `own()` returns it for the daemon to start the node with.

import { peerDoor } from "./index.js";

const err = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * @param {{
 *   ctx?: any,
 *   host: { acceptRelay(space: string): (stream: any, who: any) => void, serveHome(space: string, o: any): Promise<void>, pathOf: (caller?: string) => "wink" | "relay" },
 *   kernel?: { withKernelCall?: (next: any, o: any) => any, serverFor?: (space: string) => any, personOf?: (device: string, space: string) => any },
 *   wink?: any,
 *   space: string,
 *   serve?: (caller: string, tool: string, input: any) => Promise<any>,
 *   identity?: { entry: (eid: string) => any },
 *   handoverSource?: (q: { target: { kind: string, id: string }, device: string }) => Promise<any> | any,
 * }} o
 *   ctx: the relay module's context (its `peerDoor` is set here). host: the node host (core/wink/node/host.js createHost). kernel: the kernel's wrapper and its two ports
 *   (optional: with none, `serve` is the registry's dispatcher as given). wink: the loaded wink module (`ctx.wink` when absent). space: this home's space id.
 *   serve: the registry's dispatcher, `(caller, tool, input)` as that caller. identity: the live identity list port (`entry(eid)`), needed to serve peers.
 *   handoverSource: how the home mints what a new server needs (its control URL, a one-time join key, its box id and relay); the answer goes to the app side's `handover` seam.
 */
export function composeWinkHome(o) {
  if (!o || !o.host) throw err("bad_input", "composeWinkHome needs the node host");
  if (!o.space) throw err("bad_input", "composeWinkHome needs the space this home serves");
  const wink = o.wink || (o.ctx && o.ctx.wink);
  if (!wink) throw err("bad_input", "composeWinkHome needs the wink module");
  const host = o.host, kernel = o.kernel || {};
  const door = () => peerDoor({ wink, host, space: o.space });
  if (o.ctx) o.ctx.peerDoor = door;
  const inner = o.serve;
  const pathOf = (/** @type {string} */ c) => host.pathOf(c);
  const serve = inner && typeof kernel.withKernelCall === "function" && kernel.serverFor && kernel.personOf
    ? kernel.withKernelCall(inner, { serverFor: kernel.serverFor, personOf: kernel.personOf, pathOf })
    : inner;
  /** The held connections' hook (a drive's device holds one open to this home): the node host's serveHome `onSession`. */
  const holdsOnSession = (/** @type {string} */ caller, /** @type {any} */ session) => wink.holds.onSession(caller, session);
  /** The app side's `handover` seam for createWink: what a server being paired needs to reach this home, or null (the pairing then hands over only the device id). */
  const handover = async (/** @type {{ target: { kind: string, id: string }, device: string }} */ q) => (o.handoverSource ? o.handoverSource(q) : null);
  return {
    peerDoor: door,
    handover,
    holdsOnSession,
    pathOf,
    serve,
    /** Start answering peers for this space: direct through the forwarder's door and relay through acceptRelay, both through `serve`. @param {any} [extra] */
    async serveHome(extra = {}) {
      if (!o.identity || typeof o.identity.entry !== "function") throw err("bad_input", "serving peers needs the identity list (identity.entry)");
      if (typeof serve !== "function") throw err("bad_input", "serving peers needs the registry's dispatcher (serve)");
      return host.serveHome(o.space, { identity: o.identity, serve, relayServe: serve, onSession: holdsOnSession, ...extra });
    },
    /** This server's own hand-over with its secrets (Wink's in-process read, never a tool): { home, box, controlUrl, authKey, relay, space, device, peerSecret } or null. */
    own: () => wink.ownHandover(),
    stop() { if (o.ctx && o.ctx.peerDoor === door) o.ctx.peerDoor = undefined; },
  };
}
