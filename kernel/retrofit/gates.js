// kernel/retrofit/gates.js: stage 1 of "compile the old into the new" (contract section 16, K2). The registry's static
// permission gates (module reach, outward, visibility, callers, person session), its presence requirement and its
// asked requirement are decided by `authorize` over grants compiled from today's rules. The compiled grants are produced
// on demand from the tool's own facts and the caller string, so the old predicates are written once, here, as policy.
// The registry still owns what is not a permission: the input schema, projectArg, the rules hook, proof verification,
// the asked-match, idempotency and running the tool. The golden set (kernel/golden) proves this changes no decision.
//
// This module imports today's caller helpers on purpose: it must read a caller string exactly as the registry does.
// It goes away at K6, when surfaces hand the kernel SurfaceFacts and nothing parses strings.
import { createAuthorizer } from "../core/authorize.js";
import { createLegacyChainBuilder, LEGACY_SPACE } from "../core/chain.js";
import { callerKind, agentClaim, callerAllowed, ownerDevice, personRefusesAgent, agentOpensPerson, agentAskFirst, classReach, PERSON_FREE } from "../../core/modules/index.js";
import { PERSON_ONLY } from "../../core/presence/index.js";
import { isPerson } from "../../lib/caller.js";

const SPACE = LEGACY_SPACE;
const GATES = ["declared", "outward", "visible", "callers", "session", "presence", "asked"];
const urn = (/** @type {string} */ tool) => `vyre://${SPACE}/tool/${tool}`;
const actor = (/** @type {string} */ kind, /** @type {string} */ id) => ({ kind, id, space: SPACE });

/**
 * Read a caller string the way the registry does, into the one hop a chain starts from.
 * @param {string} caller @param {boolean} person @param {string | undefined} [thread] the thread the daemon bound the call to (a session's own socket, a vouched key or session): what proves an assistant claim
 */
export function parseCaller(caller, person, thread) {
  const c = String(caller);
  const base = { legacy: c, ...(person ? { person_session: true } : {}), ...(typeof thread === "string" && thread ? { thread } : {}) };
  if (c.startsWith("module:")) return { kind: "service", id: c.slice(7) || "unnamed", ...base };
  if (c === "hook") return { kind: "service", id: "hooks", ...base };
  const claim = agentClaim(c);
  if (claim !== null) return { kind: "agent", id: claim, ...base };
  if (ownerDevice(c)) return { kind: "person", id: "owner", device: c, ...base };
  const k = callerKind(c);
  if (["cli", "local", "deck", "capsule", "mobile"].includes(k) && k === c) return { kind: "person", id: "owner", ...base };
  if (k === "mcp" || k === "harness") return { kind: "agent", id: "assistant", ...base };
  return { kind: "service", id: "legacy-" + (k.replace(/[^a-z0-9-]/gi, "-") || "unknown"), ...base };
}

/**
 * @param {{ registry: any }} cfg the booted Registry: its tools, modules, isFirstParty and deps.presence
 */
