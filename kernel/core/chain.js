// kernel/core/chain.js: the kernel builds the acting chain (invariant 2, contract 4.2). Nothing else can: a chain
// is a frozen object registered in a module-private set, so a hand-made one is not a chain. The builder takes only
// what the Surfaces door verified (SurfaceFacts), never a header string, and authority only narrows.
import { canonical, sha256 } from "./canonical.js";
import { createKernelSeal } from "./seal.js";
import { mintId } from "./ids.js";
import { KernelError } from "./errors.js";
import { TRUST_ORDER, REDACTION_ORDER } from "../contracts/index.js";

const BUILT = new WeakSet();

/** True only for an object this module built. */
export const isChain = (/** @type {unknown} */ c) => typeof c === "object" && c !== null && BUILT.has(c);

const PERSON_SURFACES = new Set(["cli", "local", "deck", "capsule", "mobile"]);
const MODEL_SURFACES = new Set(["mcp", "harness"]);

const deepFreeze = (/** @type {any} */ o) => {
  if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
};

/** `<kind>:<id>@<space>` @param {{ kind: string, id: string, space: string }} a */
export const actorString = a => `${a.kind}:${a.id}@${a.space}`;

/** Hash a chain's identity (hops and space, not times): what a presence proof binds to. */
export const chainHash = (/** @type {any} */ chain) => sha256(canonical({ space: chain.space, hops: chain.hops.map((/** @type {any} */ h) => ({ actor: h.actor, via: h.via, entered_by: h.entered_by })) }));

/** Approval is accepted only from a chain that is exactly one person (invariant 4). */
/** One person acting for themselves. A viewer chain (a person in the room an assistant writes for) is NOT: it is the kernel's read-only view of them, never their own act. */
export const isExactlyPerson = (/** @type {any} */ chain) => isChain(chain) && chain.viewer !== true && chain.hops.length === 1 && chain.hops[0].actor.kind === "person";

export const hasKind = (/** @type {any} */ chain, /** @type {string} */ kind) => chain.hops.some((/** @type {any} */ h) => h.actor.kind === kind);

/** An unknown trust or class is an error, never "weakest": a bad label must not drop a taint (invariant 9). */
export function checkLabels(/** @type {any} */ l) {
  if (!l || !TRUST_ORDER.includes(l.trust) || !REDACTION_ORDER.includes(l.red) || !Array.isArray(l.source_spaces)) throw new KernelError("bad_input", "unknown trust or class label");
  return l;
}

const weakest = (/** @type {string} */ a, /** @type {string} */ b) => (TRUST_ORDER.indexOf(/** @type {any} */ (a)) <= TRUST_ORDER.indexOf(/** @type {any} */ (b)) ? a : b);
const strongest = (/** @type {string} */ a, /** @type {string} */ b) => (REDACTION_ORDER.indexOf(/** @type {any} */ (a)) >= REDACTION_ORDER.indexOf(/** @type {any} */ (b)) ? a : b);

/** Weakest trust, strongest class, union of source Spaces: the label of anything derived from both. */
export function mergeLabels(/** @type {any} */ a, /** @type {any} */ b) {
  checkLabels(a); checkLabels(b);
  return { trust: weakest(a.trust, b.trust), red: strongest(a.red, b.red), source_spaces: [...new Set([...a.source_spaces, ...b.source_spaces])].sort() };
}

/**
 * @param {{ space: string, owner: string, owner_uid: number, key?: Uint8Array | string, seal?: any, sealer?: any, clock?: () => number,
 *   is_person?: (person: string) => boolean, job_max_age?: number }} cfg
 *   owner: the person id of the Space's owner on this machine; owner_uid: the OS user the kernel treats as them;
 *   seal: the sealing handle (kernel/core/seal.js: the sealing process, or a development key) that seals a stored chain and a session token; is_person: whether a person id is a member of this Space.
 */
