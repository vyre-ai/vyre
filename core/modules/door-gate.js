// @ts-check
// core/modules/door-gate.js: one gate at the registry's entry for a Space MEMBER's own session. A call that is not a module's own is judged here before any tool runs: the caller's person is read
// from the kernel's verified chain (the session token the socket stamped, or the facts the daemon proved), never from the caller's label. The chain's FIRST person hop decides:
//   owner or admin: served as before. No person hop: passes (a module's own work). A member: only the tools on MEMBER_MAY. A chain that cannot be read: a member.
// A server with no member but the owner has nobody to keep out, so nothing is gated there (asked on every call, nothing cached).
// What a member may call depends on her role (k.roleTools): a Member has MEMBER_MAY, a Guest (kernel role `temp`) has the smaller GUEST_MAY, and a custom role (Member-based) adds the tool groups it turns on
// (mail, calendar, documents, files, publish, computers, browser: TOOL_GROUPS in door-lists.js, each tool owner-only otherwise). An unknown tool, or a role this gate cannot read, is refused.
import { MEMBER_MAY, PLUMBING, SELF_GATED, GROUP_OF, GUEST_MAY, SCOPED_GROUPS } from "./door-lists.js";
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

/** A proven named agent on the person's session (not the default assistant or a model slot): standing and outward tools judge reach at the Gate; the member door must not refuse before that. */
const provenNamedAgent = (caller, meta) => {
  if (!(typeof meta?.thread === "string" && meta.thread.length > 0 && SESSION_ORIGIN.test(String(caller)))) return false;
  const m = /(?:^|[\s:])agent:([A-Za-z0-9_-]+)/.exec(String(caller ?? ""));
  const name = (typeof meta.agent === "string" && meta.agent) || (m ? m[1] : "");
  return Boolean(name) && name !== "assistant" && !String(name).startsWith("model:");
};

/** A plain noun for what a refused tool is about, by its module; a tool in a module not named here is "That". */
const NOUN = Object.freeze({
  mail: "mail", google: "Google account", github: "GitHub account", connectors: "connected services", publish: "publishing", documents: "document signing", mcp: "connected tools",
  computers: "computer access", computer: "computer access", chrome: "browser control", "hands-desktop": "computer access", glass: "computer access",
  settings: "set-up", spend: "spending", artifacts: "artifact library", bridges: "bridges to the owner's other accounts", machine: "set-up", spaces: "Space set-up",
});

/**
 * Tools a member's own call may make, but not a call with no person on it at all (an unproven device, browser, visiting Space or tailnet node, which may be a stranger). They are on MEMBER_MAY so a member with a
 * person on her chain is served by the handler; a no-person remote call is turned away here, on a Space with a second person, with the next step. A one-person home is not gated at all.
 * agents.list: an agent's name can carry a client's.
 */
const NEEDS_A_PERSON = Object.freeze({ "agents.list": "This device is not marked as yours yet, so it cannot see the Space's agents. Mark it as yours with `vyre relay mark <id>` (or the mark card in the app), then ask again." });

/** What a refused Guest is told: the tool is a member's, not hers. */
export const guestRefusal = () => "That is not open to a guest. Ask the owner or an admin to give you a role that has it.";

/** What a refused member is told: what it is, whose it is, whom to ask. Never a tool name. @param {string} tool */
export const refusal = (tool) => {
  const noun = /** @type {Record<string, string>} */ (NOUN)[tool.split(".")[0]];
  return `${noun ? `This is the owner's: the Space's ${noun}.` : "That is the owner's."} Ask the owner or an admin to do it for you, or to give you access.`;
};

/**
 * @param {{ chainOf: (meta: any) => Promise<any>, roleOf: (actor: any) => string | null | undefined, othersExist: (space?: string) => Promise<boolean>, roleTools?: (actor: any) => Promise<{ base: string, groups: readonly string[] } | null>, scopedGroups?: readonly string[] }} k
 *   roleTools: the person's base role and the tool groups her custom role turns on; absent or null is a plain Member (no group).
 * @returns {((tool: string, caller: string, meta: any) => Promise<{ error: { code: string, message: string } } | null>) & { hides: (caller: string, meta: any) => Promise<"member" | "pass">, visible: (caller: string, meta: any) => Promise<((tool: string) => boolean) | null> }}
 */
