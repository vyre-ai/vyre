// @ts-check
// core/modules/door-gate.js: one gate at the registry's entry for a Space MEMBER's own session. A call that is not a module's own is judged here before any tool runs: the caller's person is read
// from the kernel's verified chain (the session token the socket stamped, or the facts the daemon proved), never from the caller's label. The chain's FIRST person hop decides:
//   owner or admin: served as before. No person hop: passes (a module's own work). A member: only the tools on MEMBER_MAY. A chain that cannot be read: a member.
// A server with no member but the owner has nobody to keep out, so nothing is gated there (asked on every call, nothing cached).
import { MEMBER_MAY, PLUMBING, SELF_GATED } from "./door-lists.js";
import { roleAtLeast } from "../../lib/spaces/members.js";
import { WEB_REACH } from "./agent-reach.js";

/**
 * The labels that are a person's or a model's only on proof. On a team server a call under one of them with no proof on it (no session token, no facts the daemon proved) is a member's until shown otherwise:
 * a model's session, and a device, tailnet node, Space or app label the daemon found no proof for (a member enrols a device of her own, and a People session is not proof of the owner). The owner's own
 * devices and nodes carry the daemon's proven facts, so they are claimed. Every label the daemon builds for a remote caller is here: device, web, setup, space, invitee, tailnet and tailnet-guest. A browser's
 * own short list (WEB_REACH in core/modules/agent-reach.js, about itself only) is let through in the gate below, so a browser still finishes its own pairing; the setup page is a one-person home, where the gate is off.
 */
const UNPROVEN_LABEL = /^(?:mcp:thread:|mcp:agent:|harness:thread:|harness:agent:|cli:agent:|device:|web:|setup:|space:|invitee:|tailnet|deck|mobile)/;

/**
 * A session's own call that the daemon relays into a team Space as `module:vyred` (core/daemon/index.js, a model's tool call in a team chat): the call began as the session's, so it is judged as the session's, the
 * person read from the chain the daemon built from the verified token (`in_space_chain`, which only callInSpace can set; the registry drops any other). The member door's own relays carry no session label.
 * @param {string} caller @param {any} m
 */
const SESSION_ORIGIN = /^(?:mcp:thread:|mcp:agent:|harness:thread:|harness:agent:|cli:agent:)/;
const isRelay = (caller, m) => caller === "module:vyred" && typeof m.origin === "string" && SESSION_ORIGIN.test(m.origin) && Boolean(m.in_space_chain && Array.isArray(m.in_space_chain.hops));

/** A plain noun for what a refused tool is about, by its module; a tool in a module not named here is "That". */
const NOUN = Object.freeze({
  mail: "mail", google: "Google account", github: "GitHub account", connectors: "connected services", publish: "publishing", documents: "document signing", mcp: "connected tools",
  computers: "computer access", computer: "computer access", chrome: "browser control", "hands-desktop": "computer access", glass: "computer access",
  settings: "set-up", spend: "spending", artifacts: "artifact library", bridges: "bridges to the owner's other accounts", machine: "set-up", spaces: "Space set-up",
});

/** What a refused member is told: what it is, whose it is, whom to ask. Never a tool name. @param {string} tool */
export const refusal = (tool) => {
  const noun = /** @type {Record<string, string>} */ (NOUN)[tool.split(".")[0]];
  return `${noun ? `This is the owner's: the Space's ${noun}.` : "That is the owner's."} Ask the owner or an admin to do it for you, or to give you access.`;
};

/**
 * @param {{ chainOf: (meta: any) => Promise<any>, roleOf: (actor: any) => string | null | undefined, othersExist: (space?: string) => Promise<boolean> }} k
 * @returns {((tool: string, caller: string, meta: any) => Promise<{ error: { code: string, message: string } } | null>) & { hides: (caller: string, meta: any) => Promise<"member" | "pass"> }}
 */
export function createDoorGate(k) {
  /** Is this call a MEMBER's own session? "member" or "pass". @param {string} caller @param {any} meta @returns {Promise<"member" | "pass">} */
  const judge = async (caller, meta) => {
    const m = meta || {};
    let others = true;
    try { others = (await k.othersExist(isRelay(caller, m) && m.in_space_chain ? m.in_space_chain.space : undefined)) === true; } catch { others = true; }
    if (!others) return "pass";
    const relayed = isRelay(caller, m);
    const claims = relayed || typeof m.token === "string" || (m.kernelFacts && typeof m.kernelFacts === "object");
    /** @type {any} */ let first = null;
    if (!claims) {
      if (!UNPROVEN_LABEL.test(String(caller))) return "pass";
    } else {
      try {
        const c = relayed ? m.in_space_chain : await k.chainOf(m);
        const hop = c && Array.isArray(c.hops) ? c.hops.find((/** @type {any} */ h) => h && h.actor && h.actor.kind === "person") : null;
        if (!hop) return "pass";
        first = hop.actor;
      } catch { first = null; }
    }
    if (first) { let role = null; try { role = k.roleOf(first); } catch { role = null; } if (roleAtLeast(String(role), "admin")) return "pass"; }
    return "member";
  };
  const gate = async (/** @type {string} */ tool, /** @type {string} */ caller, /** @type {any} */ meta) => {
    if (PLUMBING.has(tool) || MEMBER_MAY.has(tool) || SELF_GATED.has(tool)) return null;
    if (WEB_REACH.has(tool) && String(caller).startsWith("web:")) return null; // a browser's own short list, about itself only; agent-reach holds it to that list next
    return (await judge(caller, meta)) === "member" ? { error: { code: "denied", message: refusal(tool) } } : null;
  };
  /** Does this caller get a member's tool list (the owner's tools left off)? */
  return Object.assign(gate, { hides: judge });
}

/** Is a tool one a member's list shows? Owner-only tools are left off it. @param {string} tool */
export const memberSees = (tool) => MEMBER_MAY.has(tool) || PLUMBING.has(tool);
