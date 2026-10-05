// kernel/remote/client.js: the device's end of a remote kernel call. `createRemoteKernel` returns the same gateway API a hosted Space has (grants, records, tasks,
// events and the Surfaces door), so a caller does not care where the Space lives: every call is `(chain, ...args)` as locally. The chain argument never leaves the
// device and carries no authority there: the home mints the chain from the identity the transport proved, and `authorize` runs at the home. Nothing a home answers
// is trusted here: a reply is plain JSON, and the only thing kept is a MARKED copy of reads for the device's own screens (`cached`), never fed back as authority.
import { KernelError } from "../core/errors.js";
import { CALLS, CACHEABLE, WIRE_VERSION, MAX_RESPONSE_BYTES, PRESENCE_CODES } from "./wire.js";
import { canonical, sha256 } from "../core/canonical.js";
import { proofRequest, PROOF_CALLS, proofNameOf } from "./proof.js";

/** @typedef {{ send(space: string, request: any): Promise<any> }} RemoteTransport the port the Wink connection (or the relay) fills; it delivers to the home and returns its reply */

let seq = 0;
/**
 * @param {{ space: string, home?: string, transport: RemoteTransport, clock?: () => number, cacheMax?: number,
 *   signer?: (challenge: any) => Promise<{ presence: any }> | { presence: any } }} cfg `signer` is the device's presence key: given the home's challenge it returns the proof; the one place presence over the wire is handled
 */
