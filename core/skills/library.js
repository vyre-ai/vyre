// @ts-check
// The library's storage and approvals (R031-18, 20, 21). Every skill and plugin is a `skill` record per version; a draft is written by anyone (a person, their assistant, an agent for itself, @Engineer,
// the learn module) and does nothing until the level's owner approves it with their own yes. Reads and writes go through the module's service chain, after the rules here have judged the caller,
// the same way core/work keeps projects: the caller's own grants decide only who the caller is.
//
//   draft      a new version in state draft (the same text twice is the same draft)
//   approve    the owner's yes: this version is the one in use, the one before is retired. A plugin with code needs the acknowledgement of exactly what it declares
//   rollback   an earlier version, written again as a new approved one
//   approved / versions   what is in use for a caller, and the history of one skill

import { PLUGIN_LAYOUT } from "../sessions/drivers/plugin-layout.js";
import { validName, skillProblems, pluginProblems, hashOf, hasCode, ackOf, declared, visibleFor, LEVELS } from "../../lib/skill-library.js";

const TYPE = "skill";
const fail = (/** @type {string} */ code, /** @type {string} */ message, /** @type {any} */ more = {}) => Object.assign(new Error(message), { code, ...more });

/**
 * @param {{ kernel: () => any, agentOwner: (name: string) => Promise<string | null>, projectOwner: (slug: string) => Promise<string | null>, mcpAdd?: (server: any) => Promise<any>, log?: (m: string) => void }} o
 */
