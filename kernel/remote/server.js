// kernel/remote/server.js: the home's end of a remote kernel call. `serve(request, peer)` is what the transport (the Wink connection or the relay) hands the home: the
// request as JSON and the PEER the transport itself verified (the device's key and person). The Surfaces door here mints the chain from that peer, never from anything in
// the request, and runs the call on the home's own gateway, so `authorize`, the grants store and the home's sealing process (which verifies any presence proof carried in
// the arguments) decide exactly as they do for a local caller. A person who is not a member yet can reach only the join card and the accept.
import { KernelError } from "../core/errors.js";
import { CALLS, INVITEE_CALLS, WIRE_VERSION, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, REPLAY_WINDOW_MS, pathOf } from "./wire.js";

const fail = (/** @type {any} */ id, /** @type {string} */ code, /** @type {string} */ message) => ({ v: WIRE_VERSION, id, ok: false, error: { code, message } });

/**
 * @param {{ space: string, kernel: any, clock?: () => number }} cfg `kernel` is the home's kernel for this Space (createKernel / bootKernel's result)
 */
export function createRemoteServer(cfg) {
  const clock = cfg.clock || Date.now;
  const k = cfg.kernel;
  /** @type {Map<string, { at: number, response: any }>} */ const seen = new Map();
  const tree = (/** @type {string} */ group) => (group === "tasks" ? k.gateway.ask : group === "surfaces" ? k.surfaces : k.gateway[group]);
  const resolve = (/** @type {string} */ call) => {
    const [group, ...rest] = call.split(".");
    const name = rest.join(".");
    if (!(CALLS[/** @type {keyof typeof CALLS} */ (group)] || []).includes(name)) return null;
    let fn = tree(group);
    for (const part of name.split(".")) fn = fn && Object.hasOwn(fn, part) ? fn[part] : undefined;
    return typeof fn === "function" ? { fn, group, name } : null;
  };

  /** The chain for this peer: the Surfaces door's own, from facts the transport verified. */
  function chainFor(/** @type {any} */ peer, /** @type {string} */ call) {
    if (!peer || typeof peer.person !== "string" || typeof peer.device_key_id !== "string") throw new KernelError("not_a_member", "no chain for this connection");
    const path = peer.path === "relay" ? "relay" : "wink";
    if (k.gateway.members.roleOf({ kind: "person", id: peer.person, space: cfg.space }) !== null) return k.chains.fromFacts({ kind: "device", device_key_id: peer.device_key_id, person: peer.person, path, ...(peer.session ? { session: String(peer.session) } : {}) });
    if (!INVITEE_CALLS.has(call)) throw new KernelError("not_a_member", "no chain for this connection");
    return k.chains.fromFacts({ kind: "invitee", person: peer.person, vouched: true });
  }

  return Object.freeze({
    /** @param {any} request @param {{ device_key_id: string, person: string, path?: string, session?: string }} peer what the transport verified */
    async serve(request, peer) {
      const id = request && typeof request.id === "string" ? request.id.slice(0, 64) : null;
      try {
        if (!request || request.v !== WIRE_VERSION || typeof request.call !== "string" || !Array.isArray(request.args) || typeof id !== "string" || !id) return fail(id, "bad_input", "not a kernel call");
        if (request.space !== cfg.space) return fail(id, "not_found", "no such space here");
        if (JSON.stringify(request).length > MAX_REQUEST_BYTES) return fail(id, "too_large", "that call is too large");
        const now = clock();
        for (const [key, v] of seen) if (now - v.at > REPLAY_WINDOW_MS * 2) seen.delete(key);
        if (!(Math.abs(now - Number(request.ts)) <= REPLAY_WINDOW_MS)) return fail(id, "stale", "that call is outside its window");
        // A repeat of the same call from the same device is answered from the first answer and never run twice; another device's repeat finds nothing.
        const dedupe = `${peer && peer.device_key_id}:${id}`;
        const prior = seen.get(dedupe);
        if (prior) return prior.response;
        const target = resolve(request.call);
        if (!target) return fail(id, "no_such_call", "no such call");
        const chain = chainFor(peer, request.call);
        const result = await target.fn(chain, ...request.args);
        const out = JSON.stringify(result === undefined ? null : result);
        const response = out.length > MAX_RESPONSE_BYTES ? fail(id, "too_large", "that answer is too large") : { v: WIRE_VERSION, id, ok: true, result: JSON.parse(out) };
        seen.set(dedupe, { at: now, response });
        return response;
      } catch (e) {
        // Only the code and the message cross; a reason the kernel kept hidden stays in the home's log.
        const err = /** @type {any} */ (e);
        return fail(id, err && typeof err.code === "string" ? err.code : "unavailable", err && err instanceof KernelError ? err.message : "the home could not do that");
      }
    },
  });
}
export { pathOf };
