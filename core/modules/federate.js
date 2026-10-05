// @ts-check
// federate: the box's reads that take in its paired Macs' rows too (docs/work/federation.md,
// design 4). The Mac's sessions stay on the Mac (ADR 0008 step 3); the box asks for them through
// the link (link.macs.call) when the person reads, labels every row with the machine it came
// from, and keeps none of it.
//
// Shared by the modules whose reads federate (projects, recall, threads), which is why it lives
// here and not in core/link: modules do not import each other's files. It only ever reaches the
// link through ctx.call, so a box without the link module still answers with its own rows.

import { HUMAN_ONLY } from "../presence/index.js";
import { originClass, callerKind, agentClaim } from "./index.js";

/** How Vyre's MCP server names a Vyre tool (harness/mcp/server.js): what MCP names cannot hold becomes "_". */
const mcpName = t => t.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
/** The two server names Vyre's MCP server runs under in Claude Code (as in core/harness/rules.js). */
const VYRE_SERVERS = ["mcp__vyre__", "mcp__plugin_vyre_vyre__"];
/** Every name under which an ask can be for a floor tool: the tool itself, and each MCP name of it. */
const GATED_TOOLS = new Set([...HUMAN_ONLY].flatMap(t => [t, ...VYRE_SERVERS.map(p => p + mcpName(t))]));

/**
 * Is this ask gated: does allowing it approve a floor tool that needs a fresh proof of presence
 * (HUMAN_ONLY), or does the ask say presence is required? Matching is exact: the ask's `tool` is a
 * HUMAN_ONLY name, or `mcp__vyre__<name>` / `mcp__plugin_vyre_vyre__<name>` with the name spelled as
 * Vyre's MCP server spells it (every character outside [A-Za-z0-9_-] as "_"). Used at both ends of
 * the link: the box asks for the proof, and the Mac refuses an answer that carries none
 * (docs/adr/0021-box-reads-the-mac.md, "v2").
 * @param {any} ask an ask, or an ask.raised payload
 */
export const gatedAsk = ask => Boolean(ask && ((typeof ask.tool === "string" && GATED_TOOLS.has(ask.tool))
  || (ask.presence && typeof ask.presence === "object" && ask.presence.required === true)));


/**
 * Should this read take in the Macs' rows? Only on the box, only when the input does not say
 * "local", and only for the person, or for a module that asks with machines: "all". Agents, MCP
 * and guests get the box's own rows. A module stays local unless it asks, which is also what keeps
 * the Mac (which runs the box's questions as module:link) from asking the box back.
 * The person comes from the kernel's chain for this call (exactly one person hop, never a label).
 * @param {any} ctx @param {any} input @param {string | undefined} caller @param {any} [meta] the call's meta, for the kernel chain
 */
export async function wantsMacs(ctx, input, caller, meta) {
  if (!ctx.config || ctx.config.role !== "box") return false;
  const machines = input && input.machines;
  if (machines === "local") return false;
  const c = String(caller || "");
  // A module asks for the Macs only when it acts for the person: a module relaying a model's call (meta.origin names an assistant, an `mcp` session or the harness) gets the box's own rows, which is all that model gets itself.
  if (c.startsWith("module:")) {
    const o = String(originClass(meta || { caller }));
    const model = o !== c && (agentClaim(o) !== null || ["mcp", "harness", "hook"].includes(callerKind(o)));
    return machines === "all" && !model;
  }
  try { const ch = await ctx.kernel.chain(meta || { caller }); return Boolean(ch && ch.viewer !== true && Array.isArray(ch.hops) && ch.hops.length === 1 && ch.hops[0].actor && ch.hops[0].actor.kind === "person"); } catch { return false; }
}

/**
 * Ask every paired Mac for one of its read tools, as that Mac's own local read. Answers
 * [{ mac, name, ok, data?, error? }], one per Mac, or [] when the link is not running here or
 * refuses. Never throws: a Mac that cannot answer never costs the box its own rows.
 * @param {any} ctx @param {string} tool @param {any} input
 * @returns {Promise<Array<{ mac: string, name: string, ok: boolean, data?: any, error?: { code: string, message: string } }>>}
 */
export async function askMacs(ctx, tool, input) {
  try {
    const r = await ctx.call("link.macs.call", { tool, input: { ...(input || {}), machines: "local" } });
    return !r.error && Array.isArray(r.data) ? r.data : [];
  } catch { return []; }
}

/** The label on the box's own rows. @param {any} ctx */
export const boxLabel = ctx => ({ source: "box", machine: ctx.config.name || "box" });
/** The label on a Mac's rows. @param {{ name: string }} answer */
export const macLabel = answer => ({ source: "mac", machine: answer.name });
/** Rows with a label added. @param {any[]} rows @param {{ source: string, machine: string }} where */
export const label = (rows, where) => (Array.isArray(rows) ? rows : []).map(r => ({ ...r, ...where }));

/**
 * Who answered, box first: [{ source, machine, ok, error? }], error being the Mac's code
 * ("mac_offline", "timeout", ...).
 * @param {any} ctx @param {Array<{ name: string, ok: boolean, error?: { code: string } }>} answers
 */
export const sourcesOf = (ctx, answers) => [{ ...boxLabel(ctx), ok: true },
  ...answers.map(a => ({ ...macLabel(a), ok: a.ok, ...(a.ok ? {} : { error: a.error ? a.error.code : "failed" }) }))];

/**
 * The box's rows and every Mac's that answered, each labelled, in one list: box first, then
 * each Mac in pairing order, then sorted by `compare` (Array.sort is stable, so ties keep that
 * order, and each source's own order survives when it is already sorted the same way), capped
 * at `limit` when one is given.
 * @param {any} ctx @param {any[]} own @param {Array<{ name: string, ok: boolean, data?: any }>} answers
 * @param {{ rows?: (data: any) => any[], compare?: (a: any, b: any) => number, limit?: number }} [opts]
 */
export function mergeRows(ctx, own, answers, { rows = d => d, compare, limit } = {}) {
  const out = [...label(own, boxLabel(ctx))];
  for (const a of answers) if (a.ok) out.push(...label(rows(a.data), macLabel(a)));
  if (compare) out.sort(compare);
  return limit === undefined ? out : out.slice(0, Math.max(0, limit));
}
