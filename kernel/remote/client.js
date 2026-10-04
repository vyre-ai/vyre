// kernel/remote/client.js: the device's end of a remote kernel call. `createRemoteKernel` returns the same gateway API a hosted Space has (grants, records, tasks,
// events and the Surfaces door), so a caller does not care where the Space lives: every call is `(chain, ...args)` as locally. The chain argument never leaves the
// device and carries no authority there: the home mints the chain from the identity the transport proved, and `authorize` runs at the home. Nothing a home answers
// is trusted here: a reply is plain JSON, and the only thing kept is a MARKED copy of reads for the device's own screens (`cached`), never fed back as authority.
import { KernelError } from "../core/errors.js";
import { CALLS, CACHEABLE, WIRE_VERSION, MAX_RESPONSE_BYTES } from "./wire.js";

/** @typedef {{ send(space: string, request: any): Promise<any> }} RemoteTransport the port the Wink connection (or the relay) fills; it delivers to the home and returns its reply */

let seq = 0;
/**
 * @param {{ space: string, transport: RemoteTransport, clock?: () => number, cacheMax?: number }} cfg
 */
export function createRemoteKernel(cfg) {
  const clock = cfg.clock || Date.now;
  const max = cfg.cacheMax ?? 200;
  /** @type {Map<string, any>} */ const cache = new Map();
  const keyOf = (/** @type {string} */ call, /** @type {any[]} */ args) => `${call}\n${JSON.stringify(args)}`;

  async function invoke(/** @type {string} */ call, /** @type {any[]} */ args) {
    // JSON only, so what is sent is exactly what the home signs off on (no functions, no cycles, no undefined holes).
    let wireArgs;
    try { wireArgs = JSON.parse(JSON.stringify(args.map(a => (a === undefined ? null : a)))); } catch { throw new KernelError("bad_input", "a remote call takes plain data"); }
    const id = `rq_${clock().toString(36)}_${(++seq).toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    let reply;
    try { reply = await cfg.transport.send(cfg.space, { v: WIRE_VERSION, space: cfg.space, id, ts: clock(), call, args: wireArgs }); } catch { throw new KernelError("unreachable", "the Space's home could not be reached"); }
    if (!reply || reply.v !== WIRE_VERSION || reply.id !== id || typeof reply.ok !== "boolean") throw new KernelError("unavailable", "the home's answer was not understood");
    if (!reply.ok) throw new KernelError(String(reply.error && reply.error.code || "unavailable").slice(0, 40), String(reply.error && reply.error.message || "refused").slice(0, 300));
    if (JSON.stringify(reply.result === undefined ? null : reply.result).length > MAX_RESPONSE_BYTES) throw new KernelError("unavailable", "the home's answer was too large");
    if (CACHEABLE.has(call)) {
      cache.set(keyOf(call, wireArgs), Object.freeze({ untrusted: true, source: "remote", space: cfg.space, at: clock(), value: reply.result }));
      while (cache.size > max) cache.delete(cache.keys().next().value);
    }
    return reply.result;
  }

  /** @param {string} group */
  const build = group => {
    /** @type {any} */ const root = {};
    for (const name of CALLS[/** @type {keyof typeof CALLS} */ (group)]) {
      const parts = name.split(".");
      let node = root;
      for (const p of parts.slice(0, -1)) node = node[p] ||= {};
      node[parts[parts.length - 1]] = (/** @type {any} */ _chain, /** @type {any[]} */ ...args) => invoke(`${group}.${name}`, args);
    }
    const freeze = (/** @type {any} */ o) => { for (const v of Object.values(o)) if (typeof v === "object") freeze(v); return Object.freeze(o); };
    return freeze(root);
  };

  return Object.freeze({
    space: cfg.space,
    hosted: false,
    gateway: Object.freeze({ grants: build("grants"), records: build("records"), tasks: build("tasks"), ask: build("tasks"), events: build("events"), leases: build("leases") }),
    lent: build("lent"),
    /** One wire call by its path (`lent.start`, `leases.issue`): the lent computer's runner client (core/runner/lent-client.js) speaks in these. The home still allows only what CALLS lists. */
    call: (/** @type {string} */ name, /** @type {any[]} */ args) => invoke(String(name), Array.isArray(args) ? args : []),
    surfaces: build("surfaces"),
    /**
     * The last copy this device fetched of a read, for the screen to show while the home is away: `{ untrusted: true, source: "remote", at, value }`, or null. It is never
     * an input to a decision on this device; the marker says so, and `fresh` is always false.
     * @param {string} call e.g. "grants.members.list" @param {any[]} [args] the arguments after the chain
     */
    cached(call, args = []) {
      const hit = cache.get(keyOf(call, JSON.parse(JSON.stringify(args))));
      return hit ? Object.freeze({ ...hit, fresh: false }) : null;
    },
  });
}
