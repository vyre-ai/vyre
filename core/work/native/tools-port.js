// @ts-check
// The tool surface (DESIGN-native-assistant ideas 2 and 3). PLATFORM generates it from the Space's definitions and the action registry, cut by the
// acting chain's grants; this file is the contract the assistant builds against, a validator for any surface that claims to follow it, and a
// small test double (`fakeToolSurface`) over the fake kernel so the assistant's tests run before platform's generator exists.
//
// What platform must generate (Needs):
//  - For every type in the Space's definitions: `<plural>.find` (read), `<plural>.update` (write) and, when the type has a stage field,
//    `<plural>.move_stage` (write). The plural and the nouns come from the type's label, so a bakery gets `orders.*` and an estate firm `matters.*`.
//  - Fixed: `tasks.assign`, `templates.draft`, `flows.propose`, and a send tool per connector (for example `mail.send`).
//  - The list is cut by the chain's grants: a tool the chain cannot use is not listed. A tool that needs an approval is listed.
//  - An outward act (send, pay, publish, share, delete) never errors for want of approval: it returns `{ held: { task, summary, approver } }`, the
//    kernel having made the held task (output `sent`, the approver as checker). Nothing leaves the Space.
//  - Adding a type or field changes the list on the next turn.

import { RISKS } from "../../../kernel/contracts/index.js";

/** @typedef {{ name: string, description: string, schema: any, risk: string }} ToolSpec */
/** @typedef {{ held: { task: string, summary: string, approver: string } }} HeldResult */
/** @typedef {{ list(chain: any): Promise<ToolSpec[]>, call(chain: any, name: string, input: any): Promise<any> }} ToolSurface */

/** Throws if a surface does not follow the contract: names `noun.verb`, no duplicates, known risks, schemas. @param {any} surface */
export async function assertToolSurface(surface, chain = null) {
  if (!surface || typeof surface.list !== "function" || typeof surface.call !== "function") throw new Error("a tool surface has list(chain) and call(chain, name, input)");
  if (!chain) return true;
  const list = await surface.list(chain);
  const seen = new Set();
  for (const t of list) {
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(t.name)) throw new Error(`tool name ${t.name} must be noun.verb`);
    if (seen.has(t.name)) throw new Error(`tool ${t.name} listed twice`);
    seen.add(t.name);
    if (typeof t.description !== "string" || !t.description) throw new Error(`tool ${t.name} needs a description`);
    if (!t.schema || typeof t.schema !== "object") throw new Error(`tool ${t.name} needs a schema`);
    if (!RISKS.includes(/** @type {any} */ (t.risk))) throw new Error(`tool ${t.name} has an unknown risk ${t.risk}`);
  }
  return true;
}

/** "matter" to "matters", "category" to "categories". @param {string} s */
export const plural = s => (/[^aeiou]y$/.test(s) ? s.slice(0, -1) + "ies" : /(s|x|ch|sh)$/.test(s) ? s + "es" : s + "s");

/** @param {string} t */
const isOutward = t => t.startsWith("outward.");

/**
 * A tool surface over the fake kernel, generated from `fake.types` the way platform will generate it from definitions.
 * @param {any} fake createFakeKernel() @param {any} _chain unused: the chain is passed on every call, as in the real surface
 * @returns {ToolSurface}
 */
