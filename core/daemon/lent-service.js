// @ts-check
// The home's end of a lent computer, for each Space this home serves (core/runner/lent-home.js): a member's computer runs one of the Space's sessions and checkpoints it here.
// The peer door registers the result as the remote server's `lent` service. A lent session is the member's OWN session for the Space, run on their computer instead of the server: the Space's definition of it
// is the agent the member runs (the same program a session on the server would start, named, not a path: the lender finds it on its own computer), with the provider as its only network. `lentSpec` (the daemon's
// option) replaces the definition; `VYRE_LENT_AGENT` names another agent program, only on a development build with `VYRE_LENT_AGENT_DEV=1`.
import path from "node:path";
import { createLentHome } from "../runner/lent-home.js";
import { devSwitch } from "../../kernel/devbuild.js";
import { derivedKey } from "../../kernel/storage/keys.js";

/** The Space's definition of a member's own session: the agent by name, the provider as the only network, no credential route until the Space maps one (the vault answers per request, never the lender). */
/** Arguments for the agent, from `VYRE_LENT_AGENT_ARGS` (a JSON list of strings), only on a development build with `VYRE_LENT_AGENT_DEV=1`: how a test starts a one-shot turn. None on any other build. */
const agentArgs = () => { if (!devSwitch(process.env.VYRE_LENT_AGENT_DEV, undefined)) return []; try { const a = JSON.parse(process.env.VYRE_LENT_AGENT_ARGS || "[]"); return Array.isArray(a) && a.every(x => typeof x === "string") ? a.slice(0, 20) : []; } catch { return []; } };
const PROVIDER_ALLOW = Object.freeze([{ method: "POST", path: "/v1/messages" }, { method: "POST", path: "/v1/messages/count_tokens" }, { method: "GET", path: "/v1/models" }]);
/**
 * @param {{ item: string, base_url?: string | null, oauth?: boolean } | null} account the member's provider account: the vault item that holds its credential (a name, never a value), its own endpoint when it has one, and whether the credential is a
 *   subscription sign-in token (sent as a bearer token with the beta flag that makes it valid) rather than an API key (sent as x-api-key)
 */
const defaultSpec = account => ({
  command: (devSwitch(process.env.VYRE_LENT_AGENT_DEV, undefined) && process.env.VYRE_LENT_AGENT) || "claude", args: agentArgs(), env: {},
  // the provider is the session's only network: the lender's proxy forwards /provider to it and the home's vault answers the credential per request, for this lease only. The session itself holds
  // nothing but its own per-session token: the credential is put on the request at the proxy.
  routes: account ? [{ prefix: "/provider", upstream: account.base_url || "https://api.anthropic.com",
    credential: account.oauth ? { header: "authorization", prefix: "Bearer " } : { header: "x-api-key" }, ...(account.oauth ? { headers: { "anthropic-beta": "oauth-2025-04-20" } } : {}), allow: PROVIDER_ALLOW }] : [],
  readOnly: [], labels: {}, network: "provider",
  credentialRoutes: account ? [{ route: "/provider", ref: account.item, allow: PROVIDER_ALLOW, provider: true }] : [],
});

/**
 * `onRevoke(space, { device, member, side, reason })` is told when an Offer for a computer of this Space ends (withdrawn, the member removed or left): the daemon tells that computer down the connection it holds.
 * `emit(type, payload)` is told when a session moves (thread.moved); `resume(i)` is the server's continuation of a session a lender gave up or lost; `titleOf(space, chat)` names a chat for the lender's list. Each Space's
 * home watches its lenders' heartbeats from the moment it is made, and `stop()` ends the watching.
 * @param {{ root: string, emit?: (type: string, payload: any) => void, resume?: (i: any) => any, canResume?: () => boolean, http?: (thread: string, method: string, path: string, headers: Record<string, string>, body: string) => Promise<{ status: number, body: string }> | null, titleOf?: (space: string, chat: string) => Promise<string | null> | string | null, lentSpec?: (i: { space: string, session: string, person: string, device: string }) => Promise<any> | any, onRevoke?: (space: string, info: any) => void, keyOf?: (kernel: any, space: string) => Buffer | null, providerAccount?: (i: { space: string, person: string }) => Promise<{ item: string, base_url?: string | null, oauth?: boolean } | null> | { item: string, base_url?: string | null, oauth?: boolean } | null }} o
 * @returns {(space: string, kernel: any) => any}
 */