export function createDoorGate(k) {
  /** Is this call a MEMBER's own session? `v` is "member" or "pass"; `noPerson` says a member verdict came from the label alone, with no person on the call. @param {string} caller @param {any} meta @returns {Promise<{ v: "member" | "pass", noPerson: boolean, actor: any }>} */
  const judged = async (caller, meta) => {
    const m = meta || {};
    let others = true;
    try { others = (await k.othersExist(isRelay(caller, m) && m.in_space_chain ? m.in_space_chain.space : undefined)) === true; } catch { others = true; }
    if (!others) return { v: "pass", noPerson: false, actor: null };
    const relayed = isRelay(caller, m);
    const claims = relayed || typeof m.token === "string" || (m.kernelFacts && typeof m.kernelFacts === "object");
    /** @type {any} */ let first = null;
    if (!claims) {
      if (!UNPROVEN_LABEL.test(String(caller))) return { v: "pass", noPerson: false, actor: null };
    } else {
      try {
        const c = relayed ? m.in_space_chain : await k.chainOf(m);
        const hop = c && Array.isArray(c.hops) ? c.hops.find((/** @type {any} */ h) => h && h.actor && h.actor.kind === "person") : null;
        if (!hop) return { v: "pass", noPerson: false, actor: null };
        first = hop.actor;
      } catch { first = null; }
    }
    if (first) { let role = null; try { role = k.roleOf(first); } catch { role = null; } if (roleAtLeast(String(role), "admin")) return { v: "pass", noPerson: false, actor: null }; }
    return { v: "member", noPerson: !claims, actor: first };
  };
  /** @param {string} caller @param {any} meta @returns {Promise<"member" | "pass">} */
  const judge = async (caller, meta) => (await judged(caller, meta)).v;
  /** The member's role as the door reads it: her base role and the tool groups her custom role turns on. A role that cannot be read is a plain Member. @param {any} actor */
  const roleFor = async actor => {
    if (!actor || typeof k.roleTools !== "function") return { base: "member", groups: /** @type {readonly string[]} */ ([]) };
    try { const r = await k.roleTools(actor); return r && typeof r.base === "string" && Array.isArray(r.groups) ? r : { base: "member", groups: [] }; } catch { return { base: "member", groups: [] }; }
  };
  /** May a member with this role call a tool? Pure: the same answer for a call and for her tool list. @param {string} tool @param {{ base: string, groups: readonly string[] }} r */
  const roleMay = (tool, r) => {
    if (PLUMBING.has(tool) || SELF_GATED.has(tool)) return true;
    const group = GROUP_OF.get(tool);
    if (group) return r.base !== "temp" && (k.scopedGroups || SCOPED_GROUPS).includes(group) && r.groups.includes(group);
    if (!MEMBER_MAY.has(tool)) return false;
    return r.base === "temp" ? GUEST_MAY.has(tool) : true;
  };
  const gate = async (/** @type {string} */ tool, /** @type {string} */ caller, /** @type {any} */ meta) => {
    if (PLUMBING.has(tool) || SELF_GATED.has(tool)) return null;
    const group = GROUP_OF.get(tool);
    if (!MEMBER_MAY.has(tool) && !group) {
      if (WEB_REACH.has(tool) && String(caller).startsWith("web:")) return null; // a browser's own short list, about itself only; agent-reach holds it to that list next
      return (await judge(caller, meta)) === "member" ? { error: { code: "denied", message: refusal(tool) } } : null;
    }
    if (Object.hasOwn(NEEDS_A_PERSON, tool) && MEMBER_MAY.has(tool)) { const j = await judged(caller, meta); if (j.v === "member" && j.noPerson) return { error: { code: "denied", message: /** @type {Record<string, string>} */ (NEEDS_A_PERSON)[tool] } }; }
    // on every member's list and every guest's: no role to read
    if (MEMBER_MAY.has(tool) && GUEST_MAY.has(tool)) return null;
    const j = await judged(caller, meta);
    if (j.v === "pass") return null;
    const r = await roleFor(j.actor);
    if (roleMay(tool, r)) return null;
    const scoped = k.scopedGroups || SCOPED_GROUPS;
    if (provenNamedAgent(caller, meta) && group && !scoped.includes(group)) return null;
    return { error: { code: "denied", message: group ? refusal(tool) : guestRefusal() } };
  };
  /** The test a tool list is cut by for this caller: null when the caller is not a member (the whole list), else whether a tool shows. @param {string} caller @param {any} meta */
  const visible = async (caller, meta) => { const j = await judged(caller, meta); if (j.v === "pass") return null; const r = await roleFor(j.actor); return (/** @type {string} */ tool) => roleMay(tool, r); };
  /** Does this caller get a member's tool list (the owner's tools left off)? */
  return Object.assign(gate, { hides: judge, visible });
}

/** Is a tool one a member's list shows? Owner-only tools are left off it. @param {string} tool */
export const memberSees = (tool) => MEMBER_MAY.has(tool) || PLUMBING.has(tool);
