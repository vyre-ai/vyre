// @ts-check
// sharing: who else may use or edit a vault item, as kernel grants (the same mechanism as an agent's sharing: core/agents/config.js agents.access.*). A grant is vault.use (use the item without seeing it) or
// vault.edit (also change or replace it) on the item's address, made through the vault module's mint handle (needs.kernel.mints, prefix "vault"), for a person only for now. This is not vault.grant: that scopes
// an item to a module, a watcher or a project. The vault's tools are the owner's (core/vault/member-gate.js), so only the owner shares an item; the grant is what a later reader of a shared item asks the kernel.
// Deleting the item takes its sharing with it (access.js revokeItem ends every grant under the item's address).

import { presence, quoted } from "./presence.js";

const PEOPLE = ["cli", "local", "deck", "capsule"];
const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const bad = (/** @type {string} */ m) => Object.assign(new Error(m), { code: "bad_input" });
const PERSON = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;

/** The one source a person's sharing of an item carries. */
export const sourceOf = (/** @type {string} */ item, /** @type {string} */ person) => `vault:share:${item}:${person}`;

/**
 * @param {{ ctx: any, vault: import("../vault.js").Vault,
 *   tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void }} o
 */
export function register({ ctx, vault, tool }) {
  const mint = () => { const m = ctx.kernel && ctx.kernel.mint; if (!m) throw Object.assign(new Error("sharing a vault item needs the kernel"), { code: "unavailable" }); return m; };
  const item = (/** @type {any} */ name) => { const r = vault.row(String(name || "")); if (!r) throw Object.assign(new Error(`no item named ${String(name).slice(0, 80)}`), { code: "not_found" }); return r; };
  const urnOf = async (/** @type {string} */ name) => /** @type {any} */ (vault).access.urn(name);
  /** @param {string} name */
  const sharedWith = async name => {
    const gs = (await mint().list({ source: `vault:share:${name}:` })) || [];
    return gs.filter((/** @type {any} */ g) => g.subject && g.subject.actor).map((/** @type {any} */ g) => ({ kind: "person", subject: String(g.subject.actor.id), level: g.actions.includes("vault.edit") ? "edit" : "use" }));
  };

  tool("vault.access.get", PEOPLE, "Who an item is shared with (Can use or Can edit), and the people who could be picked. Never a value.",
    obj({ name: str }, ["name"]), async ({ name }, meta) => {
      item(name);
      let people = [];
      try {
        const chain = await ctx.kernel.chain(meta);
        const ms = ctx.kernel.grants && ctx.kernel.grants.members ? await ctx.kernel.grants.members.list(chain) : [];
        people = (Array.isArray(ms) ? ms : []).map((/** @type {any} */ m) => ({ id: String(m.person), name: String(m.name || m.display_name || m.person), role: String(m.role || "") }));
      } catch { people = []; }
      return { access: await sharedWith(String(name)), people };
    });

  tool("vault.access.set", PEOPLE, "Share an item with a person: Can use (uses it without seeing the value) or Can edit (also changes or replaces it). level null takes the access away.",
    obj({ name: str, kind: { type: "string", enum: ["person"] }, subject: str, level: { type: ["string", "null"], enum: ["use", "edit", null] } }, ["name", "kind", "subject"]),
    async ({ name, kind, subject, level }) => {
      item(name);
      if (kind !== "person") throw bad("an item is shared with a person for now; a role comes later");
      if (typeof subject !== "string" || !PERSON.test(subject)) throw bad("name the person to share with");
      if (level !== null && level !== undefined && !["use", "edit"].includes(level)) throw bad("level is use, edit or null");
      const m = mint();
      const n = String(name);
      await m.end({ source: sourceOf(n, subject), reason: "the sharing of this item changed" });
      if (level) await m.make({ subject: { kind: "actor", actor: { kind: "person", id: subject, space: ctx.kernel.space } }, actions: level === "edit" ? ["vault.use", "vault.edit"] : ["vault.use"], resource: { prefix: await urnOf(n) }, source: sourceOf(n, subject), reason: `shared by the owner: ${level}` });
      vault.audit(level ? "share" : "unshare", n, "owner", true, `${subject}${level ? ` (${level})` : ""}`);
      return { ok: true };
    },
    presence("Share a vault item", ({ name, subject, level }) => level ? `Let ${String(subject).slice(0, 64)} ${level === "edit" ? "use and edit" : "use"} ${quoted(name)}` : `Stop sharing ${quoted(name)} with ${String(subject).slice(0, 64)}`));
}
