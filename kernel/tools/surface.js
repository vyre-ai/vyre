// kernel/tools/surface.js: the tool surface (DESIGN-native-assistant ideas 2 and 3). It is generated, never written by hand:
//  - one `<plural>.find`, `.create`, `.update` per type in the Space's definitions, and `.move_stage` for a type with a stage field;
//  - the fixed work tools `tasks.assign` and `tasks.read`;
//  - one tool per outward action in the action registry (send, pay, publish, share), named by the action itself.
// The list is cut by the acting chain's grants: a tool the chain cannot use is not listed, so a model never meets a permission error it did not
// expect. A tool the chain may use only with approval is listed, and calling it never errors for want of approval: it returns
// `{ held: { task, summary, approver } }`, the kernel having made the held task (output `sent`, the approver as checker). Nothing leaves.
// Nothing here holds authority: every call goes through the gateway, which asks `authorize` with the chain the kernel built.
import { isChain } from "../core/chain.js";
import { KernelError } from "../core/errors.js";
import { RISKS } from "../contracts/index.js";

/** "matter" to "matters", "category" to "categories". @param {string} s */
export const plural = s => (/[^aeiou]y$/.test(s) ? s.slice(0, -1) + "ies" : /(s|x|ch|sh)$/.test(s) ? s + "es" : s + "s");
const NOUN = /^[a-z][a-z0-9-]*$/;
/** A type name as a tool noun: dashes become underscores. @param {string} s */
export const noun = s => plural(s).replace(/-/g, "_");
const NEVER_TOOLS = /^(vault|seal|grants?|records\.define)\b|^records\./; // the fixed record actions are the typed tools below, never listed raw
const cap = (/** @type {any} */ s, n = 120) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const acting = (/** @type {any} */ chain) => chain.hops[chain.hops.length - 1].actor;

/**
 * @typedef {{ name: string, description: string, schema: any, risk: string }} ToolSpec
 * @param {{ kernel: any, space: string, types: (chain: any) => Promise<readonly any[]>|readonly any[], actions?: () => readonly any[], taskActions?: boolean }} cfg
 *   kernel: the assembled Kernel (authorize, records, ask); types: the Space's current definitions (read each turn, so Customize shows up on the next one);
 *   actions: the action registry, read for the outward acts.
 */
