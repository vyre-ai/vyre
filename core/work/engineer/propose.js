// @ts-check
// One proposal: an admin's request in words becomes TypeScript against the Vyre SDK, which is guarded, compiled and simulated, and comes back as a
// proposal with a diff. The model sees placeholders only (the inference door enforces it; the prompt is also built from the gateway's model view),
// everything it writes is labelled model-drafted, and nothing here applies anything.

import { joinLabels, externalLabels } from "../../../lib/labels.js";
import { modelView } from "../../../lib/sealed.js";
import { declarativeGuard } from "./guard.js";
import { runSimulation } from "./simulate.js";
import { outwardSteps } from "./card.js";

export const MAX_REQUEST = 4000;
const CONTEXT_CAP = 20_000;

/** @typedef {{ diff: any, canonical: string, hash: string, errors: { line: number, msg: string }[], authorship?: string, roles?: { name: string, grants: { actions: string[], resource_prefix: string }[] }[], flows?: { name: string, trigger?: string, steps: { kind: string, call?: string }[] }[], descriptions?: { where: string, text: string }[] }} Compiled */
/** @typedef {(source: string) => Promise<Compiled>|Compiled} CompilePort */

/** A refusal with a stable code, so a surface can say why in plain words. @param {string} code @param {string} message @param {any} [extra] */
export const refusal = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

export const SYSTEM_PROMPT = [
  "You are the Engineer. You write definitions for this Space as TypeScript against @vyre/sdk: defineKit, defineType, defineField, defineStage, defineTask,",
  "defineTemplate, defineRule, defineRole, defineFlow. Write only declarative code: import only from '@vyre/sdk', no computed values, no loops, no spreads,",
  "no require, no dynamic import. Flows are only for what comes from outside or crosses stages; stages are made of tasks. Sealed fields appear to you only as",
  "placeholders: never ask for, guess or write a sealed value. Reply with one fenced typescript block, then at most three sentences saying what it does.",
].join(" ");

/** The TypeScript in a model's reply and the words around it. @param {string} text @returns {{ source: string, note: string }} */
export function parseReply(text) {
  const m = /```(?:typescript|ts)?\s*\n([\s\S]*?)```/i.exec(text);
  if (!m) return { source: text.trim(), note: "" };
  return { source: m[1].trim(), note: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim() };
}

/** The definitions that exist, as a model may see them: read through the gateway, sealed fields as placeholders, capped. @param {any} kernel @param {any} chain */
async function existingDefinitions(kernel, chain) {
  /** @type {string[]} */ const out = [];
  if (typeof kernel.definitions === "function") {
    try { for (const t of await kernel.definitions(chain)) out.push(`type ${JSON.stringify(modelView({ name: t.name, label: t.label, fields: (t.fields || []).map((/** @type {any} */ f) => `${f.name}:${f.kind}`), stages: (t.stages || []).map((/** @type {any} */ x) => x.name) }))}`); } catch { /* none readable */ }
    return out.join("\n").slice(0, CONTEXT_CAP) || "(no definitions yet)";
  }
  for (const type of ["def.type", "def.flow", "def.role", "def.kit"]) {
    try {
      const page = await kernel.records.query(chain, type, { page: { limit: 100 } });
      for (const r of page.rows) out.push(`${type} ${JSON.stringify(modelView(r.data))}`);
    } catch { /* a Space with none of that kind, or no read on it: nothing to show */ }
  }
  return out.join("\n").slice(0, CONTEXT_CAP) || "(no definitions yet)";
}

/**
 * A role it defines cannot give what the importing admin does not hold (the narrowing rule, R6-15). Returns what exceeds.
 * @param {any} kernel @param {any} chain the Engineer's chain, whose first hop is the admin @param {Compiled} compiled
 */
