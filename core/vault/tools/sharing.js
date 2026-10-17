// @ts-check
// sharing: who else may use an item, as kernel grants on the item's address, made through the vault module's mint handle (needs.kernel.mints, prefix "vault"). The grantee is a person, a team (a
// group of people, and after the kernel's team change of agents too) or an agent, at one of the kernel's access levels (kernel/seal/uses.js): `use` is "Fill in" (use it without seeing the value),
// `reveal` is "Read" (also see the value on their own screen) and `edit` is "Edit and rotate" (also change it and replace the key at its service). An agent can only be given `use`: the kernel refuses
// anything more. Manage (delete, share, hand out access) is the owner's and is not offered here. This is not vault.grant: that scopes an item to a module, a watcher or a project. The vault's
// tools are the owner's (core/vault/member-gate.js), so only the owner shares an item; the grant is what a later reader of a shared item asks the kernel.
// Deleting the item takes its sharing with it (access.js revokeItem ends every grant under the item's address).

import { presence, quoted } from "./presence.js";
import { levelActions, levelOf } from "../../../kernel/seal/uses.js";

const PEOPLE = ["cli", "local", "deck", "capsule"];
const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const bad = (/** @type {string} */ m) => Object.assign(new Error(m), { code: "bad_input" });
const PERSON = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;
/** What a person can pick, in the order of the share sheet: the kernel's names, the owner's words in the label. */
export const SHARE_LEVELS = Object.freeze(["use", "reveal", "edit"]);
const KINDS = ["person", "team", "agent"];

/** The one source a sharing of an item with one grantee carries. */
export const sourceOf = (/** @type {string} */ item, /** @type {string} */ who) => `vault:share:${item}:${who}`;

/** The level of a grant made before the kernel's levels (vault.use, vault.edit): edit when it could edit, else use. @param {string[]} actions */
const levelOfGrant = actions => levelOf(actions) || (actions.includes("vault.edit") ? "edit" : "use");

/**
 * @param {{ ctx: any, vault: import("../vault.js").Vault,
 *   tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void }} o
 */
