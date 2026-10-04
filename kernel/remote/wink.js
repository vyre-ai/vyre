// kernel/remote/wink.js: the two ends of the remote kernel call over Wink's peer wire (core/wink/node/peer-wire.js), direct or through the relay. The peer wire carries
// `call` frames {tool, input} to the home's registry as the device the connection proved (`device:<id>`), on either path, and returns {ok, data}. A kernel call is one such tool,
// `kernel.call`, whose input is the wire request (kernel/remote/wire.js). Nothing here imports the wink module: both ends take the session or the dispatcher as a port.
//
//   device:  createRemoteKernel({ space, transport: winkTransport({ sessionFor }) })     sessionFor(space) -> { call(tool, input) } (a peerSession to that Space's home)
//   home:    serve = withKernelCall(serve, { serverFor, personOf })                      wrap the dispatcher the peer door hands (caller, tool, input)
//
// WHO is calling is the proven device (`caller`), mapped to a person by `personOf` from the Space's identity chain (the device list is signed by the owner's devices); the
// home never reads a person or a session from the request. A device that no chain vouches for as a person's gets a `not_a_member` answer.
import { WIRE_VERSION } from "./wire.js";

export const KERNEL_CALL_TOOL = "kernel.call";
const DEVICE = /^device:([A-Za-z0-9_-]{1,64})$/;

/** The device's transport port. @param {{ sessionFor: (space: string) => Promise<{ call: (tool: string, input: any) => Promise<any> }> | { call: (tool: string, input: any) => Promise<any> } }} o */
export function winkTransport(o) {
  return {
    async send(/** @type {string} */ space, /** @type {any} */ request) {
      const session = await o.sessionFor(space);
      return session.call(KERNEL_CALL_TOOL, request);
    },
  };
}

/**
 * The home's end: wrap the peer door's dispatcher so `kernel.call` goes to the Space's remote server with the proven device as peer, and every other tool is the registry's, as before.
 * @param {(caller: string, tool: string, input: any) => Promise<any>} next
 * @param {{ serverFor: (space: string) => { serve(request: any, peer: any): Promise<any> } | null | undefined,
 *   personOf: (device: string, space: string) => Promise<string | null | undefined> | string | null | undefined, sessionOf?: (device: string) => Promise<string | { id: string, software?: boolean } | null | undefined> | string | { id: string, software?: boolean } | null | undefined, pathOf: (caller: string) => "wink" | "relay" }} o
 *   `sessionOf(device)` (optional) answers the id of the live paired person session this device holds on this home (the one start-paired made, bound to the device's key and person), or null. It is
 *   asked on every call and the id goes to the server as `peer.session` ONLY while it is live: a call with no session has none, and one that was revoked or expired has none at its next call.
 *   `pathOf` is REQUIRED: the chain records how the call arrived (a Wink node, or the relay surface), and a grant pinned to a node must not be satisfiable by a relay call.
 *   An answer other than "wink" is taken as the relay. `personOf` is read on every call and must read the identity chain's live device list, so a removed device maps to
 *   nobody at its very next call; nothing here caches it.
 */
export function withKernelCall(next, o) {
  if (!o || typeof o.pathOf !== "function") throw new Error("withKernelCall needs pathOf: say which path this dispatcher serves");
  return async (caller, tool, input) => {
    if (tool !== KERNEL_CALL_TOOL) return next(caller, tool, input);
    const id = input && typeof input.id === "string" ? input.id.slice(0, 64) : null;
    const refuse = (/** @type {string} */ code, /** @type {string} */ message) => ({ v: WIRE_VERSION, id, ok: false, error: { code, message } });
    const m = DEVICE.exec(String(caller));
    const space = input && typeof input.space === "string" ? input.space : "";
    const server = m && space ? o.serverFor(space) : null;
    if (!m) return refuse("not_a_member", "no chain for this connection");
    if (!server) return refuse("not_found", "no such space here");
    let person = null;
    try { person = await o.personOf(m[1], space); } catch { /* no person */ }
    if (typeof person !== "string" || !person) return refuse("not_a_member", "no chain for this connection");
    /** @type {any} */ let held = null;
    if (typeof o.sessionOf === "function") { try { held = await o.sessionOf(m[1]); } catch { held = null; } }
    const session = typeof held === "string" ? held : held && typeof held.id === "string" ? held.id : "";
    return server.serve(input, { device_key_id: m[1], person, path: o.pathOf(String(caller)) === "wink" ? "wink" : "relay", ...(session ? { session } : {}), ...(session && held && held.software === true ? { software: true } : {}) });
  };
}
