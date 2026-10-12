// @ts-check
// roles: the app's calls on a Space's roles. The built-in ones as a person sees them (Owner, Admin, Member, Guest) and custom ones a Space defines from Member or Admin. A custom role is stored as a
// `def-role` record (owner and admin write it; its record events are the audit trail) and expands into ordinary kernel grants with source `role:<id>` when it is given to someone (kernel/grants
// applyRole `custom`, which refuses anything outside the base role). Every call runs under the caller's own chain (lib/gateway-door.js); nothing here decides what a person may do, the kernel does.
import { createDoor } from "../../lib/gateway-door.js";
import { ROLE_IDS, ROLE_MAY_SET } from "../../kernel/contracts/index.js";
import { CAN, WHERE_KINDS, ACCESS_LEVELS, CUSTOM_BASES, TOOLS, TOOL_IDS, BUILTIN_VIEW, BUILTIN_TOOLS, ALIASES } from "./catalogue.js";
import { checkRole, expandRole } from "./definition.js";

const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });
const str = { type: "string" };
const CALLERS = ["cli", "local", "deck", "capsule", "mobile", "device"];
const TYPE = "def-role";
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/** Read the Space's custom roles. @returns {Promise<Map<string, { row: string, version: number, role: any }>>} */
export async function readRoles(/** @type {any} */ gw, /** @type {any} */ chain) {
  const out = new Map();
  let r;
  try { r = await gw.records.query(chain, TYPE, { page: { limit: 500 } }); } catch (/** @type {any} */ e) { if (e && (e.code === "unknown_type" || e.code === "not_found")) return out; throw e; }
  for (const x of r.rows || []) {
    let body; try { body = JSON.parse(String(x.data && x.data.body)); } catch { continue; }
    if (body && body.v === 1 && body.custom === true && typeof body.role === "object") out.set(String(body.role.id), { row: x.id, version: x.version, role: body.role });
  }
  return out;
}
const bodyOf = (/** @type {any} */ role) => JSON.stringify({ v: 1, custom: true, role });
const types = async (/** @type {any} */ gw, /** @type {any} */ chain) => ((await gw.definitions(chain)) || []).map((/** @type {any} */ t) => ({ name: t.name, fields: t.fields || [] }));

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const door = createDoor(ctx);
    /** @typedef {{ space: string, gateway: any, chain: any, proof: any }} Opened */
    const tool = (/** @type {string} */ name, /** @type {string} */ description, /** @type {any} */ input, /** @type {any} */ effect, /** @type {(i: any, d: Opened) => Promise<any>} */ fn) => ctx.tool(name, { description, input, effect, callers: CALLERS, run: async (/** @type {any} */ i, /** @type {any} */ meta) => { const d = await door.open(i || {}, meta); return fn(i || {}, d); } });
    const people = async (/** @type {Opened} */ d) => { const l = await d.gateway.grants.members.list(d.chain); return Array.isArray(l) ? l : []; };
    const me = (/** @type {Opened} */ d) => String(d.chain.hops[0].actor.id);
    const myRole = async (/** @type {Opened} */ d) => (await people(d)).find((/** @type {any} */ m) => m.person === me(d))?.role;
    const staff = async (/** @type {Opened} */ d) => { const r = await myRole(d); if (r !== "owner" && r !== "admin") throw refuse("Only an owner or an admin changes roles. Ask one of them.", "not_allowed"); return r; };
    const withProof = (/** @type {Opened} */ d) => (d.proof ? { presence: d.proof } : {});
    const view = (/** @type {any} */ r, /** @type {any[]} */ ms, /** @type {boolean} */ count) => ({ id: r.id, label: r.label, description: r.description, builtin: false, base: r.base, ends: r.ends, tools: r.tools, ...(count ? { people: ms.filter(m => m.custom === r.id).length } : {}) });
    /** A custom role may only be changed or given by someone who could give its base: an admin never makes or gives a role at or above admin. */
    const mayHold = (/** @type {string} */ mine, /** @type {string} */ base) => (/** @type {any} */ (ROLE_MAY_SET)[mine] || []).includes(base);

    tool("roles.catalogue", "What a role is made of: the built-in roles, the switches (can), where a role reaches, the access levels and the tools.", obj({ space: str }), "read", async () => ({
      builtin: BUILTIN_VIEW.map(b => ({ id: b.id, label: b.label, description: b.description })),
      can: CAN.map(c => ({ id: c.id, label: c.label, gloss: c.gloss, needs: c.needs })), where: [...WHERE_KINDS], access: [...ACCESS_LEVELS], bases: [...CUSTOM_BASES], tools: TOOLS.map(t => ({ id: t.id, label: t.label })),
    }));

    tool("roles.list", "The Space's roles: Owner, Admin, Member, Guest and the custom ones, each with how many people hold it (an owner or admin sees the counts).", obj({ space: str }), "read", async (_i, d) => {
      const ms = await people(d);
      const mine = ms.find(m => m.person === me(d));
      const count = Boolean(mine && (mine.role === "owner" || mine.role === "admin"));
      const customs = [...(await readRoles(d.gateway, d.chain)).values()].map(x => view(x.role, ms, count));
      return { roles: [...BUILTIN_VIEW.map(b => ({ id: b.id, label: b.label, description: b.description, builtin: true, base: b.id, ...(count ? { people: ms.filter(m => m.role === b.kernel && m.custom === undefined).length } : {}) })), ...customs] };
    });

    tool("roles.get", "One role, built in or custom, with everything it says.", obj({ space: str, id: str }, ["id"]), "read", async (i, d) => {
      const id = String(i.id), b = BUILTIN_VIEW.find(x => x.id === id || x.kernel === id);
      if (b) return { role: { id: b.id, label: b.label, description: b.description, builtin: true, base: b.id } };
      const c = (await readRoles(d.gateway, d.chain)).get(id);
      if (!c) throw refuse(`There is no role "${id}". roles.list shows the roles of this Space.`, "not_found");
      return { role: { ...c.role, builtin: false } };
    });

    tool("roles.tools", "The tools a person has at the door through their role: all for an owner or admin, none for a Member or Guest unless a custom role turns them on. Anyone asks about themselves; an owner or admin about anyone.", obj({ space: str, person: str }), "read", async (i, d) => {
      const ms = await people(d), mine = ms.find(m => m.person === me(d)), who = i.person ? String(i.person) : me(d);
      if (who !== me(d) && !(mine && (mine.role === "owner" || mine.role === "admin"))) throw refuse("Only an owner or an admin asks about someone else.", "not_allowed");
      const m = ms.find(x => x.person === who);
      if (!m) return { tools: [] };
      const c = m.custom ? (await readRoles(d.gateway, d.chain)).get(String(m.custom)) : null;
      const own = c ? c.role.tools : /** @type {any} */ (BUILTIN_TOOLS)[m.role] || [];
      return { tools: TOOL_IDS.filter(t => own.includes(t)), role: m.role, ...(m.custom ? { custom: m.custom } : {}) };
    });

    tool("roles.create", "Make a custom role from Member or Admin: what it can do, where, which record types and fields, which tools, an optional end date. Never wider than its base. Owner and admin only.", obj({ space: str, role: { type: "object" } }, ["role"]), "write", async (i, d) => {
      const mine = await staff(d);
      const role = checkRole(i.role, { types: await types(d.gateway, d.chain) });
      if (!mayHold(mine, role.base)) throw refuse("Only an owner makes a role that starts from Admin. Ask the owner, or start this role from Member.", "not_allowed");
      const have = await readRoles(d.gateway, d.chain);
      if (have.has(role.id)) throw refuse(`There is already a role "${role.id}". Pick another name, or change that one (roles.update).`, "duplicate");
      const data = { name: role.id, body: bodyOf(role), kit: "" };
      try { await d.gateway.records.create(d.chain, TYPE, data); } catch (/** @type {any} */ e) {
        if (!(e && (e.code === "unknown_type" || e.code === "not_found"))) throw e;
        await d.gateway.records.define(d.chain, { add_types: [{ name: TYPE, label: "Role definition", fields: [{ name: "name", kind: "text", label: "Name" }, { name: "body", kind: "text", label: "Definition" }, { name: "kit", kind: "text", label: "From Kit" }] }] });
        await d.gateway.records.create(d.chain, TYPE, data);
      }
      return { role: { ...role, builtin: false } };
    });

    tool("roles.update", "Change a custom role. The people who hold it get the new access at once. Owner and admin only.", obj({ space: str, id: str, role: { type: "object" } }, ["id", "role"]), "write", async (i, d) => {
      const mine = await staff(d);
      const c = (await readRoles(d.gateway, d.chain)).get(String(i.id));
      if (!c) throw refuse(`There is no custom role "${i.id}". roles.list shows the roles of this Space.`, "not_found");
      const t = await types(d.gateway, d.chain);
      const next = checkRole({ ...c.role, ...(i.role && typeof i.role === "object" ? i.role : {}), id: c.role.id }, { types: t });
      if (!mayHold(mine, next.base) || !mayHold(mine, c.role.base)) throw refuse("Only an owner changes a role that starts from Admin. Ask the owner.", "not_allowed");
      await d.gateway.records.update(d.chain, TYPE, c.row, { body: bodyOf(next) }, c.version);
      const holders = (await people(d)).filter(m => m.custom === next.id);
      const failed = [];
      for (const m of holders) {
        try { await d.gateway.grants.setRole(d.chain, { person: m.person, role: next.base, custom: { id: next.id, grants: expandRole(next, { space: d.space, person: m.person, types: t }) } }, withProof(d)); }
        catch (/** @type {any} */ e) { failed.push({ person: m.person, reason: String(e && e.message) }); }
      }
      return { role: { ...next, builtin: false }, reapplied: holders.length - failed.length, ...(failed.length ? { failed } : {}) };
    });

    tool("roles.remove", "Delete a custom role. Refused while anyone holds it. Owner and admin only.", obj({ space: str, id: str }, ["id"]), "write", async (i, d) => {
      const mine = await staff(d);
      const c = (await readRoles(d.gateway, d.chain)).get(String(i.id));
      if (!c) throw refuse(`There is no custom role "${i.id}". roles.list shows the roles of this Space.`, "not_found");
      if (!mayHold(mine, c.role.base)) throw refuse("Only an owner removes a role that starts from Admin. Ask the owner.", "not_allowed");
      const holders = (await people(d)).filter(m => m.custom === c.role.id).map(m => m.person);
      if (holders.length) throw Object.assign(refuse(`${holders.length} ${holders.length === 1 ? "person holds" : "people hold"} this role. Give them another role first (roles.assign), then remove it.`, "role_in_use"), { people: holders });
      const cur = await d.gateway.records.get(d.chain, TYPE, c.row);
      await d.gateway.records.remove(d.chain, TYPE, c.row, cur ? cur.version : c.version);
      return { removed: true };
    });

    tool("roles.assign", "Give a person a role: Owner, Admin, Member, Guest (a Guest needs scope and expires) or a custom one. An admin cannot give a role at or above Admin.", obj({ space: str, person: str, role: str, scope: { type: "array", items: str }, expires: { type: "integer" } }, ["person", "role"]), "write", async (i, d) => {
      const mine = await staff(d);
      const asked = String(i.role), kernelId = /** @type {any} */ (ALIASES)[asked] || asked;
      const base = { person: String(i.person), ...(Array.isArray(i.scope) ? { scope: i.scope.map(String) } : {}), ...(i.expires ? { expires: i.expires } : {}) };
      if (ROLE_IDS.includes(kernelId)) {
        if (!mayHold(mine, kernelId)) throw refuse(`A${mine === "admin" ? "n admin" : " " + mine} cannot give the ${asked} role. Ask the owner.`, "not_allowed");
        return { membership: (await d.gateway.grants.setRole(d.chain, { ...base, role: kernelId }, withProof(d))).membership };
      }
      const c = (await readRoles(d.gateway, d.chain)).get(asked);
      if (!c) throw refuse(`There is no role "${asked}". roles.list shows the roles of this Space.`, "not_found");
      if (!mayHold(mine, c.role.base)) throw refuse("Only an owner gives a role that starts from Admin. Ask the owner.", "not_allowed");
      const grants = expandRole(c.role, { space: d.space, person: base.person, types: await types(d.gateway, d.chain) });
      return { membership: (await d.gateway.grants.setRole(d.chain, { person: base.person, role: c.role.base, custom: { id: c.role.id, grants } }, withProof(d))).membership };
    });
    return { async stop() {} };
  },
};