export function register({ ctx, vault, tool }) {
  const mint = () => { const m = ctx.kernel && ctx.kernel.mint; if (!m) throw Object.assign(new Error("sharing a vault item needs the kernel"), { code: "unavailable" }); return m; };
  const item = (/** @type {any} */ name) => { const r = vault.row(String(name || "")); if (!r) throw Object.assign(new Error(`no item named ${String(name).slice(0, 80)}: vault.list shows the items you can share`), { code: "not_found" }); return r; };
  const urnOf = async (/** @type {string} */ name) => /** @type {any} */ (vault).access.urn(name);
  const space = () => ctx.kernel.space;
  const members = async (/** @type {any} */ meta) => { try { const chain = await ctx.kernel.chain(meta); const ms = ctx.kernel.grants && ctx.kernel.grants.members ? await ctx.kernel.grants.members.list(chain) : null; return Array.isArray(ms) ? ms : null; } catch { return null; } };
  const teams = async (/** @type {any} */ meta) => { try { const chain = await ctx.kernel.chain(meta); const ts = ctx.kernel.grants && ctx.kernel.grants.teams ? await ctx.kernel.grants.teams.list(chain) : null; return Array.isArray(ts) ? ts : null; } catch { return null; } };
  /** An agent's stable id, or null. @param {string} name */
  const agentUid = async name => { try { const r = await ctx.call("agents.uid", { name: String(name).toLowerCase() }); return r && r.data ? String(r.data.uid) : null; } catch { return null; } };
  /** The agents of the Space, by stable id, for the share sheet (the owner may instruct every one). */
  const agentList = async () => { try { const r = await ctx.call("agents.list", {}); const xs = r && Array.isArray(r.data) ? r.data : r && r.data && Array.isArray(r.data.agents) ? r.data.agents : []; return xs.filter((/** @type {any} */ a) => a && (a.uid || a.id) && a.name).map((/** @type {any} */ a) => ({ id: String(a.uid || a.id), name: String(a.name) })); } catch { return []; } };
  /** @param {string} name */
  const sharedWith = async name => {
    const gs = (await mint().list({ source: `vault:share:${name}:` })) || [];
    const out = [];
    for (const g of gs) {
      const s = g.subject || {};
      const level = levelOfGrant(g.actions || []);
      if (s.kind === "group") out.push({ kind: "team", subject: String(s.id), level });
      else if (s.actor && s.actor.kind === "agent") out.push({ kind: "agent", subject: String(s.actor.id), level });
      else if (s.actor) out.push({ kind: "person", subject: String(s.actor.id), level });
    }
    return out;
  };

  tool("vault.access.get", PEOPLE, "Who an item is shared with (a person, a team or an agent, at Fill in, Read or Edit and rotate), and who could be picked. Never a value.",
    obj({ name: str }, ["name"]), async ({ name }, meta) => {
      item(name);
      const ms = (await members(meta)) || [];
      const ts = (await teams(meta)) || [];
      return {
        access: await sharedWith(String(name)),
        levels: [...SHARE_LEVELS],
        people: ms.map((/** @type {any} */ m) => ({ id: String(m.person), name: String(m.name || m.display_name || m.person), role: String(m.role || "") })),
        teams: ts.map((/** @type {any} */ t) => ({ id: String(t.id), name: String(t.name), people: [...(t.members || [])], agents: [...(t.agents || [])] })),
        agents: await agentList(),
      };
    });

  tool("vault.access.set", PEOPLE, "Share an item with a person, a team or an agent: level use (Fill in), reveal (Read) or edit (Edit and rotate); an agent only gets use. level null takes the access away.",
    obj({ name: str, kind: { type: "string", enum: KINDS }, subject: str, level: { type: ["string", "null"], enum: [...SHARE_LEVELS, null] } }, ["name", "kind", "subject"]),
    async ({ name, kind, subject, level }, meta) => {
      item(name);
      if (!KINDS.includes(kind)) throw bad("an item is shared with a person, a team or an agent");
      if (typeof subject !== "string" || !PERSON.test(subject)) throw bad(`name the ${kind} to share with`);
      if (level !== null && level !== undefined && !SHARE_LEVELS.includes(level)) throw bad("level is use, reveal, edit or null");
      if (level && kind === "agent" && level !== "use") throw bad("an agent can only be given use (Fill in): it never sees a value and never changes one");
      const m = mint();
      const n = String(name);
      /** @type {any} */ let who = null, key = subject;
      if (kind === "person") who = { kind: "actor", actor: { kind: "person", id: subject, space: space() } };
      if (kind === "team") who = { kind: "group", id: subject };
      if (kind === "agent") {
        // Taking access away still works for an agent that was renamed or removed: the name is tried first, then the id as given.
        const uid = (await agentUid(subject)) || (level ? null : subject);
        if (!uid) throw Object.assign(new Error("no agent has that name"), { code: "not_found" });
        key = uid; who = { kind: "actor", actor: { kind: "agent", id: uid, space: space() } };
      }
      // A grant is made only for a current member, a team that exists or an agent of the Space (taking one away needs no check); a kernel that cannot say is refused.
      if (level) {
        if (kind === "person") { const ms = await members(meta); if (!ms || !ms.some((/** @type {any} */ x) => String(x.person) === subject)) throw Object.assign(new Error("that person is not a member of this Space"), { code: "not_a_member" }); }
        if (kind === "team") { const ts = await teams(meta); if (!ts || !ts.some((/** @type {any} */ x) => String(x.id) === subject)) throw Object.assign(new Error("there is no team with that id"), { code: "not_found" }); }
      }
      await m.end({ source: sourceOf(n, key), reason: "the sharing of this item changed" });
      if (level) await m.make({ subject: who, actions: [...levelActions(level)], resource: { prefix: await urnOf(n) }, source: sourceOf(n, key), reason: `shared by the owner: ${level}` });
      vault.audit(level ? "share" : "unshare", n, "owner", true, `${kind}:${subject}${level ? ` (${level})` : ""}`);
      return { ok: true };
    },
    presence("Share a vault item", ({ name, kind, subject, level }) => level ? `Let ${kind === "person" ? "" : `${kind} `}${String(subject).slice(0, 64)} ${{ use: "fill in", reveal: "read", edit: "read, edit and rotate" }[/** @type {"use"|"reveal"|"edit"} */ (level)] || level} ${quoted(name)}` : `Stop sharing ${quoted(name)} with ${String(subject).slice(0, 64)}`));
}