export function fakeToolSurface(fake, _chain = null) {
  const { kernel, space } = fake;
  const res = (/** @type {string} */ t) => `vyre://${space}/${t}/`;
  /** @returns {{ name: string, description: string, schema: any, risk: string, action: string, resource: string, run: (chain: any, input: any) => Promise<any> }[]} */
  function all() {
    const defs = [];
    for (const t of fake.types.values()) {
      const nm = plural(t.name), stageField = (t.fields || []).find((/** @type {any} */ f) => f.kind === "stage")?.name || (t.stages ? "stage" : null);
      defs.push({ name: `${nm}.find`, description: `Find ${t.label || t.name} records, optionally by a field value.`, schema: { type: "object", properties: { where: { type: "object" } } }, risk: "read", action: "records.read", resource: res(t.name),
        run: async (/** @type {any} */ c, /** @type {any} */ i) => ({ ok: true, records: (await kernel.records.query(c, t.name, { filter: i.where ? { and: Object.entries(i.where).map(([field, value]) => ({ field, op: "eq", value })) } : undefined, page: { limit: 25 } })).rows }) });
      defs.push({ name: `${nm}.update`, description: `Change fields on a ${t.label || t.name}.`, schema: { type: "object", required: ["id", "patch"], properties: { id: { type: "string" }, patch: { type: "object" } } }, risk: "write", action: "records.update", resource: res(t.name),
        run: async (/** @type {any} */ c, /** @type {any} */ i) => { const r = await kernel.records.get(c, t.name, i.id); return { ok: true, record: await kernel.records.update(c, t.name, i.id, i.patch, r.version) }; } });
      if (stageField) defs.push({ name: `${nm}.move_stage`, description: `Move a ${t.label || t.name} to another stage.`, schema: { type: "object", required: ["id", "stage"], properties: { id: { type: "string" }, stage: { type: "string" } } }, risk: "write", action: "records.update", resource: res(t.name),
        run: async (/** @type {any} */ c, /** @type {any} */ i) => { const r = await kernel.records.get(c, t.name, i.id); return { ok: true, record: await kernel.records.update(c, t.name, i.id, { [stageField]: i.stage }, r.version) }; } });
    }
    defs.push({ name: "tasks.assign", description: "Give a task to a person or an assistant, with an optional checker.", schema: { type: "object", required: ["title", "doer"], properties: { title: { type: "string" }, doer: { type: "object" }, checker: { type: "object" } } }, risk: "write", action: "tasks.request", resource: res("task"),
      run: async (/** @type {any} */ c, /** @type {any} */ i) => ({ ok: true, task: await kernel.ask.request(c, { title: i.title, doer: i.doer, ...(i.checker ? { checker: i.checker } : {}), output: i.output || { kind: "decision" }, source: "manual" }) }) });
    defs.push({ name: "templates.draft", description: "Draft a message from a template; sealed slots stay placeholders.", schema: { type: "object", required: ["template"], properties: { template: { type: "string" }, record: { type: "string" } } }, risk: "write", action: "records.update", resource: res("draft"),
      run: async (/** @type {any} */ c, /** @type {any} */ i) => ({ ok: true, draft: await kernel.records.create(c, "draft", { template: i.template, record: i.record || null, state: "draft" }) }) });
    defs.push({ name: "flows.propose", description: "Propose a Flow for an admin to approve; nothing runs until they do.", schema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } }, risk: "write", action: "tasks.request", resource: res("task"),
      run: async (/** @type {any} */ c, /** @type {any} */ i) => ({ ok: true, task: await kernel.ask.request(c, { title: `Flow proposal: ${i.summary}`, doer: c.hops.at(-1).actor, output: { kind: "decision" }, source: "assistant_request" }) }) });
    defs.push({ name: "mail.send", description: "Send an email. It is held for approval; you will be told when it is.", schema: { type: "object", required: ["to", "subject"], properties: { to: { type: "string" }, subject: { type: "string" } } }, risk: "outward.send", action: "email.send", resource: res("mail"), run: async () => { throw new Error("an outward act is held, never run here"); } });
    return defs;
  }
  return {
    async list(chain) {
      const out = [];
      for (const d of all()) {
        const a = await kernel.authorize({ chain, action: d.action, resource: d.resource });
        if (a.effect === "deny") continue;
        out.push({ name: d.name, description: d.description, schema: d.schema, risk: d.risk });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    async call(chain, name, input = {}) {
      const d = all().find(x => x.name === name);
      if (!d) return { error: { code: "not_found", message: "no such tool" } };
      const a = await kernel.authorize({ chain, action: d.action, resource: d.resource });
      if (a.effect === "deny") return { error: { code: "not_found", message: "no such tool" } };
      if (isOutward(d.risk) || a.effect === "ask" && a.obligations.some((/** @type {any} */ o) => o.type === "ask")) {
        const approver = String((a.obligations.find((/** @type {any} */ o) => o.type === "ask") || {}).approver || "owner");
        const summary = `${d.name}: ${String(input.subject || input.title || "held act").slice(0, 80)}`;
        const task = await kernel.ask.request(chain, { title: summary, doer: chain.hops.at(-1).actor, output: { kind: "sent" }, source: "assistant_request" });
        return { held: { task: task.id, summary, approver } };
      }
      return d.run(chain, input);
    },
  };
}