export function createLibrary({ kernel, agentOwner, projectOwner, mcpAdd, log = () => {} }) {
  const svc = () => kernel().serviceChain("skills");
  const q = async (/** @type {any} */ filter) => (await kernel().records.query(svc(), TYPE, { ...(filter ? { filter } : {}), page: { limit: 500 } })).rows;
  const shape = (/** @type {any} */ r, withBody = false) => ({ id: `${r.data.level}${r.data.scope ? "/" + r.data.scope : ""}/${r.data.name}`, name: r.data.name, level: r.data.level, scope: r.data.scope || "", version: r.data.version, state: r.data.state, kind: r.data.kind, owner: r.data.owner || null, proposer: r.data.proposer || null, ...(r.data.note ? { note: r.data.note } : {}), hash: r.data.hash, ...(withBody ? { body: r.data.body } : {}) });
  const isAdmin = async (/** @type {any} */ person) => { const m = kernel().membership ? await kernel().membership(person.id) : null; return Boolean(m && (m.role === "owner" || m.role === "admin")); };
  const personOf = (/** @type {any} */ chain) => { const h = chain && chain.hops && chain.hops[0]; return h && h.actor.kind === "person" ? h.actor : null; };
  const agentOf = (/** @type {any} */ chain) => { const h = (chain && chain.hops || []).find((/** @type {any} */ x) => x.actor.kind === "agent"); return h ? String(h.actor.id) : null; };
  const key = (/** @type {string} */ name, /** @type {string} */ level, /** @type {string} */ scope) => ({ and: [{ field: "name", op: "eq", value: name }, { field: "level", op: "eq", value: level }, { field: "scope", op: "eq", value: scope }] });
  const history = async (/** @type {string} */ name, /** @type {string} */ level, /** @type {string} */ scope) => (await q(key(name, level, scope))).sort((/** @type {any} */ a, /** @type {any} */ b) => b.data.version - a.data.version);

  /** Whose yes a level needs: the person for personal, the agent's or project's owner, else (space, or an owner unknown) an owner or an admin. */
  async function ownerOfLevel(level, scope) {
    if (level === "personal") return scope;
    if (level === "agent") return await agentOwner(scope);
    if (level === "project") return await projectOwner(scope);
    return null;
  }
  async function mayApprove(person, level, scope, owner) {
    if (level === "personal") return person.id === scope;
    return (owner ? person.id === owner : false) || (await isAdmin(person));
  }

  function checkBody(kind, name, body) {
    if (kind === "plugin") {
      let p; try { p = JSON.parse(body); } catch { throw fail("bad_input", "a plugin is JSON"); }
      const problems = pluginProblems(p, PLUGIN_LAYOUT);
      if (problems.length) throw fail("bad_input", `that plugin is not valid: ${problems.slice(0, 4).join("; ")}${problems.length > 4 ? ` (and ${problems.length - 4} more)` : ""}`, { errors: problems });
      if (p.name !== name) throw fail("bad_input", `the plugin's name is ${name}`);
      return p;
    }
    const problems = skillProblems(name, body);
    if (problems.length) throw fail("bad_input", `that skill is not valid: ${problems.join("; ")}`, { errors: problems });
    return null;
  }

  /** A new draft version. @param {any} chain the caller's chain (a person, or a person with an assistant) @param {{ name: string, level: string, scope?: string, kind?: string, body: string, note?: string, proposer?: string }} i */
  async function draft(chain, i) { return draftAs(personOf(chain), agentOf(chain), i); }
  /** A draft for a named person with no chain of theirs (learn's lesson, drafted for the install's owner): a draft only, written by the service; approving stays the person's. @param {string} personId @param {any} i */
  function draftFor(personId, i) { return draftAs({ kind: "person", id: String(personId) }, null, i); }
  /** @param {any} person @param {string | null} agent @param {any} i */
  async function draftAs(person, agent, i) {
    if (!person) throw fail("not_allowed", "a skill is drafted for a person: by them, or by their assistant or an agent working for them");
    const level = String(i.level || ""), name = String(i.name || ""), kind = i.kind === "plugin" ? "plugin" : "skill";
    if (!LEVELS.includes(level)) throw fail("bad_input", `level is one of ${LEVELS.join(", ")}`);
    if (!validName(name)) throw fail("bad_input", "a skill's name is lower-case letters, digits, dots, dashes and underscores");
    let scope = String(i.scope ?? "");
    if (level === "space") scope = "";
    else if (level === "personal") { scope = scope || person.id; if (scope !== person.id) throw fail("not_allowed", "a personal skill is drafted for yourself"); }
    else if (!scope) throw fail("bad_input", `name the ${level} this is for (scope)`);
    if (level === "agent" && agent && agent !== scope && !(await isAdmin(person)) && (await agentOwner(scope)) !== person.id) throw fail("not_allowed", `an agent drafts skills for itself; ${agent} is not ${scope}`);
    const body = String(i.body ?? "");
    const p = checkBody(kind, name, body);
    const have = await history(name, level, scope);
    const hash = hashOf(body);
    const same = have.find((/** @type {any} */ r) => r.data.state === "draft" && r.data.hash === hash);
    if (same) return { ...shape(same), existing: true, ...(p && hasCode(p) ? { declares: declared(p), ack: ackOf(p) } : {}) };
    const owner = await ownerOfLevel(level, scope);
    const rec = await kernel().records.create(svc(), TYPE, { name, level, scope, version: (have[0] ? have[0].data.version : 0) + 1, state: "draft", kind, body, hash, owner: owner || "", proposer: i.proposer || (agent ? `agent:${agent}` : `person:${person.id}`), ...(i.note ? { note: String(i.note).slice(0, 500) } : {}) });
    return { ...shape(rec), ...(p && hasCode(p) ? { declares: declared(p), ack: ackOf(p) } : {}) };
  }

  /** Make a version the one in use, retiring the one before. `as` is the approving person. @param {any} rec @param {any} as */
  async function make(rec, as, note) {
    const same = await history(rec.data.name, rec.data.level, rec.data.scope || "");
    for (const r of same.filter((/** @type {any} */ x) => x.data.state === "approved" && x.id !== rec.id)) await kernel().records.update(svc(), TYPE, r.id, { state: "retired" }, r.version);
    const done = await kernel().records.update(svc(), TYPE, rec.id, { state: "approved", ...(note ? { note } : {}) }, rec.version);
    let connections = [];
    if (done.data.kind === "plugin" && mcpAdd) {
      const p = JSON.parse(String(done.data.body));
      for (const m of p.mcp || []) {
        try { await mcpAdd({ name: `p-${p.name}-${m.name}`.slice(0, 32), transport: m.transport, ...(m.command ? { command: m.command, args: m.args || [] } : {}), ...(m.url ? { url: m.url } : {}) }); connections.push(`p-${p.name}-${m.name}`.slice(0, 32)); }
        catch (e) { log(`skills: could not add the Connection for ${p.name}/${m.name}: ${/** @type {Error} */ (e).message}`); }
      }
    }
    return { ...shape(done), approved_by: as.id, ...(connections.length ? { connections } : {}) };
  }

  /** The owner's yes. A person's own act (a chain of exactly one person). @param {any} chain @param {{ name: string, level: string, scope?: string, version: number, ack?: string }} i */
  async function approve(chain, i) {
    const person = chain && chain.hops && chain.hops.length === 1 && chain.hops[0].actor.kind === "person" ? chain.hops[0].actor : null;
    if (!person) throw fail("not_allowed", "an approval is a person's own: an assistant drafts and proposes, the owner says yes");
    return applyApproval(person, i);
  }
  async function applyApproval(person, i) {
    const scope = i.level === "space" ? "" : i.level === "personal" ? String(i.scope || person.id) : String(i.scope ?? "");
    const have = await history(String(i.name), String(i.level), scope);
    const rec = have.find((/** @type {any} */ r) => r.data.version === Number(i.version));
    if (!rec) throw fail("not_found", `no version ${i.version} of ${i.name}`);
    if (!(await mayApprove(person, rec.data.level, rec.data.scope || "", rec.data.owner || null))) throw fail("not_allowed", `only ${rec.data.owner ? "its owner" : "an owner or an admin"} approves a ${rec.data.level} ${rec.data.kind}`);
    if (rec.data.state === "approved") return shape(rec);
    if (rec.data.state === "retired") throw fail("bad_state", "that version was retired; draft it again or roll back to it");
    if (rec.data.kind === "plugin") {
      const p = JSON.parse(String(rec.data.body));
      if (hasCode(p) && i.ack !== ackOf(p)) throw fail("needs_ack", `${p.name} has code: it declares ${JSON.stringify(declared(p))}. Approve with ack: "${ackOf(p)}" to say yes to exactly that`, { declares: declared(p), ack: ackOf(p) });
    }
    return make(rec, person);
  }

  /** An earlier version written again as a new approved one. @param {any} chain @param {{ name: string, level: string, scope?: string, to: number, ack?: string }} i */
  async function rollback(chain, i) {
    const person = chain && chain.hops && chain.hops.length === 1 && chain.hops[0].actor.kind === "person" ? chain.hops[0].actor : null;
    if (!person) throw fail("not_allowed", "a rollback is a person's own");
    const scope = i.level === "space" ? "" : i.level === "personal" ? String(i.scope || person.id) : String(i.scope ?? "");
    const have = await history(String(i.name), String(i.level), scope);
    const old = have.find((/** @type {any} */ r) => r.data.version === Number(i.to));
    if (!old) throw fail("not_found", `no version ${i.to} of ${i.name}`);
    if (!(await mayApprove(person, old.data.level, scope, old.data.owner || null))) throw fail("not_allowed", "only the owner rolls a skill back");
    if (old.data.kind === "plugin") { const p = JSON.parse(String(old.data.body)); if (hasCode(p) && i.ack !== ackOf(p)) throw fail("needs_ack", `${p.name} has code: approve with ack: "${ackOf(p)}"`, { declares: declared(p), ack: ackOf(p) }); }
    const rec = await kernel().records.create(svc(), TYPE, { name: old.data.name, level: old.data.level, scope, version: have[0].data.version + 1, state: "draft", kind: old.data.kind, body: old.data.body, hash: old.data.hash, owner: old.data.owner || "", proposer: `person:${person.id}`, note: `rolled back to version ${i.to}` });
    return make(rec, person, `rolled back to version ${i.to}`);
  }

  /** Every version of the library, or of one skill; the drafts waiting are state draft. @param {{ name?: string, level?: string, scope?: string, state?: string }} [f] */
  async function versions(f = {}) {
    const rows = (await q(f.name ? key(f.name, String(f.level || "space"), f.level === "space" ? "" : String(f.scope || "")) : undefined)).filter((/** @type {any} */ r) => (!f.state || r.data.state === f.state) && (!f.level || r.data.level === f.level));
    return rows.sort((/** @type {any} */ a, /** @type {any} */ b) => (a.data.name === b.data.name ? b.data.version - a.data.version : a.data.name < b.data.name ? -1 : 1)).map((/** @type {any} */ r) => shape(r));
  }
  /** The approved items a caller sees, with their bodies. @param {{ person?: string | null, agent?: string | null, projects?: string[], agents?: string[], allAgents?: boolean }} who */
  async function approved(who) {
    let rows = [];
    try { rows = await q({ field: "state", op: "eq", value: "approved" }); } catch { return []; }
    return visibleFor(rows.map((/** @type {any} */ r) => ({ ...r.data, id: r.id })), who);
  }
  async function get(/** @type {string} */ name, /** @type {string} */ level, /** @type {string} */ scope, /** @type {number} */ version) {
    const rec = (await history(name, level, level === "space" ? "" : scope)).find((/** @type {any} */ r) => r.data.version === version);
    if (!rec) throw fail("not_found", `no version ${version} of ${name}`);
    return rec;
  }
  return { draft, draftFor, approve, applyApproval, rollback, versions, approved, get, history, ownerOfLevel, mayApprove };
}
