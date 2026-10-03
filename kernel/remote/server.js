// kernel/remote/server.js: the home's end of a remote kernel call. `serve(request, peer)` is what the transport (the Wink connection or the relay) hands the home: the
// request as JSON and the PEER the transport itself verified (the device's key and person). The Surfaces door here mints the chain from that peer, never from anything in
// the request, and runs the call on the home's own gateway, so `authorize`, the grants store and the home's sealing process (which verifies any presence proof carried in
// the arguments) decide exactly as they do for a local caller. A person who is not a member yet can reach only the join card and the accept.
// `peer.session` is set ONLY by a transport that has itself verified a presence session on that connection (a passkey sign-in on that device); nothing the device sends
// can supply it, and this server reads nothing but `peer` for who is calling.
import { KernelError } from "../core/errors.js";
import { CALLS, INVITEE_CALLS, WIRE_VERSION, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, REPLAY_WINDOW_MS, pathOf } from "./wire.js";

const fail = (/** @type {any} */ id, /** @type {string} */ code, /** @type {string} */ message) => ({ v: WIRE_VERSION, id, ok: false, error: { code, message } });
const MAX_STORED_BYTES = 8 * 1024 * 1024;
const INVITEE_RESPONSE_BYTES = 16 * 1024;
const RATE = Object.freeze({ member: 300, invitee: 30, window_ms: 60_000, peers: 10_000 });

/**
 * @param {{ space: string, kernel: any, clock?: () => number, rate?: { member?: number, invitee?: number } }} cfg `kernel` is the home's kernel for this Space (createKernel / bootKernel's result)
 */
export function createRemoteServer(cfg) {
  const clock = cfg.clock || Date.now;
  const k = cfg.kernel;
  const limit = { member: cfg.rate?.member ?? RATE.member, invitee: cfg.rate?.invitee ?? RATE.invitee };
  /** @type {Map<string, { at: number, bytes: number, done: boolean, p: Promise<any> }>} the calls in flight and answered, oldest first */ const seen = new Map();
  let stored = 0;
  /** @type {Map<string, number[]>} device -> the times of its recent requests */ const rate = new Map();
  const tree = (/** @type {string} */ group) => (group === "tasks" ? k.gateway.ask : group === "surfaces" ? k.surfaces : k.gateway[group]);
  /** Calls whose local signature is not `(chain, ...args)` or that need the home's own check before they run. */
  const ADAPT = {
    "surfaces.revoke": () => (/** @type {any} */ chain, /** @type {string} */ session) => k.surfaces.revoke(session, chain),
    "surfaces.open": () => async (/** @type {any} */ chain, /** @type {any} */ o = {}) => {
      // A session may name only an assistant this Space has; the chain it yields is [person, agent], so authority is still the intersection.
      if (o && o.agent !== undefined && k.grants && !k.grants.members.has({ kind: "agent", id: String(o.agent), space: cfg.space })) throw new KernelError("not_found", "no such assistant");
      return k.surfaces.open(chain, o);
    },
  };
  const resolve = (/** @type {string} */ call) => {
    const [group, ...rest] = call.split(".");
    const name = rest.join(".");
    if (!(CALLS[/** @type {keyof typeof CALLS} */ (group)] || []).includes(name)) return null;
    if (Object.hasOwn(ADAPT, call)) return { fn: /** @type {any} */ (ADAPT)[call]() };
    let fn = tree(group);
    for (const part of name.split(".")) fn = fn && Object.hasOwn(fn, part) ? fn[part] : undefined;
    return typeof fn === "function" ? { fn } : null;
  };

  /** The chain for this peer: the Surfaces door's own, from facts the transport verified. */
  async function chainFor(/** @type {any} */ peer, /** @type {string} */ call) {
    if (!peer || typeof peer.person !== "string" || !peer.person || typeof peer.device_key_id !== "string" || !peer.device_key_id) throw new KernelError("not_a_member", "no chain for this connection");
    const path = peer.path === "wink" ? "wink" : "relay"; // anything but a Wink node is the relay: the weaker surface
    if (k.gateway.members.roleOf({ kind: "person", id: peer.person, space: cfg.space }) !== null) {
      return { member: true, chain: await k.chains.fromFacts({ kind: "device", device_key_id: peer.device_key_id, person: peer.person, path, ...(typeof peer.session === "string" && peer.session && peer.session.length <= 64 ? { session: peer.session } : {}) }) };
    }
    if (!INVITEE_CALLS.has(call)) throw new KernelError("not_a_member", "no chain for this connection");
    return { member: false, chain: await k.chains.fromFacts({ kind: "invitee", person: peer.person, vouched: true }) };
  }

  /** One request counts against its device's window; the table of windows is bounded. */
  function overRate(/** @type {string} */ device, /** @type {boolean} */ member, /** @type {number} */ now) {
    let w = rate.get(device);
    if (!w) { if (rate.size >= RATE.peers) rate.delete(rate.keys().next().value); w = []; rate.set(device, w); }
    while (w.length && now - w[0] > RATE.window_ms) w.shift();
    if (w.length >= (member ? limit.member : limit.invitee)) return true;
    w.push(now);
    return false;
  }

  function forget(/** @type {number} */ now) {
    for (const [key, v] of seen) { if (v.done && now - v.at > REPLAY_WINDOW_MS * 2) { stored -= v.bytes; seen.delete(key); } else break; }
    while (stored > MAX_STORED_BYTES) {
      const old = [...seen].find(([, v]) => v.done);
      if (!old) break;
      stored -= old[1].bytes; seen.delete(old[0]);
    }
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
        if (!(Math.abs(now - Number(request.ts)) <= REPLAY_WINDOW_MS)) return fail(id, "stale", "that call is outside its window");
        const target = resolve(request.call);
        if (!target) return fail(id, "no_such_call", "no such call");
        const who = await chainFor(peer, request.call);
        if (overRate(peer.device_key_id, who.member, now)) return fail(id, "rate_limited", "too many calls; wait a moment");
        // A repeat of the same call from the same device, even one that arrives while the first is still running, shares the first one's answer and never runs twice;
        // another device's repeat is its own call.
        const dedupe = `${peer.device_key_id}:${id}`;
        const prior = seen.get(dedupe);
        if (prior) return await prior.p;
        const cap = who.member ? MAX_RESPONSE_BYTES : INVITEE_RESPONSE_BYTES;
        const entry = { at: now, bytes: 0, done: false, p: /** @type {Promise<any>} */ (Promise.resolve()) };
        entry.p = (async () => {
          try {
            const result = await target.fn(who.chain, ...request.args);
            const out = JSON.stringify(result === undefined ? null : result);
            return out.length > cap ? fail(id, "too_large", "that answer is too large") : { v: WIRE_VERSION, id, ok: true, result: JSON.parse(out) };
          } catch (e) {
            // Only the code and the message cross; a reason the kernel kept hidden stays in the home's log.
            const err = /** @type {any} */ (e);
            return fail(id, err && typeof err.code === "string" ? err.code : "unavailable", err && err instanceof KernelError ? err.message : "the home could not do that");
          }
        })();
        seen.set(dedupe, entry);
        const response = await entry.p;
        entry.done = true; entry.bytes = JSON.stringify(response).length; stored += entry.bytes;
        forget(now);
        return response;
      } catch (e) {
        const err = /** @type {any} */ (e);
        return fail(id, err && typeof err.code === "string" ? err.code : "unavailable", err && err instanceof KernelError ? err.message : "the home could not do that");
      }
    },
  });
}
export { pathOf };
