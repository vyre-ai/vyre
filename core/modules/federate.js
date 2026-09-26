// @ts-check
// federate — the box's reads that take in its paired Macs' rows too (docs/work/federation.md,
// design 4). The Mac's sessions stay on the Mac (ADR 0008 step 3); the box asks for them through
// the link (link.macs.call) when the person reads, labels every row with the machine it came
// from, and keeps none of it.
//
// Shared by the modules whose reads federate (projects, recall, threads), which is why it lives
// here and not in core/link: modules do not import each other's files. It only ever reaches the
// link through ctx.call, so a box without the link module still answers with its own rows.

/** The person's own callers: the Deck, the terminal, the Capsule. */
const PERSON = new Set(["deck", "cli", "local", "capsule"]);
/** The person on another of their devices. A guest is "tailnet-guest:<login>" and an agent carries "agent:", so neither matches. */
const TAILNET_PERSON = /^tailnet:(?!agent:)[^\s]+$/;

/**
 * Should this read take in the Macs' rows? Only on the box, only when the input does not say
 * "local", and only for the person, or for a module that asks with machines: "all". Agents, MCP
 * and guests get the box's own rows. A module stays local unless it asks, which is also what keeps
 * the Mac (which runs the box's questions as module:link) from asking the box back.
 * @param {any} ctx @param {any} input @param {string | undefined} caller
 */
export function wantsMacs(ctx, input, caller) {
  if (!ctx.config || ctx.config.role !== "box") return false;
  const machines = input && input.machines;
  if (machines === "local") return false;
  const c = String(caller || "");
  if (c.startsWith("module:")) return machines === "all";
  return PERSON.has(c) || TAILNET_PERSON.test(c);
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