export function createToolSurface({ kernel, space, types, actions = () => [], taskActions = true }) {
  const urn = (/** @type {string} */ t, id = "*") => `vyre://${space}/${t}/${id}`;

  /** The static shape of every tool for the current definitions. @returns {Promise<any[]>} */
  async function defs(chain) {
    /** @type {any[]} */ const out = [];
    for (const t of await types(chain)) {
      if (!NOUN.test(t.name)) continue;
      const nm = noun(t.name), label = cap(t.label || t.name, 40), fields = (t.fields || []).filter((/** @type {any} */ f) => f.kind !== "sealed");
      const stageField = (t.fields || []).find((/** @type {any} */ f) => f.kind === "stage")?.name;
      // The field names the schema shows are the ones this chain's grant allows (a `fields` allow-list hides the rest, names included).
      const probe = await kernel.authorize({ chain, action: "records.read", resource: urn(t.name), probe: true });
      const allow = (probe.obligations || []).filter((/** @type {any} */ o) => o.type === "fields").reduce((/** @type {Set<string> | null} */ acc, /** @type {any} */ o) => (acc === null ? new Set(o.allow) : new Set([...acc].filter(x => o.allow.includes(x)))), null);
      const names = fields.map((/** @type {any} */ f) => f.name).filter((/** @type {string} */ n) => !allow || allow.has(n));
      out.push({ name: `${nm}.find`, description: `Find ${label} records, optionally where a field has a value. At most 50 a call, in the order made unless you sort; "more" says there are others and "next_cursor" fetches them. Sealed fields come back as placeholders.`, risk: "read", action: "records.read", resource: urn(t.name),
        schema: { type: "object", properties: { where: { type: "object", description: `Field and value pairs. Fields: ${names.join(", ")}.` }, limit: { type: "integer", description: "1 to 50" }, cursor: { type: "string", description: "next_cursor from the last call" }, sort: { type: "array", description: "[{ field, dir: asc | desc }]: for the first or last few, sort and set limit instead of reading them all" } } },
        run: async (/** @type {any} */ c, /** @type {any} */ i) => {
          const where = i.where && typeof i.where === "object" ? Object.entries(i.where) : [];
          const limit = Math.min(Number(i.limit) || 25, 50);
          const page = await kernel.records.query(c, t.name, { ...(where.length ? { filter: { and: where.map(([field, value]) => ({ field, op: "eq", value })) } } : {}), ...(Array.isArray(i.sort) && i.sort.length ? { sort: i.sort } : {}), page: { limit, ...(typeof i.cursor === "string" && i.cursor ? { cursor: i.cursor } : {}) } });
          return { ok: true, type: t.name, records: page.rows, ...(page.next_cursor ? { more: true, next_cursor: page.next_cursor } : {}), ...(Number(i.limit) > 50 ? { capped_at: 50 } : {}) };
        } });
      out.push({ name: `${nm}.create`, description: t.name === "task" ? "A to-do or reminder is planner_add; this is a work item on a record." : `Add a ${label}.`, risk: "write", action: "records.create", resource: urn(t.name),
        schema: { type: "object", required: ["data"], properties: { data: { type: "object", description: `Fields: ${names.join(", ")}.` } } },
        run: async (/** @type {any} */ c, /** @type {any} */ i) => ({ ok: true, type: t.name, record: await kernel.records.create(c, t.name, i.data || {}) }) });
      out.push({ name: `${nm}.update`, description: `Change fields on a ${label}.`, risk: "write", action: "records.update", resource: urn(t.name),
        schema: { type: "object", required: ["id", "patch"], properties: { id: { type: "string" }, patch: { type: "object", description: `Fields: ${names.join(", ")}.` } } },
        run: async (/** @type {any} */ c, /** @type {any} */ i) => { const r = await kernel.records.get(c, t.name, i.id); if (!r) throw new KernelError("not_found", "no such record"); return { ok: true, type: t.name, record: await kernel.records.update(c, t.name, i.id, i.patch || {}, r.version) }; } });
      if (stageField) {
        const options = (t.stages || []).map((/** @type {any} */ s) => s.name);
        out.push({ name: `${nm}.move_stage`, description: `Move a ${label} to another stage${options.length ? `: ${options.join(", ")}` : ""}.`, risk: "write", action: "records.update", resource: urn(t.name),
          schema: { type: "object", required: ["id", "stage"], properties: { id: { type: "string" }, stage: options.length ? { type: "string", enum: options } : { type: "string" } } },
          run: async (/** @type {any} */ c, /** @type {any} */ i) => { const r = await kernel.records.get(c, t.name, i.id); if (!r) throw new KernelError("not_found", "no such record"); return { ok: true, type: t.name, record: await kernel.records.update(c, t.name, i.id, { [stageField]: i.stage }, r.version) }; } });
      }
    }
    if (taskActions && kernel.ask) {
      out.push({ name: "tasks.assign", description: "Give a task to a person or an assistant, with an optional checker and a declared output.", risk: "write", action: "tasks.request", resource: urn("task", "new"),
        schema: { type: "object", required: ["title", "doer", "output"], properties: { title: { type: "string" }, doer: { type: "object" }, checker: { type: "object" }, record: { type: "string" }, output: { type: "object", properties: { kind: { enum: ["fields", "note", "draft", "sent", "decision", "file"] }, target: {} } } } },
        run: async (/** @type {any} */ c, /** @type {any} */ i) => ({ ok: true, task: await kernel.ask.request(c, { title: i.title, doer: i.doer, ...(i.checker ? { checker: i.checker } : {}), ...(i.record ? { record: i.record } : {}), output: i.output, source: "assistant_request" }) }) });
    }
    for (const a of actions()) {
      if (!a || !RISKS.includes(a.risk) || !String(a.risk).startsWith("outward.") || NEVER_TOOLS.test(a.action) || !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(a.action)) continue;
      out.push({ name: a.action, description: `${cap(a.label, 60)}. ${cap(a.gloss, 160)} It is held for approval: nothing leaves until a person approves.`.trim(), risk: a.risk, action: a.action, resource: urn(a.resource_type || "message", "new"), outward: true,
        schema: { type: "object", required: ["summary"], properties: { summary: { type: "string", description: "What is being done, in a sentence." }, record: { type: "string" }, payload: { type: "object" } } },
        run: async () => { throw new KernelError("bad_state", "an outward act is held, never run here"); } });
    }
    // A tool name is unique: a type tool (or any earlier tool) keeps its name, and a later one with the same name is dropped, never shadowed (T-1).
    const seen = new Set();
    return out.filter(d => (seen.has(d.name) ? false : (seen.add(d.name), true)));
  }

  const decide = (/** @type {any} */ chain, /** @type {any} */ d) => kernel.authorize({ chain, action: d.action, resource: d.resource });

  return Object.freeze({
    /** The tools this chain may use, sorted by name. @returns {Promise<ToolSpec[]>} */
    async list(/** @type {any} */ chain) {
      if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
      const out = [];
      for (const d of await defs(chain)) {
        const a = await decide(chain, d);
        if (a.effect === "deny") continue;
        out.push({ name: d.name, description: d.description, schema: d.schema, risk: d.risk });
      }
      return out.sort((x, y) => x.name.localeCompare(y.name));
    },
    /** Run a tool. An unlisted tool is `not_found`, the same as one that does not exist. An outward act, or a call that needs approval, returns `held`. */
    async call(/** @type {any} */ chain, /** @type {string} */ name, input = {}) {
      if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
      const d = (await defs(chain)).find(x => x.name === name);
      const a = d ? await decide(chain, d) : null;
      if (!d || !a || a.effect === "deny") return { error: { code: "not_found", message: "no such tool" } };
      if (d.outward || a.effect === "ask") {
        const ob = a.obligations.find((/** @type {any} */ o) => o.type === "ask");
        const approver = String(ob?.approver || "owner");
        const summary = cap(`${d.name}: ${input.summary || input.title || "held act"}`, 160);
        // A person's own act needs their own presence (Face ID) at the surface, not a task: a person cannot check their own work.
        if (acting(chain).kind === "person") return { needs_presence: { action: d.action, summary } };
        try {
          const task = await kernel.ask.request(chain, { title: summary, doer: acting(chain), output: { kind: "sent" }, ...(typeof input.record === "string" ? { record: input.record } : {}), source: "assistant_request" });
          return { held: { task: task.id, summary, approver } };
        } catch (e) { return { error: { code: /** @type {any} */ (e).code || "held_failed", message: "it could not be held for approval, so nothing was done" } }; }
      }
      try { return await d.run(chain, input || {}); }
      catch (e) { const err = /** @type {any} */ (e); return { error: { code: err.code || "failed", message: cap(err.message, 200) } }; }
    },
  });
}
