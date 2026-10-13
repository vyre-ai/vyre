// @ts-check
// Reading a thing's current shape for the handoff, with the person's own access: each read goes through the box as the person, so what they cannot see is not in the card.
import { agentShape, flowShape, objectShape, playbookShape } from "./model.js";

/** @typedef {(tool: string, input?: Record<string, unknown>) => Promise<{ data?: any, error?: { code: string, message: string } }>} Call */

/**
 * The name and shape lines of the thing a request is about. A read that fails (no access, gone) gives no shape: the card says where the request came from and the Engineer asks.
 * @param {Call} call @param {import("./model.js").Handoff} h @returns {Promise<{ name: string, shape: string[] }>}
 */
export async function readShape(call, h) {
  const none = { name: "", shape: /** @type {string[]} */ ([]) };
  if (!h.ref) return none;
  const ask = async (/** @type {string} */ tool, /** @type {Record<string, unknown>} */ input = {}) => { const r = await call(tool, input); return r.error ? null : r.data; };
  try {
    if (h.source === "playbook") { const v = await ask("work.template.get", { template: h.ref }); return v ? { name: String(v.name ?? v.body?.name ?? ""), shape: playbookShape(v) } : none; }
    if (h.source === "object") {
      const d = await ask("records.types");
      const t = (Array.isArray(d) ? d : Array.isArray(d?.types) ? d.types : []).find((/** @type {any} */ x) => x && (x.name === h.ref || x.id === h.ref));
      return t ? { name: String(t.plural || t.label || t.name || ""), shape: objectShape(t) } : none;
    }
    if (h.source === "flow") {
      const [g, got] = await Promise.all([ask("flows.graph", { id: h.ref }), ask("flows.get", { id: h.ref })]);
      if (!g && !got) return none;
      const name = String(got?.flow?.label ?? got?.flow?.name ?? h.ref);
      const steps = (Array.isArray(g?.nodes) ? g.nodes : []).map((/** @type {any} */ n) => String(n?.label ?? n?.title ?? n?.name ?? n?.id ?? "")).filter(Boolean);
      return { name, shape: flowShape({ name, status: got?.status, trigger: typeof g?.trigger === "string" ? g.trigger : g?.trigger?.label, steps }) };
    }
    if (h.source === "agent") {
      const d = await ask("agents.list");
      const a = (Array.isArray(d) ? d : Array.isArray(d?.agents) ? d.agents : []).find((/** @type {any} */ x) => x && x.name === h.ref);
      return a ? { name: String(a.name), shape: agentShape(a) } : none;
    }
  } catch { /* a read that throws is the same as none */ }
  return none;
}