export function lentServiceFor(o) {
  /** @type {Map<string, () => void>} */ const subs = new Map();
  /** @type {Map<string, any>} the service each Space has now, for the home's own view of what is lent */ const live = new Map();
  /** @type {Map<string, any>} the kernel each live service was made for */ const liveK = new Map();
  const factory = (/** @type {string} */ space, /** @type {any} */ k) => {
    const g = k && k.gateway;
    if (!g || !g.grants || !g.grants.offers) return null;
    if (o.onRevoke && typeof g.grants.offers.onRevoke === "function") {
      if (subs.has(space)) { try { subs.get(space)?.(); } catch { /* gone */ } }
      subs.set(space, g.grants.offers.onRevoke((/** @type {any} */ info) => { if (info && info.device) o.onRevoke?.(space, info); }));
    }
    // A lent computer's work is kept on this home sealed under the Space's own key; a home with no key of its own for the Space (no Drive, no pool) refuses to hold it rather than keep it in the clear.
    const key = (o.keyOf || ((/** @type {any} */ kk, /** @type {string} */ sp) => derivedKey(kk, `lent-store/${sp}`)))(k, space);
    if (!key) {
      const refuse = async () => { throw Object.assign(new Error("this home has no storage key of its own for that space, so it will not hold a lent computer's work: ask the owner of this home to set up storage for that space"), { code: "unavailable" }); };
      return Object.freeze(Object.fromEntries(["whoami", "status", "start", "stop", "appendTranscript", "getTranscript", "putFile", "getFile", "putCheckpoint", "getCheckpoint", "usage", "beat", "release", "pipe", "wait", "http", "preview"].map(n => [n, refuse])));
    }
    const made = createLentHome({ space, root: path.join(o.root, "lent", space), key, offers: g.grants.offers, ...(o.emit ? { emit: o.emit } : {}), ...(o.resume ? { resume: o.resume } : {}), ...(o.canResume ? { canResume: o.canResume } : {}), ...(o.http ? { http: o.http } : {}), ...(o.titleOf ? { titleOf: (/** @type {string} */ chat) => o.titleOf?.(space, chat) } : {}), chatHas: (/** @type {any} */ chain, /** @type {string} */ id) => { try { g.grants.chats.read(chain, id); return true; } catch { return false; } }, ...(g.leases ? { leases: g.leases } : {}),
      specFor: async i => (o.lentSpec ? o.lentSpec(i) : defaultSpec(o.providerAccount ? await o.providerAccount(i) : null)) });
    const old = live.get(space); if (old && typeof old.stopWatching === "function") old.stopWatching();
    live.set(space, made); liveK.set(space, k); made.stopWatching = made.watch();
    return made;
  };
  /** The service for this Space's kernel: the one already made, or a new one. A Space's book is read from disk once; two services for one Space would each keep their own copy of it. @param {string} space @param {any} k */
  factory.ensure = (space, k) => (live.has(space) && liveK.get(space) === k ? live.get(space) : factory(space, k));
  /** The sessions lent for a Space and the chat each belongs to (never on the wire). @param {string} space */
  factory.rows = space => { const l = live.get(space); return l && typeof l.rows === "function" ? l.rows() : []; };
  /** The home of a Space, or null: the place tools reach its book through the daemon's runner host. @param {string} space */
  factory.home = space => live.get(space) || null;
  factory.spaces = () => [...live.keys()];
  factory.stop = () => { for (const h of live.values()) { try { h.stopWatching?.(); } catch { /* gone */ } } for (const off of subs.values()) { try { off(); } catch { /* gone */ } } };
  return factory;
}

/**
 * The place tools' view of every Space this home serves (core/runner/place-tools.js): find a session by its chat or id, ask its lender to hand it over, let it come back. Reads the registry's wiring at call time, since the home
 * of a Space is made when its server is.
 * @param {any} registry
 */
export function lentPlacements(registry, extra = {}) {
  const homeOf = (/** @type {string} */ space) => { const f = registry.deps.lentHome; return typeof f === "function" ? f(space) : null; };
  const book = (/** @type {string} */ space) => { const h = homeOf(space); if (!h) throw Object.assign(new Error("no such Space here (spaces.list shows the ones on this device)"), { code: "not_found" }); return h.book; };
  return Object.freeze({
    spaces: () => { const f = registry.deps.lentSpaces; return typeof f === "function" ? f() : []; },
    find: (/** @type {string} */ space, /** @type {string} */ id, /** @type {string} */ person) => { const h = homeOf(space); return h ? h.book.find(id, person) : null; },
    askRelease: (/** @type {string} */ space, /** @type {string} */ session, /** @type {string} */ reason, /** @type {string} */ person) => book(space).askRelease(session, reason, person),
    bringBack: (/** @type {string} */ space, /** @type {string} */ session, /** @type {string} */ person) => book(space).bringBack(session, person),
    /** Can the server carry a session on from a computer now? A home that does not say, can. */
    /** A chat that began on this server goes to one of the person's computers: { thread, person } -> { where: "mac", device, epoch }. The daemon says how (it holds the server's own store). */
    ...(typeof extra.adopt === "function" ? { adopt: extra.adopt } : {}),
    /** A loopback port of this box that leads to `port` on the computer running the chat's program (preview-home.js). */
    openPreview: async (/** @type {string} */ space, /** @type {{ thread: string, port: number, person: string }} */ i) => {
      const h = homeOf(space); const hit = h ? h.book.find(i.thread, i.person) : null;
      if (!h || !hit || hit.where !== "mac") throw Object.assign(new Error("that chat does not run on one of your computers"), { code: "not_found" });
      return h.openPreview({ session: hit.session, port: i.port, person: i.person });
    },
    /** The folders the person's ready computers offer to chats. */
    foldersOf: (/** @type {string} */ space, /** @type {string} */ person) => { const h = homeOf(space); return h && typeof h.foldersOf === "function" ? h.foldersOf(person) : []; },
    resumable: (/** @type {string} */ space) => { const h = homeOf(space); return !h || typeof h.canResume !== "function" || h.canResume() === true; },
  });
}
