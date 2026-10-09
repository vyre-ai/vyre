// @ts-check
// lib/flow-from-calls: "Turn this into a Flow" (R031-42). The calls an assistant made by hand in a chat, in order, become a draft Flow: record writes through work.call become create and update steps,
// a find becomes a find step, an action the Space offers becomes a call step, and what cannot be a step is said. The assistant has the values (the receipts of a chat keep only their shape), so it
// passes the calls with their inputs. A value it names as a variable becomes an input read from the trigger; an id an earlier call returned and a later one used becomes a read of that step.
// Pure over the catalog it is given. It never stores anything; the caller defines the draft, which runs the same checks as any Flow.

import { noun } from "../kernel/tools/surface.js";

/** @param {string} s */
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "flow";
/** The tool name the way Flows names it: MCP prefix off, underscores to dots. @param {string} t */
const normal = (t) => String(t || "").replace(/^mcp__[a-z0-9_-]+?__/, "").replace(/_/g, ".");
/** @param {any} v */
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/**
 * @param {{ name: string, label?: string, calls: { tool: string, input?: any, returns?: { id?: string }, resource?: string }[], variables?: Record<string, any> }} spec
 * @param {{ types: Record<string, any>, actions?: Record<string, any> }} cat
 * @returns {{ flow: any, unmapped: { n: number, tool: string, why: string }[], inputs: string[] }}
 */
export function flowFromCalls(spec, cat) {
  const byNoun = new Map(Object.keys(cat.types || {}).map((t) => [noun(t), t]));
  const variables = isObj(spec.variables) ? spec.variables : {};
  /** @type {Map<string, string>} the id a call returned -> the step that made it */
  const made = new Map();
  /** @type {any[]} */ const steps = [];
  /** @type {{ n: number, tool: string, why: string }[]} */ const unmapped = [];
  const used = new Set();

  /** A value, with the variables and returned ids turned into reads. @param {any} v @returns {any} */
  const lift = (v) => {
    if (typeof v === "string" || typeof v === "number") {
      for (const [name, example] of Object.entries(variables)) if (example === v) { used.add(name); return { expr: `trigger.${name}` }; }
      if (typeof v === "string" && made.has(v)) return { expr: `steps.${made.get(v)}.record.id` };
      return v;
    }
    if (Array.isArray(v)) return v.map(lift);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, lift(x)]));
    return v;
  };
  /** A find's where as the expression text a find step takes. @param {Record<string, any>} where */
  const whereExpr = (where) => Object.entries(where).map(([k, v]) => {
    const lifted = lift(v);
    const right = isObj(lifted) && typeof lifted.expr === "string" ? lifted.expr : JSON.stringify(v);
    return `record.${k} == ${right}`;
  }).join(" && ");

  (spec.calls || []).forEach((c, i) => {
    const n = i + 1, tool = normal(c.tool), id = `s${n}`;
    const inner = tool === "work.call" ? { tool: String(c.input && c.input.tool || ""), input: (c.input && c.input.input) || {} } : null;
    const target = inner ? inner.tool : tool;
    const m = /^([a-z0-9_]+)\.(create|update|find)$/.exec(target);
    const type = m ? byNoun.get(m[1]) : undefined;
    if (inner && m && type) {
      const args = isObj(inner.input) ? inner.input : {};
      if (m[2] === "create") steps.push({ id, kind: "create", type, set: lift(isObj(args.data) ? args.data : {}) });
      else if (m[2] === "update") steps.push({ id, kind: "update", type, record: lift(args.id), set: lift(isObj(args.patch) ? args.patch : {}) });
      else steps.push({ id, kind: "find", type, ...(isObj(args.where) && Object.keys(args.where).length ? { where: whereExpr(args.where) } : {}), ...(Number.isInteger(args.limit) ? { limit: args.limit } : {}) });
      if (c.returns && typeof c.returns.id === "string") made.set(c.returns.id, id);
      return;
    }
    const action = cat.actions && cat.actions[target];
    if (action && typeof c.resource === "string" && c.resource.startsWith("vyre://")) {
      steps.push({ id, kind: "call", action: target, resource: c.resource, input: lift(isObj(c.input) ? c.input : {}) });
      return;
    }
    unmapped.push({ n, tool: target, why: action ? "this is an action of the Space; give its resource address (a vyre:// address) so it can be a call step" : m && !type ? `there is no record type for ${m[1]}` : "this is not a step a Flow can take; do it by hand or with a Code step" });
  });

  const flow = { format: 1, name: slug(spec.name), label: spec.label || spec.name, authorship: "model", trigger: { on: "manual" }, steps };
  return { flow, unmapped, inputs: [...used] };
}