export function createLegacyGates(cfg) {
  const reg = cfg.registry;
  const chains = createLegacyChainBuilder({ space: SPACE });
  const flags = (/** @type {string} */ tool, /** @type {any} */ def, /** @type {any} */ input) => {
    const pr = reg.deps.presence ? Boolean(reg.deps.presence.required(tool, def, input)) : Boolean(def.presence);
    return `pr=${pr ? 1 : 0}`;
  };

  /** The compiled policy: which gate grants exist for this hop, tool and request. Written once; this is the old code as data. */
  function compile(/** @type {any} */ a, /** @type {any} */ hop, /** @type {any} */ req) {
    const gate = String(req.action).slice(7);
    const tool = req.resource.slice(`vyre://${SPACE}/tool/`.length);
    const def = reg.tools.get(tool);
    const c = String(hop.via.legacy);
    const pr = /pr=1/.test(req.input_class || "");
    const isModule = c.startsWith("module:");
    let allowed = false, conditions = {};
    switch (gate) {
      case "declared": {
        // An added module reaches only a tool whose reach is declared, never one declared for Vyre's own modules.
        const from = isModule ? reg.modules.get(c.slice(7)) : null;
        allowed = !(from && from.dir && def.module !== (from.manifest && from.manifest.name) && !reg.isFirstParty(from.dir) && (!def.declaredReach || def.reach === "modules"));
        break;
      }
      // the same test the registry's inline rule makes: only an older kind word (send, post, pay, delete) or an ask-first tool is held here; a plain `outward: true` goes on to the one yes's hold in the approvals queue
      case "outward": allowed = !((typeof def.outward === "string" && def.outward) || agentAskFirst(tool, c)) || isPerson(c); break;
      case "visible": allowed = (!def.internal || isModule) && Boolean(def.hook) === (c === "hook"); break;
      case "callers": allowed = (callerAllowed(def.callers, c, tool, () => reg.declaredSetupTools()) || agentOpensPerson(tool, def, c, { thread: hop.via.thread })) && !personRefusesAgent(tool, def, c, { thread: hop.via.thread }); break;
      case "session": {
        allowed = true;
        // The owner's device acts as the person only with the person's session, for a person-only or proof-needing tool.
        if (ownerDevice(c) && !PERSON_FREE.has(tool) && (PERSON_ONLY.has(tool) || def.reach === "person" || pr)) conditions = { how: { presence: "session" } };
        break;
      }
      case "presence": allowed = true; if (!isModule && pr) conditions = { how: { presence: "fresh" } }; break;
      case "asked": allowed = true; if (def.reach === "asked" && (["mcp", "harness", "module"].includes(callerKind(c)) || agentClaim(c) !== null)) conditions = { how: { approval: { by: "owner" } } }; break;
      default: allowed = false;
    }
    if (!allowed) return [];
    return [{ id: `legacy:${gate}`, space: SPACE, subject: { kind: "actor", actor: a }, actions: [`legacy.${gate}`], action_set_version: 1, resource: { prefix: `vyre://${SPACE}/tool/*` }, conditions, issuer: actor("service", "retrofit"), source: "retrofit:registry", status: /** @type {const} */ ("active"), created_at: 0 }];
  }

  const authorizer = createAuthorizer({
    space: SPACE,
    actions: GATES.map(g => ({ action: `legacy.${g}`, resource_type: "tool", risk: "read", label: g, gloss: "" })),
    grants: { forSubject: compile, get: () => undefined },
    members: { has: () => true },
    // A person session on the chain is what the old `meta.person` was.
    hasPresenceSession: chain => Boolean(chain.hops[0].via && chain.hops[0].via.session),
    clock: () => 0,
  });

  const ask = async (/** @type {string} */ gate, /** @type {any} */ chain, /** @type {string} */ tool, /** @type {string} */ input_class) =>
    authorizer.authorize({ chain, action: `legacy.${gate}`, resource: urn(tool), input_class });
  const chainOf = (/** @type {string} */ caller, /** @type {any} */ meta) => chains.fromLegacy(parseCaller(caller, Boolean(meta && meta.person), meta && meta.thread));

  return Object.freeze({
    /**
     * The registry's gates up to the input schema, in the old order. Returns the refusal the registry gives, or null to go on.
     * @param {{ tool: string, def: any, caller: string, meta: any, input: any, door: boolean }} q
     */
    async before(q) {
      const { tool, def, caller, meta, input, door } = q;
      const chain = chainOf(caller, meta);
      const cls = flags(tool, def, input);
      if (!door && String(caller).startsWith("module:") && (await ask("declared", chain, tool, cls)).effect !== "allow") return { error: { code: "not_declared", message: `${tool} is not open to added modules` } };
      if ((await ask("outward", chain, tool, cls)).effect !== "allow") return (typeof reg.outwardRefusal === "function" ? await reg.outwardRefusal({ tool, def, caller, input, meta }) : null) || { error: { code: "held_unavailable", message: `${tool} acts as you outside. A call from anyone but you is held at the Gate, and that routing lands with the Gate wiring; until then it runs only from your own surface.` } };
      if ((await ask("visible", chain, tool, cls)).effect !== "allow") return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
      if ((await ask("callers", chain, tool, cls)).effect !== "allow") return ["web", "setup"].includes(callerKind(caller)) && classReach(caller, tool, () => reg.declaredSetupTools()) === false ? { error: { code: "no_such_tool", message: `no tool ${tool}` } } : { error: { code: "denied", message: `${tool} is not available to ${callerKind(caller)} callers` } };
      const s = await ask("session", chain, tool, cls);
      if (s.effect !== "allow") return { error: { code: "person_session_required", message: `${tool} is the person's own action: sign in on this device with your passkey first` } };
      return null;
    },
    /** Does this call need a presence proof checked by the registry? (Never for a module.) */
    async needsPresence(/** @type {{ tool: string, def: any, caller: string, meta: any, input: any }} */ q) {
      // Fail closed: the only answer that asks for no proof is an allow. A deny, a throw or a new reason means "needs one".
      try { return (await ask("presence", chainOf(q.caller, q.meta), q.tool, flags(q.tool, q.def, q.input))).effect !== "allow"; } catch { return true; }
    },
    /** Does this call run only when the person's own words asked for it (the registry then checks the match)? */
    async needsAsk(/** @type {{ tool: string, def: any, caller: string, meta: any, input: any }} */ q) {
      try { return (await ask("asked", chainOf(q.caller, q.meta), q.tool, flags(q.tool, q.def, q.input))).effect !== "allow"; } catch { return true; }
    },
  });
}
