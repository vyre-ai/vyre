// @ts-check
// rules: the app's calls on a Space's standing rules (kernel/grants, gateway.grants.rules), one tool each, under the caller's own chain in the Space it names (lib/gateway-door.js).
// A rule is `{ kind: never | draft_only | always_ask, binds: [assistants | members], covers: { actions, resource? }, approver?, label }` and only ever tightens. Defining, switching, removing,
// accepting and dismissing are an owner's act with their presence proof, which rides beside the request (the kernel proof header), never in the body. The kernel checks every one.
import { createDoor } from "../../lib/gateway-door.js";

const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });
const str = { type: "string" };
const CALLERS = ["cli", "local", "deck", "capsule", "device"];

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const door = createDoor(ctx);
    /** @typedef {{ space: string, gateway: any, chain: any, proof: any }} Opened */
    /** @param {string} name @param {string} description @param {any} input @param {(i: any, d: Opened, r: any) => Promise<any>} fn */
    const tool = (name, description, input, fn) => ctx.tool(name, { description, input, callers: CALLERS, run: async (/** @type {any} */ i, /** @type {any} */ meta) => { const d = await door.open(i || {}, meta); return fn(i || {}, d, d.gateway.grants.rules); } });
    const rule = { type: "object", description: "{ kind: never | draft_only | always_ask, binds: [assistants | members], covers: { actions: [exact action names], resource?: urn pattern }, approver?: { person } | { role } (always_ask only), label }" };
    const withProof = (/** @type {Opened} */ d) => (d.proof ? { presence: d.proof } : {});

    tool("rules.list", "The Space's standing rules (on and off) and the proposals waiting for an owner, each with a plain-words view. A manager and above.", obj({ space: str }), async (_i, d, r) => r.list(d.chain));
    tool("rules.get", "One rule or proposal by id, with its plain-words view.", obj({ space: str, id: str }, ["id"]), async (i, d, r) => ({ rule: await r.get(d.chain, String(i.id)) }));
    tool("rules.define", "Make a standing rule. An owner's act, with their presence. A rule only tightens: it can refuse, make an act wait for a named approver, or allow a draft only; it never allows anything.", obj({ space: str, rule }, ["rule"]), async (i, d, r) => ({ rule: await r.set(d.chain, i.rule, withProof(d)) }));
    tool("rules.test", "What the rules would do to an act, without doing it. `as` is assistant (default), member or assistant_for_member; `action` is the act and `resource` its urn. `id` tries one stored rule alone (on or off); `rule` tries one nobody has defined yet beside the ones in force. Answers { outcome: never | always_ask | draft_only | none, binds: [{ id, kind, label, status, view }] }.", obj({ space: str, as: { type: "string", enum: ["assistant", "member", "assistant_for_member"] }, action: str, resource: str, id: str, rule }, ["action"]), async (i, d, r) => r.test(d.chain, { ...(i.as ? { as: String(i.as) } : {}), action: i.action, ...(i.resource ? { resource: i.resource } : {}), ...(i.id ? { id: String(i.id) } : {}), ...(i.rule ? { rule: i.rule } : {}) }));
    tool("rules.enable", "Turn a switched-off rule back on. An owner's act, with their presence.", obj({ space: str, id: str }, ["id"]), async (i, d, r) => ({ rule: await r.enable(d.chain, String(i.id), withProof(d)) }));
    tool("rules.disable", "Turn a rule off without deleting it: it binds nothing until it is turned on. An owner's act, with their presence.", obj({ space: str, id: str }, ["id"]), async (i, d, r) => ({ rule: await r.disable(d.chain, String(i.id), withProof(d)) }));
    tool("rules.remove", "Delete a standing rule. An owner's act, with their presence.", obj({ space: str, id: str }, ["id"]), async (i, d, r) => r.remove(d.chain, String(i.id), withProof(d)));
    tool("rules.propose", "Suggest a rule. It does nothing until an owner accepts it.", obj({ space: str, rule }, ["rule"]), async (i, d, r) => ({ proposal: await r.propose(d.chain, i.rule) }));
    tool("rules.accept", "Make a proposal a standing rule, exactly as proposed. An owner's act, with their presence.", obj({ space: str, id: str }, ["id"]), async (i, d, r) => ({ rule: await r.accept(d.chain, String(i.id), withProof(d)) }));
    tool("rules.dismiss", "Turn a proposal down. An owner's act, with their presence.", obj({ space: str, id: str }, ["id"]), async (i, d, r) => r.dismiss(d.chain, String(i.id), withProof(d)));
    return { async stop() {} };
  },
};
