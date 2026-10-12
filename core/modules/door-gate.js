// @ts-check
// core/modules/door-gate.js: one gate at the registry's entry for a Space MEMBER's own session. A call that is not a module's own is judged here before any tool runs: the caller's person is read
// from the kernel's verified chain (the session token the socket stamped, or the facts the daemon proved), never from the caller's label. The chain's FIRST person hop decides:
//   owner or admin: served as before. No person hop: passes (a module's own work). A member: only the tools on MEMBER_MAY. A chain that cannot be read: a member.
// A server with no member but the owner has nobody to keep out, so nothing is gated there (asked on every call, nothing cached).
import { MEMBER_MAY, PLUMBING, SELF_GATED } from "./door-lists.js";
import { roleAtLeast } from "../../lib/spaces/members.js";

/**
 * The labels that are a person's or a model's only on proof. On a team server a call under one of them with no proof on it (no session token, no facts the daemon proved) is a member's until shown otherwise:
 * a model's session, and a device, tailnet node, Space or app label the daemon found no proof for (a member enrols a device of her own, and a People session is not proof of the owner). The owner's own
 * devices and nodes carry the daemon's proven facts, so they are claimed. `web:` and `setup:` are not here: each reaches only its own short list (core/modules/agent-reach.js), before this gate.
 */
const UNPROVEN_LABEL = /^(?:mcp:thread:|mcp:agent:|harness:thread:|harness:agent:|cli:agent:|device:|tailnet|space:|deck|mobile)/;

/** A plain noun for what a refused tool is about, by its module; a tool in a module not named here is "That". */
const NOUN = Object.freeze({
  mail: "mail", google: "Google account", github: "GitHub account", connectors: "connected services", publish: "publishing", documents: "document signing", mcp: "connected tools",
  computers: "computer access", computer: "computer access", chrome: "browser control", "hands-desktop": "computer access", glass: "computer access",
  settings: "set-up", spend: "spending", artifacts: "artifact library", bridges: "bridges to the owner's other accounts", machine: "set-up", spaces: "Space set-up",
});

/** What a refused member is told: what it is, whose it is, whom to ask. Never a tool name. @param {string} tool */
export const refusal = (tool) => {
  const noun = /** @type {Record<string, string>} */ (NOUN)[tool.split(".")[0]];
  return `${noun ? `The Space's ${noun}` : "That"} is the owner's. Ask the owner or an admin to do it for you, or to give you access.`;
};

/**
 * @param {{ chainOf: (meta: any) => Promise<any>, roleOf: (actor: any) => string | null | undefined, othersExist: () => Promise<boolean> }} k
 * @returns {((tool: string, caller: string, meta: any) => Promise<{ error: { code: string, message: string } } | null>) & { hides: (caller: string, meta: any) => Promise<"member" | "pass"> }}
 */
export function createDoorGate(k) {
  /** Is this call a MEMBER's own session? "member" or "pass". @param {string} caller @param {any} meta @returns {Promise<"member" | "pass">} */
  const judge = async (caller, meta) => {
    let others = true;
    try { others = (await k.othersExist()) === true; } catch { others = true; }
    if (!others) return "pass";
    const m = meta || {};
    const claims = typeof m.token === "string" || (m.kernelFacts && typeof m.kernelFacts === "object");
    /** @type {any} */ let first = null;
    if (!claims) {
      if (!UNPROVEN_LABEL.test(String(caller))) return "pass";
    } else {
      try {
        const c = await k.chainOf(m);
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
    return (await judge(caller, meta)) === "member" ? { error: { code: "denied", message: refusal(tool) } } : null;
  };
  /** Does this caller get a member's tool list (the owner's tools left off)? */
  return Object.assign(gate, { hides: judge });
}

/** Is a tool one a member's list shows? Owner-only tools are left off it. @param {string} tool */
export const memberSees = (tool) => MEMBER_MAY.has(tool) || PLUMBING.has(tool);