export function createChainBuilder(cfg) {
  const seal = cfg.seal || createKernelSeal({ sealer: cfg.sealer, key: cfg.key });
  const clock = cfg.clock || Date.now;
  const space = cfg.space;
  const isMember = cfg.is_person || (p => p === cfg.owner);
  const hop = (/** @type {string} */ kind, /** @type {string} */ id, /** @type {any} */ entered_by, /** @type {any} */ via) =>
    ({ actor: { kind, id, space }, ...(via ? { via } : {}), entered_by });
  const make = (/** @type {any[]} */ hops, /** @type {any} */ labels, /** @type {any} */ extra = {}) => {
    const c = deepFreeze({ space, hops, labels: { ...labels, source_spaces: [...labels.source_spaces] }, built_at: clock(), ...extra });
    BUILT.add(c);
    return /** @type {import("../contracts/index.js").Chain} */ (/** @type {unknown} */ (c));
  };
  const base = () => ({ trust: "member", red: "public", source_spaces: [space] });
  const refuse = (/** @type {string} */ why) => { throw new KernelError("not_a_member", "no chain for this connection", why); };

  /** The chat a session token names (the kernel wrote it into the token): a chain made from a session carries it, so the gateway can answer a group session with the room's view. */
  const roomOf = (/** @type {any} */ f) => (f.from_token === true && typeof f.chat === "string" && f.chat && typeof f.session === "string" ? { chat: f.chat, session: f.session } : null);

  /** @param {any} f SurfaceFacts */
  function fromFacts(f) {
    if (!f || typeof f !== "object") return refuse("no facts");
    switch (f.kind) {
      case "socket": {
        if (f.inside_model_process) {
          // A model's call is never the person, whatever surface label it carries; a hook run inside a model's session carries it too.
          const hops = [hop("agent", "assistant", "surface", { surface: f.surface })];
          if (f.surface === "hook") hops.push(hop("service", "hooks", "registry"));
          return make(hops, base());
        }
        if (f.surface === "onboard") return make([hop("service", "onboard", "surface", { surface: "onboard" })], base());
        if (f.surface === "hook") return make([hop("service", "hooks", "surface", { surface: "hook" })], base());
        if (MODEL_SURFACES.has(f.surface)) return make([hop("agent", "assistant", "surface", { surface: f.surface })], base());
        if (PERSON_SURFACES.has(f.surface)) {
          if (f.uid !== cfg.owner_uid) return refuse(`uid ${f.uid} is not the owner`);
          if (f.surface === "capsule" && !f.capsule_verified) return refuse("capsule not verified");
          return make([hop("person", cfg.owner, "surface", { surface: f.surface, ...(typeof f.session === "string" && f.session ? { session: f.session } : {}) })], base());
        }
        return refuse(`surface ${f.surface} is not a socket surface`);
      }
      case "device": {
        if (!isMember(f.person)) return refuse("device's person is not a member");
        return make([hop("person", f.person, "surface", { device: `device:${f.device_key_id}`, ...(f.session ? { session: f.session } : {}), ...(f.path === "relay" ? { surface: "relay" } : {}), ...(f.path === "wink" ? { node: f.device_key_id } : {}) })], base());
      }
      case "agent_session": {
        if (!f.vouched) return refuse("agent claim not vouched by the kernel's own session");
        const who = f.person ?? cfg.owner;
        if (who !== cfg.owner && !isMember(who)) return refuse("the session's person is not a member");
        return make([hop("person", who, "session", { session: f.session }), hop("agent", f.agent, "session", { session: f.session })], base(), { ...(f.from_token === true ? { delegated: true } : {}), ...(roomOf(f) ? { room: roomOf(f) } : {}) });
      }
      case "invitee": {
        // Someone who holds an invite and is not a member yet: the Surfaces door verified who they are. Their chain can do one thing, accept the invite
        // (`grants.inviteAccept`); every other call finds no membership and is refused.
        if (!f.vouched || typeof f.person !== "string" || !f.person) return refuse("invitee not vouched by the kernel's own door");
        return make([hop("person", f.person, "surface", { surface: "link" })], { ...base(), trust: "member" });
      }
      case "session_person": {
        // A daemon speaking for a person in a session it holds a token for (kernel/core/surfaces.js verified it). It is the person's chain, but not a
        // presence session: no passkey was shown, so an admin act still needs the person's own proof.
        if (!f.vouched) return refuse("session not vouched by the kernel's own token");
        if (f.person !== cfg.owner && !isMember(f.person)) return refuse("the session's person is not a member");
        return make([hop("person", f.person, "session", { node: `session:${f.session}` })], base(), { ...(f.from_token === true ? { delegated: true } : {}), ...(roomOf(f) ? { room: roomOf(f) } : {}) });
      }
      case "viewer": {
        // One person in the room an assistant writes for. Built by the kernel from the chat's own list (kernel/index.js audienceFor), never from a module's word. It reads
        // what that person may read and can do nothing else: authorize refuses every act above read for it, and it holds no session, so it never stands for presence.
        if (!f.vouched || typeof f.person !== "string" || !f.person) return refuse("viewer not vouched by the kernel");
        if (f.person !== cfg.owner && !isMember(f.person)) return refuse("the viewer is not a member");
        return make([hop("person", f.person, "surface", { surface: "viewer" })], base(), { viewer: true });
      }
      case "module": return appendService(f.inbound, f.module, f.first_party);
      case "job": return restore(f.stored);
      default: return refuse("unknown facts");
    }
  }

  /** The registry appends a service hop on `ctx.call`. A module outside the reviewed set drops the label to external. */
  function appendService(/** @type {any} */ inbound, /** @type {string} */ module, /** @type {boolean} */ firstParty) {
    if (inbound !== undefined && !isChain(inbound)) return refuse("inbound is not a kernel chain");
    const h = hop("service", module, "registry");
    const labels = inbound ? inbound.labels : base();
    // A viewer chain stays a viewer chain with a service beside it: the flag is what makes authorize refuse every act above read, so dropping it would hand a room's reader write power.
    return make([...(inbound ? inbound.hops : []), h], firstParty ? labels : mergeLabels(labels, { trust: "external", red: "public", source_spaces: [space] }), inbound && inbound.viewer === true ? { viewer: true } : undefined);
  }

  /**
   * The chain a Flow run acts under: the approver's own chain with the automation appended (the approver stays the assigner of what the run makes), the run
   * id as its job, and taint carried: a run that read foreign content is external for good. `approver` must be a kernel chain that is exactly one person.
   * @param {{ flow: string, approver: any, run: string, tainted?: boolean }} o
   */
  function forFlow(o) {
    if (!isChain(o.approver) || o.approver.hops.length !== 1 || o.approver.hops[0].actor.kind !== "person") return refuse("a Flow runs under one person's approval");
    // FL-1: the approver is the person's OWN act. A viewer chain (a person in a room an assistant writes for), a delegated chain (made from a session token) and a room chain are not: a run built on one would carry more than the person gave.
    if (o.approver.viewer === true || o.approver.delegated === true || o.approver.room) return refuse("a Flow runs under a person's own approval, not a viewer's, a session's or a room's");
    if (typeof o.flow !== "string" || !o.flow || typeof o.run !== "string" || !o.run) return refuse("a Flow run needs its flow and its run id");
    const labels = o.tainted ? mergeLabels(o.approver.labels, { trust: "external", red: "public", source_spaces: [space] }) : o.approver.labels;
    return make([...o.approver.hops, hop("automation", o.flow, "job")], labels, { job: o.run });
  }

  /** A module acting for an approver: [approver, service:module], so what the module assigns carries the approver as its assigner. @param {{ module: string, approver: any, first_party?: boolean }} o */
  function forModule(o) { return appendService(o.approver, o.module, o.first_party !== false); }

  /** A derived chain whose label is weaker or equal: taint is sticky and only grows. */
  function weaken(/** @type {any} */ chain, /** @type {any} */ labels) {
    if (!isChain(chain)) return refuse("not a kernel chain");
    return make([...chain.hops], mergeLabels(chain.labels, labels), chain.job ? { job: chain.job } : {});
  }

  /** The stored form of a chain for a queued, scheduled or triggered job: sealed with the kernel's key. */
  const after = (/** @type {any} */ v, /** @type {(x: any) => any} */ f) => (v && typeof v.then === "function" ? v.then(f) : f(v));
  /** Returns the stored form, or a Promise of it when the sealing handle is the sealing process (`await` it; a development key answers at once). */
  function serialize(/** @type {any} */ chain, /** @type {string} */ job = mintId("job", clock())) {
    if (!isChain(chain)) return refuse("not a kernel chain");
    const body = canonical({ space: chain.space, hops: chain.hops, labels: chain.labels, built_at: chain.built_at, job });
    return after(seal.mac("chain-seal-v1", body), mac => ({ job, body, mac }));
  }
  /** A session token: sealed text the Surfaces door can check later. Returns the MAC, or a Promise of it. @param {string} body */
  const sealToken = body => seal.mac("surface-token-v1", body);
  /** @param {string} body @param {string} mac @returns {boolean | Promise<boolean>} */
  const checkToken = (body, mac) => seal.verify("surface-token-v1", body, mac);

  /** Rebuild a chain from its stored form, or from a chain a job already holds. A forged or altered record yields nothing. */
  function restore(/** @type {any} */ stored) {
    if (isChain(stored)) return stored.job ? stored : make([...stored.hops], stored.labels, { job: mintId("job", clock()) });
    if (!stored || typeof stored.body !== "string" || typeof stored.mac !== "string") return refuse("stored chain failed its seal");
    // Returns the chain, or a Promise of it when the seal is checked by the sealing process (`await` it).
    return after(seal.verify("chain-seal-v1", stored.body, stored.mac), ok => (ok ? finishRestore(stored) : refuse("stored chain failed its seal")));
  }
  function finishRestore(/** @type {any} */ stored) {
    const o = JSON.parse(stored.body);
    if (o.space !== space) return refuse("stored chain is for another space");
    // A leaked record replays for a bounded time only; authorize still rechecks every grant on use (invariant 3, K1 item 8b).
    if (!Number.isFinite(o.built_at) || clock() - o.built_at > (cfg.job_max_age ?? 30 * 24 * 3600 * 1000)) return refuse("stored chain is too old");
    try { checkLabels(o.labels); } catch { return refuse("stored chain has unknown labels"); }
    if (!Array.isArray(o.hops) || !o.hops.length) return refuse("stored chain has no hops");
    const c = deepFreeze({ space, hops: o.hops, labels: o.labels, built_at: o.built_at, job: o.job });
    BUILT.add(c);
    return /** @type {any} */ (c);
  }

  return Object.freeze({ fromFacts, appendService, forFlow, forModule, weaken, serialize, restore, sealToken, checkToken });
}

