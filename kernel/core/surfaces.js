// kernel/core/surfaces.js: the Surfaces door for daemons (sessions, voice): a daemon never builds a chain and never names a person. The person opens a session
// (their own chain, exactly one person) and gets a token; the daemon presents that token, and the kernel mints the chain for that session's person (and its
// assistant, when the session has one). The token is a MAC over the session's facts under the kernel's key: it cannot be forged, retargeted at another person or
// Space, or used after it expires or is revoked. The chain it yields is the person's, never a presence session: an admin act still needs the person's proof.
// `model` is the door's call for that chain, so a daemon needs nothing else to talk to a model; the streaming call is passed through when the door has one.
import { hmac, sameMac } from "./canonical.js";
import { isChain, isExactlyPerson } from "./chain.js";
import { KernelError } from "./errors.js";
import { mintId } from "./ids.js";

const MAX_TTL = 24 * 3600 * 1000;
const b64 = (/** @type {string} */ s) => Buffer.from(s).toString("base64url");

/** @param {{ space: string, chains: any, key: Uint8Array | string, door?: any, clock?: () => number }} cfg */
export function createSurfaces(cfg) {
  const clock = cfg.clock || Date.now;
  /** @type {Set<string>} */ const revoked = new Set();

  const api = {
    /**
     * The person opens a session for a daemon (and, for an assistant's session, names the assistant). @param {any} chain
     * @param {{ agent?: string, session?: string, thread?: string, ttl_ms?: number }} [o] @returns {{ token: string, session: string, expires: number }}
     */
    open(chain, o = {}) {
      if (!isChain(chain) || !isExactlyPerson(chain)) throw new KernelError("chain_not_person", "only a person opens a session for a daemon");
      const session = o.session || mintId("ses", clock());
      const exp = clock() + Math.min(o.ttl_ms ?? 3600_000, MAX_TTL);
      const body = b64(JSON.stringify({ v: 1, space: cfg.space, person: chain.hops[0].actor.id, agent: o.agent || null, session, thread: o.thread || null, exp }));
      return { token: `${body}.${hmac(cfg.key, `vyre-surface-token-v1\n${body}`)}`, session, expires: exp };
    },
    /** End a session now: its token stops working. */
    revoke(/** @type {string} */ session) { revoked.add(String(session)); },
    /** The chain for a presented token, or a refusal that says nothing about why. @param {string} token */
    chainFor(token) {
      const refuse = () => { throw new KernelError("not_a_member", "no chain for this session"); };
      if (typeof token !== "string") return refuse();
      const [body, mac] = token.split(".");
      if (!body || !mac || !sameMac(hmac(cfg.key, `vyre-surface-token-v1\n${body}`), mac)) return refuse();
      let t; try { t = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return refuse(); }
      if (t.v !== 1 || t.space !== cfg.space || !(t.exp > clock()) || revoked.has(t.session)) return refuse();
      return t.agent
        ? cfg.chains.fromFacts({ kind: "agent_session", agent: t.agent, session: t.session, thread: t.thread || t.session, person: t.person, vouched: true })
        : cfg.chains.fromFacts({ kind: "session_person", person: t.person, session: t.session, vouched: true });
    },
    /** The model door for a session: `call(token, input)` and, when the door has one, `stream(token, input)`. The chain is the session's, never the caller's. */
    model: Object.freeze({
      call: (/** @type {string} */ token, /** @type {any} */ input) => { if (!cfg.door) throw new KernelError("unavailable", "no model door is wired"); return cfg.door.call({ ...input, chain: api.chainFor(token) }); },
      stream: (/** @type {string} */ token, /** @type {any} */ input) => { if (!cfg.door || typeof cfg.door.stream !== "function") throw new KernelError("unsupported", "the door has no streaming call yet"); return cfg.door.stream({ ...input, chain: api.chainFor(token) }); },
    }),
  };
  return Object.freeze(api);
}
