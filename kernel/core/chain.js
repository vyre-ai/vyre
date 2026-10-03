// kernel/core/chain.js: the kernel builds the acting chain (invariant 2, contract 4.2). Nothing else can: a chain
// is a frozen object registered in a module-private set, so a hand-made one is not a chain. The builder takes only
// what the Surfaces door verified (SurfaceFacts), never a header string, and authority only narrows.
import { canonical, sha256, hmac, sameMac } from "./canonical.js";
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
export const isExactlyPerson = (/** @type {any} */ chain) => isChain(chain) && chain.hops.length === 1 && chain.hops[0].actor.kind === "person";

export const hasKind = (/** @type {any} */ chain, /** @type {string} */ kind) => chain.hops.some((/** @type {any} */ h) => h.actor.kind === kind);

const weakest = (/** @type {string} */ a, /** @type {string} */ b) => (TRUST_ORDER.indexOf(/** @type {any} */ (a)) <= TRUST_ORDER.indexOf(/** @type {any} */ (b)) ? a : b);
const strongest = (/** @type {string} */ a, /** @type {string} */ b) => (REDACTION_ORDER.indexOf(/** @type {any} */ (a)) >= REDACTION_ORDER.indexOf(/** @type {any} */ (b)) ? a : b);

/** Weakest trust, strongest class, union of source Spaces: the label of anything derived from both. */
export function mergeLabels(/** @type {any} */ a, /** @type {any} */ b) {
  return { trust: weakest(a.trust, b.trust), red: strongest(a.red, b.red), source_spaces: [...new Set([...a.source_spaces, ...b.source_spaces])].sort() };
}

/**
 * @param {{ space: string, owner: string, owner_uid: number, key: Uint8Array | string, clock?: () => number,
 *   is_person?: (person: string) => boolean }} cfg
 *   owner: the person id of the Space's owner on this machine; owner_uid: the OS user the kernel treats as them;
 *   key: the secret that seals a stored chain; is_person: whether a person id is a member of this Space.
 */
export function createChainBuilder(cfg) {
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
          return make([hop("person", cfg.owner, "surface", { surface: f.surface })], base());
        }
        return refuse(`surface ${f.surface} is not a socket surface`);
      }
      case "device": {
        if (!isMember(f.person)) return refuse("device's person is not a member");
        return make([hop("person", f.person, "surface", { device: `device:${f.device_key_id}`, ...(f.session ? { session: f.session } : {}), ...(f.path === "relay" ? { surface: "relay" } : {}), ...(f.path === "wink" ? { node: f.device_key_id } : {}) })], base());
      }
      case "agent_session": {
        if (!f.vouched) return refuse("agent claim not vouched by the kernel's own session");
        return make([hop("person", cfg.owner, "session", { session: f.session }), hop("agent", f.agent, "session", { session: f.session })], base());
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
    return make([...(inbound ? inbound.hops : []), h], firstParty ? labels : mergeLabels(labels, { trust: "external", red: "public", source_spaces: [space] }));
  }

  /** A derived chain whose label is weaker or equal: taint is sticky and only grows. */
  function weaken(/** @type {any} */ chain, /** @type {any} */ labels) {
    if (!isChain(chain)) return refuse("not a kernel chain");
    return make([...chain.hops], mergeLabels(chain.labels, labels), chain.job ? { job: chain.job } : {});
  }

  /** The stored form of a chain for a queued, scheduled or triggered job: sealed with the kernel's key. */
  function serialize(/** @type {any} */ chain, /** @type {string} */ job = mintId("job", clock())) {
    if (!isChain(chain)) return refuse("not a kernel chain");
    const body = canonical({ space: chain.space, hops: chain.hops, labels: chain.labels, built_at: chain.built_at, job });
    return { job, body, mac: hmac(cfg.key, body) };
  }

  /** Rebuild a chain from its stored form, or from a chain a job already holds. A forged or altered record yields nothing. */
  function restore(/** @type {any} */ stored) {
    if (isChain(stored)) return stored.job ? stored : make([...stored.hops], stored.labels, { job: mintId("job", clock()) });
    if (!stored || typeof stored.body !== "string" || typeof stored.mac !== "string" || !sameMac(hmac(cfg.key, stored.body), stored.mac)) return refuse("stored chain failed its seal");
    const o = JSON.parse(stored.body);
    if (o.space !== space) return refuse("stored chain is for another space");
    const c = deepFreeze({ space, hops: o.hops, labels: o.labels, built_at: o.built_at, job: o.job });
    BUILT.add(c);
    return /** @type {any} */ (c);
  }

  /**
   * RETROFIT ONLY (K2b, removed at K6): a one-hop chain for a caller string the registry already trusted. The caller
   * has parsed the string with the registry's own helpers; this only stamps it into a kernel chain so the old rules
   * can be decided by `authorize`. Surfaces that arrive as SurfaceFacts never use it.
   * @param {{ kind: "person" | "agent" | "service", id: string, legacy: string, person_session?: boolean, device?: string }} p
   */
  function fromLegacy(p) {
    if (!["person", "agent", "service"].includes(p.kind) || typeof p.id !== "string" || !p.id) return refuse("bad legacy caller");
    return make([hop(p.kind, p.id, "registry", { legacy: p.legacy, ...(p.person_session ? { session: "person" } : {}), ...(p.device ? { device: p.device } : {}) })], base());
  }

  return Object.freeze({ fromFacts, appendService, weaken, serialize, restore, fromLegacy });
}