/** The one Space the retrofit's throwaway chains live in. No production authorizer evaluates it, so no chain minted for it is ever accepted by a real Space. */
export const LEGACY_SPACE = "spc_legacy000000";

/**
 * RETROFIT ONLY (K2b, removed at K6): stamps a caller string the registry already trusted into a chain of the throwaway
 * legacy Space, so the old rules can be decided by `authorize`. It is a separate factory, not a method of the production
 * builder, and it refuses any Space but LEGACY_SPACE: a person hop minted from a string can exist only where nothing real is.
 * @param {{ space: string, clock?: () => number }} cfg
 */
export function createLegacyChainBuilder(cfg) {
  if (cfg.space !== LEGACY_SPACE) throw new KernelError("bad_input", "the legacy chain builder serves only the legacy Space");
  const clock = cfg.clock || Date.now;
  return Object.freeze({
    /** @param {{ kind: "person" | "agent" | "service", id: string, legacy: string, person_session?: boolean, device?: string }} p */
    fromLegacy(p) {
      if (!["person", "agent", "service"].includes(p.kind) || typeof p.id !== "string" || !p.id) throw new KernelError("not_a_member", "no chain for this connection", "bad legacy caller");
      const hop = { actor: { kind: p.kind, id: p.id, space: LEGACY_SPACE }, entered_by: "registry", via: { legacy: p.legacy, ...(p.person_session ? { session: "person" } : {}), ...(p.device ? { device: p.device } : {}), ...(p.thread ? { thread: p.thread } : {}) } };
      const c = deepFreeze({ space: LEGACY_SPACE, hops: [hop], labels: { trust: "member", red: "public", source_spaces: [LEGACY_SPACE] }, built_at: clock() });
      BUILT.add(c);
      return /** @type {any} */ (c);
    },
  });
}