export function createRemoteKernel(cfg) {
  const clock = cfg.clock || Date.now;
  const max = cfg.cacheMax ?? 200;
  /** @type {Map<string, any>} */ const cache = new Map();
  const keyOf = (/** @type {string} */ call, /** @type {any[]} */ args) => `${call}\n${JSON.stringify(args)}`;

  async function invoke(/** @type {string} */ call, /** @type {any[]} */ args, /** @type {{ proof?: any, challenge?: string }} */ extra = {}) {
    // JSON only, so what is sent is exactly what the home signs off on (no functions, no cycles, no undefined holes).
    let wireArgs;
    try { wireArgs = JSON.parse(JSON.stringify(args.map(a => (a === undefined ? null : a)))); } catch { throw new KernelError("bad_input", "a remote call takes plain data"); }
    const id = `rq_${clock().toString(36)}_${(++seq).toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    let reply;
    try { reply = await cfg.transport.send(cfg.space, { v: WIRE_VERSION, space: cfg.space, id, ts: clock(), call, args: wireArgs, ...(extra.proof !== undefined ? { proof: extra.proof, challenge: extra.challenge } : {}) }); } catch (e) {
      // the home's door refusing this connection says so (denied); anything else that stops the call is an outage
      if (e && /** @type {any} */ (e).code === "denied") throw new KernelError("denied", "the Space's home did not admit this connection");
      throw new KernelError("unreachable", "the Space's home could not be reached");
    }
    if (!reply || reply.v !== WIRE_VERSION || reply.id !== id || typeof reply.ok !== "boolean") throw new KernelError("unavailable", "the home's answer was not understood");
    if (!reply.ok) {
      const code = String(reply.error && reply.error.code || "unavailable").slice(0, 40);
      const ch = reply.error && reply.error.challenge && typeof reply.error.challenge === "object" ? reply.error.challenge : null;
      // the home asks for presence: sign its challenge with this device's key and send the same call once more; the peer session alone never counts
      if (PRESENCE_CODES.has(code) && ch && cfg.signer && extra.proof === undefined && challengeIsOurs(ch, call, wireArgs)) {
        let signed; try { signed = await cfg.signer(ch); } catch { signed = null; }
        if (signed && signed.presence && typeof signed.presence === "object") return invoke(call, args, { proof: signed.presence, challenge: String(ch.nonce) });
      }
      throw Object.assign(new KernelError(code, String(reply.error && reply.error.message || "refused").slice(0, 300)), ch ? { challenge: ch } : {});
    }
    if (JSON.stringify(reply.result === undefined ? null : reply.result).length > MAX_RESPONSE_BYTES) throw new KernelError("unavailable", "the home's answer was too large");
    if (CACHEABLE.has(call)) {
      cache.set(keyOf(call, wireArgs), Object.freeze({ untrusted: true, source: "remote", space: cfg.space, at: clock(), value: reply.result }));
      while (cache.size > max) cache.delete(cache.keys().next().value);
    }
    return reply.result;
  }

  /**
   * PW-2: the home's challenge is its own text, so it is checked against what THIS device asked before anything is signed: the call it made, this Space, the hash of the exact arguments it sent, and for a call a
   * presence proof covers, the op, fields and payload hash it works out itself. A challenge for anything else gets no signature.
   * @param {any} ch @param {string} call @param {any[]} sent
   */
  function challengeIsOurs(ch, call, sent) {
    try {
      if (ch.call !== call || ch.space !== cfg.space || ch.args_hash !== sha256(canonical(sent))) return false;
      if (cfg.home && ch.home !== cfg.home) return false;
      const short = proofNameOf(call);
      if (short && PROOF_CALLS.includes(short)) {
        const r = proofRequest(cfg.space, short, ...sent);
        if (ch.op !== r.op || ch.payload_hash !== r.payload_hash || canonical(ch.fields) !== canonical(r.fields)) return false;
      }
      return typeof ch.nonce === "string" && ch.nonce.length > 0;
    } catch { return false; }
  }

  /** A caller that already holds a proof passes it as the trailing options `{ presence, challenge }`: moved out of the args to travel beside them (the home puts it back for the kernel). */
  function invokeWith(/** @type {string} */ call, /** @type {any[]} */ args) {
    // A grants call whose proof options came empty (no proof yet) is the same call as one with none: the home binds its challenge to the exact arguments, so the first ask and the answer must agree.
    if ((call.startsWith("grants.") || call.startsWith("moves.")) && args.length) {
      const l = args[args.length - 1];
      if (l === undefined || l === null || (typeof l === "object" && !Array.isArray(l) && Object.keys(l).length === 0)) args = args.slice(0, -1);
    }
    const last = args[args.length - 1];
    if (last && typeof last === "object" && !Array.isArray(last) && Object.hasOwn(last, "presence") && typeof last.challenge === "string") {
      // PW-4: only the proof and its challenge travel in the options object; any other option cannot cross, so a proof can never be aimed at a data argument
      const { presence, challenge, ...rest } = last;
      if (Object.keys(rest).length) return Promise.reject(new KernelError("bad_input", "a remote call takes only a proof and its challenge as options"));
      return invoke(call, args.slice(0, -1), { proof: presence, challenge });
    }
    return invoke(call, args);
  }

  /** @param {string} group */
  const build = group => {
    /** @type {any} */ const root = {};
    for (const name of CALLS[/** @type {keyof typeof CALLS} */ (group)]) {
      const parts = name.split(".");
      let node = root;
      for (const p of parts.slice(0, -1)) node = node[p] ||= {};
      node[parts[parts.length - 1]] = (/** @type {any} */ _chain, /** @type {any[]} */ ...args) => invokeWith(`${group}.${name}`, args);
    }
    // a reveal's proof is made for the home's challenge and travels as the trailing option, never inside the request (PW-4)
    if (group === "seal") root.reveal = (/** @type {any} */ _chain, /** @type {any} */ i, /** @type {any} */ ...rest) => { const { proof: _p, ...bare } = i && typeof i === "object" ? i : /** @type {any} */ ({}); return invokeWith("seal.reveal", [bare, ...rest]); };
    const freeze = (/** @type {any} */ o) => { for (const v of Object.values(o)) if (typeof v === "object") freeze(v); return Object.freeze(o); };
    return freeze(root);
  };

  return Object.freeze({
    space: cfg.space,
    hosted: false,
    gateway: Object.freeze({ definitions: (/** @type {any} */ _chain, /** @type {any[]} */ ...args) => invokeWith("records.definitions", args), grants: build("grants"), records: build("records"), tasks: build("tasks"), ask: build("tasks"), events: build("events"), seal: build("seal"), moves: build("moves"), leases: build("leases") }),
    lent: build("lent"),
    /** One wire call by its path (`lent.start`, `leases.issue`): the lent computer's runner client (core/runner/lent-client.js) speaks in these. The home still allows only what CALLS lists. */
    call: (/** @type {string} */ name, /** @type {any[]} */ args) => invokeWith(String(name), Array.isArray(args) ? args : []),
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
