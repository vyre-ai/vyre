// kernel/core/surfaces.js: the Surfaces door for daemons (sessions, voice): a daemon never builds a chain and never names a person. The person opens a session
// (their own chain, exactly one person) and gets a token; the daemon presents that token, and the kernel mints the chain for that session's person (and its
// assistant, when the session has one). The token is a MAC over the session's facts under the kernel's key: it cannot be forged, retargeted at another person or
// Space, or used after it expires or is revoked. The chain it yields is the person's, never a presence session: an admin act still needs the person's proof.
// `model` is the door's call for that chain, so a daemon needs nothing else to talk to a model; the streaming call is passed through when the door has one.
import { isChain, isExactlyPerson } from "./chain.js";
import { KernelError } from "./errors.js";
import { mintId } from "./ids.js";

const MAX_TTL = 24 * 3600 * 1000;
/** A model slot's agent id: `model:<provider>/<model>#<n>`, the same shape chains.fromFacts(model_slot) reads. */
const SLOT = /^model:[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*#[0-9]{1,6}$/;
const b64 = (/** @type {string} */ s) => Buffer.from(s).toString("base64url");

/** @param {{ space: string, chains: any, door?: any, isAdmin?: (person: string) => boolean, chatMember?: (person: string, chat: string) => boolean, clock?: () => number }} cfg the chain builder is what seals and checks a token: this holds no key */
export function createSurfaces(cfg) {
  const clock = cfg.clock || Date.now;
  /** @type {Set<string>} */ const revoked = new Set();
  /** @type {Map<string, string>} session -> the person who opened it, so a remote revoke can be held to its opener (or an admin) */ const openers = new Map();

  const api = {
    /**
     * The person opens a session for a daemon (and, for an assistant's session, names the assistant). @param {any} chain
     * @param {{ agent?: string, session?: string, thread?: string, ttl_ms?: number, chat?: string, project?: string }} [o] @returns {{ token: string, session: string, expires: number }}
     */
    async open(chain, o = {}) {
      if (!isChain(chain) || !isExactlyPerson(chain) || chain.delegated === true) throw new KernelError("chain_not_person", "only a person acting directly opens a session for a daemon: a session's own chain cannot mint another");
      // A session's chat is written into its token here, by the kernel, once the opener is checked to be in that chat; there is no later step that could point it elsewhere.
      let chat = null;
      if (o.chat !== undefined && o.chat !== null) {
        if (typeof o.chat !== "string" || !cfg.chatMember || !cfg.chatMember(chain.hops[0].actor.id, o.chat)) throw new KernelError("not_found", "no such chat");
        chat = o.chat;
      }
      // A model slot (`model:<provider>/<model>#<n>`, minted by the Switchboard) lives in one chat and acts as the person who opened it, narrowed to a Project the opener names. The Project can only NARROW what the
      // person already holds, so it is taken from the opener (the Switchboard reads it from the chat's record); a caller picks nothing wider by naming one.
      const slot = typeof o.agent === "string" && o.agent.startsWith("model:");
      if (slot && !SLOT.test(o.agent)) throw new KernelError("bad_input", "a model slot names model:provider/model#n");
      if (slot && chat === null) throw new KernelError("bad_input", "a model slot lives in a chat");
      if (o.project !== undefined && (typeof o.project !== "string" || !o.project || o.project.length > 200 || !slot)) throw new KernelError("bad_input", "only a model slot is narrowed to a project");
      const session = o.session || mintId("ses", clock());
      const exp = clock() + Math.min(o.ttl_ms ?? 3600_000, MAX_TTL);
      openers.set(session, chain.hops[0].actor.id);
      if (openers.size > 5000) openers.delete(openers.keys().next().value);
      const body = b64(JSON.stringify({ v: 1, space: cfg.space, person: chain.hops[0].actor.id, agent: o.agent || null, session, thread: o.thread || null, chat, ...(o.project !== undefined ? { project: o.project } : {}), exp }));
      return { token: `${body}.${await cfg.chains.sealToken(body)}`, session, expires: exp };
    },
    /**
     * End a session now: its token stops working. A daemon of this home calls `revoke(session)`; a call that carries the caller's chain (`revoke(session, chain)`, the remote
     * form) must be the person who opened the session or an admin (`cfg.isAdmin`), and anyone else finds no such session.
     */
    revoke(/** @type {string} */ session, /** @type {any} */ by) {
      if (by !== undefined) {
        const me = isChain(by) && isExactlyPerson(by) && by.delegated !== true ? by.hops[0].actor.id : null;
        if (!me || !(openers.get(String(session)) === me || (cfg.isAdmin && cfg.isAdmin(me)))) throw new KernelError("not_found", "no such session");
      }
      revoked.add(String(session));
    },
    /** The verified facts of a presented token, or a refusal that says nothing about why. @param {string} token */
    async verify(token) {
      const refuse = () => { throw new KernelError("not_a_member", "no chain for this session"); };
      if (typeof token !== "string") return refuse();
      const [body, mac] = token.split(".");
      if (!body || !mac || (await cfg.chains.checkToken(body, mac)) !== true) return refuse();
      let t; try { t = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return refuse(); }
      if (t.v !== 1 || t.space !== cfg.space || !(t.exp > clock()) || revoked.has(t.session)) return refuse();
      return t;
    },
    /** The session a presented token is for (checked like `chainFor`): what a chat binding and a room are keyed by, never a name a caller says. @param {string} token */
    async sessionOf(token) { return (await api.verify(token)).session; },
    /**
     * The chain for a presented token, or a refusal that says nothing about why. `noChat` leaves the session's chat out of the chain: the same agent, session and grants, read as the
     * person's own and not as the room's common view (what `{{field:...}}` resolution wants), and never wider than the session itself. @param {string} token @param {{ noChat?: boolean }} [o]
     */
    async chainFor(token, o = {}) {
      const t = await api.verify(token);
      const chat = o.noChat === true ? undefined : t.chat || undefined;
      if (typeof t.agent === "string" && t.agent.startsWith("model:")) return cfg.chains.fromFacts({ kind: "model_slot", model: t.agent.slice(6), session: t.session, person: t.person, chat, ...(t.project !== undefined ? { project: t.project } : {}), from_token: true, vouched: true });
      return t.agent
        ? cfg.chains.fromFacts({ kind: "agent_session", agent: t.agent, session: t.session, thread: t.thread || t.session, person: t.person, chat, from_token: true, vouched: true })
        : cfg.chains.fromFacts({ kind: "session_person", person: t.person, session: t.session, chat, from_token: true, vouched: true });
    },
    /** The model door for a session: `call(token, input)` and, when the door has one, `stream(token, input)`. The chain is the session's, never the caller's. */
    model: Object.freeze({
      call: async (/** @type {string} */ token, /** @type {any} */ input) => { if (!cfg.door) throw new KernelError("unavailable", "no model door is wired"); return cfg.door.call({ ...input, chain: await api.chainFor(token) }); },
      /** An async generator: a door with no streaming call is refused on the first `next`. */
      async *stream(/** @type {string} */ token, /** @type {any} */ input) { if (!cfg.door || typeof cfg.door.stream !== "function") throw new KernelError("unsupported", "the door has no streaming call yet"); yield* cfg.door.stream({ ...input, chain: await api.chainFor(token) }); },
    }),
  };
  return Object.freeze(api);
}