async function exceeding(kernel, chain, compiled) {
  const admin = chain.hops[0].actor;
  const held = (await kernel.grants.list(chain, { subject: { kind: "actor", actor: admin }, status: "active" })).filter((/** @type {any} */ g) => g.status === "active");
  const out = [];
  for (const r of compiled.roles || []) for (const g of r.grants || []) for (const a of g.actions || []) {
    if (!held.some((/** @type {any} */ h) => (h.actions.includes(a) || h.actions.includes("*")) && String(g.resource_prefix || "").startsWith(h.resource.prefix))) out.push({ role: r.name, action: a, resource: g.resource_prefix });
  }
  return out;
}

/**
 * @param {{ kernel: any, compile: CompilePort, simulate?: import("./simulate.js").SimulatePort|null, chain: any, request: string, model?: { provider: string, model: string } }} o
 */
export async function propose({ kernel, compile, simulate, chain, request, model = { provider: "claude", model: "sonnet" } }) {
  const text = typeof request === "string" ? request.trim() : "";
  if (!text) throw refusal("bad_input", "say what should change");
  if (text.length > MAX_REQUEST) throw refusal("bad_input", `a request is up to ${MAX_REQUEST} characters`);
  const context = await existingDefinitions(kernel, chain);
  const reply = await kernel.model.call({ chain, purpose: "flow_agent", provider: model.provider, model: model.model, session: undefined,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: `Existing definitions:\n${context}\n\nRequest from an admin:\n${text}` }] });
  const { source, note } = parseReply(String(reply.content || ""));
  if (!source) throw refusal("empty", "the Engineer wrote nothing");
  return { ...(await evaluate({ kernel, compile, simulate, chain, source })), note };
}

/**
 * The part of a proposal that does not depend on how the text was written: guard, compile, narrow, simulate. An admin's own edit of the text
 * (revise) goes through the same path as the model's draft.
 * @param {{ kernel: any, compile: CompilePort, simulate?: import("./simulate.js").SimulatePort|null, chain: any, source: string, authorship?: "model-drafted"|"edited" }} o
 */
export async function evaluate({ kernel, compile, simulate, chain, source, authorship = "model-drafted" }) {
  const guard = declarativeGuard(source);
  if (!guard.ok) throw refusal("guard", `the draft is not a declarative definition: line ${guard.errors[0].line}: ${guard.errors[0].msg}`, { errors: guard.errors });
  /** @type {Compiled} */ const compiled = await compile(source);
  if (compiled.errors && compiled.errors.length) throw refusal("compile", `the draft does not compile: line ${compiled.errors[0].line}: ${compiled.errors[0].msg}`, { errors: compiled.errors });
  const over = await exceeding(kernel, chain, compiled);
  if (over.length) throw refusal("exceeds_admin", `a role in the draft gives ${over[0].action}, which you do not hold`, { exceeding: over });
  const simulation = await runSimulation({ simulate, diff: compiled.diff });
  const labels = joinLabels([chain.labels]);
  const descriptions = (compiled.descriptions || []).map(d => ({ ...d, labels: externalLabels(chain.space) }));
  return {
    source, canonical: compiled.canonical, hash: compiled.hash, diff: compiled.diff, roles: compiled.roles || [], flows: compiled.flows || [],
    simulation, authorship, labels, descriptions, outward: outwardSteps(compiled.flows || []), summary: summarise(compiled),
  };
}

/** A line of plain words from the compiled diff, not from the model. @param {Compiled} c */
export function summarise(c) {
  const d = c.diff || {};
  const parts = [];
  if ((d.add_types || []).length) parts.push(`adds ${d.add_types.length} type${d.add_types.length === 1 ? "" : "s"}`);
  if ((d.change_types || []).length) parts.push(`changes ${d.change_types.length}`);
  if ((d.remove_types || []).length) parts.push(`removes ${d.remove_types.length}`);
  if ((c.flows || []).length) parts.push(`adds ${c.flows?.length} Flow${c.flows?.length === 1 ? "" : "s"}`);
  if ((c.roles || []).length) parts.push(`adds ${c.roles?.length} role${c.roles?.length === 1 ? "" : "s"}`);
  return parts.length ? `This change ${parts.join(", ")}.` : "This change does nothing.";
}
