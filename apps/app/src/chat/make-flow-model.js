// @ts-check
// "Make a Flow from this chat": the Vyre tools the assistant called in the thread, in order, become the calls of a draft Flow (flows.from-chat { name, calls }). A step that failed, a model's own tool
// (Read, Edit, Bash) and a call without a Vyre tool name are not Flow steps. The kernel decides which of the rest can be steps.

const VYRE_TOOL = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/;
const MAX = 40;

/** @param {readonly any[]} items the chat's tool items (`{ kind: "tool", name, input, status }`) @returns {{ tool: string, input: Record<string, unknown> }[]} */
export function callsFromItems(items) {
  /** @type {{ tool: string, input: Record<string, unknown> }[]} */ const out = [];
  for (const it of items) {
    if (!it || it.kind !== "tool") continue;
    const name = String(it.name ?? it.tool ?? "");
    if (!VYRE_TOOL.test(name)) continue;
    if (it.status === "failed" || it.status === "error") continue;
    const input = it.input && typeof it.input === "object" && !Array.isArray(it.input) ? { ...it.input } : {};
    out.push({ tool: name, input });
    if (out.length >= MAX) break;
  }
  return out;
}

/** The Flow's name: the thread's title, shortened, never empty. @param {string} title */
export const flowNameOf = (title) => { const t = String(title || "").replace(/\s+/g, " ").trim().slice(0, 60); return t || "Flow from a chat"; };

/** The page a made draft opens, or the line to show. @param {any} r flows.from-chat's answer @returns {{ open: string } | { say: string }} */
export function afterMake(r) {
  if (r && r.ok === true && r.id) return { open: `/u/flows/${encodeURIComponent(String(r.id))}` };
  const why = r && Array.isArray(r.errors) && r.errors[0] && r.errors[0].message ? String(r.errors[0].message) : "";
  return { say: why ? `That did not become a Flow: ${why}.` : "That did not become a Flow." };
}
