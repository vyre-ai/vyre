// @ts-check
// named: vaults inside a Space (vault.named.*). A vault is the kernel's own record (a name and an owner, grants.vaults); an item sits in one by a `named` column that is signed with its row; its address
// (vyre://<space>/vault/<vault>/item/<name>) follows the vault, so one grant on the vault covers every item in it. Sharing a whole vault is that one grant, for a person, a team, an agent or everyone in the
// Space (the two Space-wide groups: every member at the chosen level, every agent at Fill in). Moving an item takes back what was shared on its old address. The owner's surfaces only; the kernel decides
// who may make or remove a vault, and nothing here shows a value.

import { presence, quoted } from "./presence.js";
import { levelActions } from "../../../kernel/seal/uses.js";

const PEOPLE = ["cli", "local", "deck", "capsule"];
const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const bad = (/** @type {string} */ m) => Object.assign(new Error(m), { code: "bad_input" });
const KINDS = ["person", "team", "agent", "everyone"];
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;
const SHARE_LEVELS = ["use", "reveal", "edit"];

/** The one source a share of a whole vault with one grantee carries. */
export const vsource = (/** @type {string} */ vault, /** @type {string} */ who) => `vault:vshare:${vault}:${who}`;

/** @param {{ ctx: any, vault: import("../vault.js").Vault, tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void }} o */
export function register({ ctx, vault, tool }) {
  const K = () => { const k = ctx.kernel; if (!k || !k.grants || !k.grants.vaults || !k.mint) throw Object.assign(new Error("named vaults need the kernel"), { code: "unavailable" }); return k; };
  const chainOf = async (/** @type {any} */ meta) => K().chain(meta);
  const vaultsOf = async (/** @type {any} */ meta) => /** @type {any[]} */ (await K().grants.vaults.list(await chainOf(meta)));
  const known = async (/** @type {any} */ meta, /** @type {string} */ id) => { const v = (await vaultsOf(meta)).find(x => x.id === id && !x.personal); if (!v) throw Object.assign(new Error(`no vault with the id ${String(id).slice(0, 60)}: check the id on your Vaults page, or ask the vault's owner`), { code: "not_found" }); return v; };
  const rows = () => /** @type {any[]} */ (vault.db.prepare("SELECT id, name, named FROM vault_items").all());
  const members = async (/** @type {any} */ meta) => { try { const ms = K().grants.members ? await K().grants.members.list(await chainOf(meta)) : null; return Array.isArray(ms) ? ms : null; } catch { return null; } };
  const teams = async (/** @type {any} */ meta) => { try { const ts = K().grants.teams ? await K().grants.teams.list(await chainOf(meta)) : null; return Array.isArray(ts) ? ts : null; } catch { return null; } };
  const agentUid = async (/** @type {string} */ name) => { try { const r = await ctx.call("agents.uid", { name: String(name).toLowerCase() }); return r && r.data ? String(r.data.uid) : null; } catch { return null; } };
  const shared = async (/** @type {string} */ id) => (await K().mint.list({ source: vsource(id, "") })) || [];

  tool("vault.named.create", PEOPLE, "Make a vault of your own in this Space, apart from the rest: a name. You hold it and decide who else does.", obj({ name: str }, ["name"]),
    async ({ name }, meta) => ({ vault: await K().grants.vaults.set(await chainOf(meta), { name: String(name || "") }) }),
    presence("Make a vault", ({ name }) => `Make a vault called ${quoted(name)}`));

  tool("vault.named.list", PEOPLE, "The vaults you hold or were given: name, how many items, and who holds each. Never a value.", obj({}), async (_i, meta) => {
    const items = rows();
    const out = [];
    for (const v of await vaultsOf(meta)) out.push({ id: v.id, name: v.name, personal: Boolean(v.personal), owner: v.owner, items: items.filter(r => r.named === v.id).length, shared: (await shared(v.id)).length });
    // who can be picked for a share (the owner's view: every member, team and agent of the Space)
    const ms = (await members(meta)) || [], ts = (await teams(meta)) || [];
    const al = await ctx.call("agents.list", {}).catch(() => null);
    const ar = al && Array.isArray(al.data) ? al.data : al && al.data && Array.isArray(al.data.agents) ? al.data.agents : [];
    return { vaults: out, directory: {
      people: ms.map((/** @type {any} */ m) => ({ id: String(m.person), name: String(m.name || m.display_name || m.person), role: String(m.role || "") })),
      teams: ts.map((/** @type {any} */ t) => ({ id: String(t.id), name: String(t.name), people: [...(t.members || [])], agents: [...(t.agents || [])] })),
      agents: ar.filter((/** @type {any} */ a) => a && (a.uid || a.id) && a.name).map((/** @type {any} */ a) => ({ id: String(a.uid || a.id), name: String(a.name) })) } };
  });

  tool("vault.named.move", PEOPLE, "Put an item in a vault, or back in the Space's own (vault null). What was shared on the item at its old place is taken back; the new vault's shares apply.", obj({ item: str, vault: { type: ["string", "null"] } }, ["item"]),
    async ({ item, vault: to }, meta) => {
      const r = vault.row(String(item || ""));
      if (!r) throw Object.assign(new Error(`no item named ${String(item).slice(0, 80)}: check the name in the vault, or ask who made it`), { code: "not_found" });
      if (to !== null && to !== undefined) await known(meta, String(to));
      const old = await vault.access.urn(r.name);
      await K().vault.takeBack({ prefix: old, reason: "the item moved to another vault" });
      vault.db.prepare("UPDATE vault_items SET named = ? WHERE name = ?").run(to ?? null, r.name);
      vault.sign("vault_items", r.id);
      vault.audit("move", r.name, "owner", true, to ? `vault:${to}` : "the Space's own");
      return { moved: r.name, vault: to ?? null };
    },
    presence("Move an item to another vault", ({ item, vault: to }) => `Move ${quoted(item)} ${to ? "to another vault; its holders become the people and agents that vault is shared with" : "back to the Space's own, where only you hold it"}; what was shared on it is taken back`));

  tool("vault.named.remove", PEOPLE, "Remove an empty vault. Whatever was shared on it is taken back.", obj({ id: str }, ["id"]), async ({ id }, meta) => {
    await known(meta, String(id));
    if (rows().some(r => r.named === id)) throw bad("that vault is not empty: move its items out first");
    for (const g of await shared(String(id))) await K().mint.end({ source: g.source, reason: "the vault was removed" });
    return K().grants.vaults.remove(await chainOf(meta), String(id));
  }, presence("Remove a vault", () => "Remove an empty vault"));

  tool("vault.named.access.get", PEOPLE, "Who holds a whole vault: people, teams and agents, or everyone in the Space, each at Fill in, Read or Edit and rotate. Never a value.", obj({ vault: str }, ["vault"]), async ({ vault: id }, meta) => {
    await known(meta, String(id));
    const out = [];
    for (const g of await shared(String(id))) {
      const s = g.subject || {};
      const level = ["edit", "reveal", "use"].find(l => levelActions(l).every(a => (g.actions || []).includes(a))) || "use";
      if (s.kind === "group" && s.id === "space:agents") continue;
      if (s.kind === "group" && s.id === "space:people") out.push({ kind: "everyone", subject: "everyone", level });
      else if (s.kind === "group") out.push({ kind: "team", subject: String(s.id), level });
      else if (s.actor) out.push({ kind: s.actor.kind === "agent" ? "agent" : "person", subject: String(s.actor.id), level });
    }
    return { access: out };
  });

  tool("vault.named.access.set", PEOPLE, "Share a whole vault with a person, a team, an agent or everyone in the Space: level use (Fill in), reveal (Read) or edit (Edit and rotate); an agent only Fill in; everyone gives each member the level and each agent Fill in. level null takes it back.",
    obj({ vault: str, kind: { type: "string", enum: KINDS }, subject: str, level: { type: ["string", "null"], enum: [...SHARE_LEVELS, null] } }, ["vault", "kind", "subject"]),
    async ({ vault: id, kind, subject, level }, meta) => {
      await known(meta, String(id));
      if (!KINDS.includes(kind)) throw bad("a vault is shared with a person, a team, an agent or everyone");
      if (level !== null && level !== undefined && !SHARE_LEVELS.includes(level)) throw bad("level is use, reveal, edit or null");
      if (level && kind === "agent" && level !== "use") throw bad("an agent can only be given use (Fill in)");
      const k = K(), prefix = `vyre://${k.space}/vault/${id}`;
      /** @type {{ key: string, subject: any, actions: string[] }[]} */ const makes = [];
      if (kind === "everyone") makes.push({ key: "everyone:people", subject: { kind: "group", id: "space:people" }, actions: [...levelActions(level || "use")] }, { key: "everyone:agents", subject: { kind: "group", id: "space:agents" }, actions: [...levelActions("use")] });
      else {
        if (!ID.test(String(subject || ""))) throw bad(`name the ${kind} to share with`);
        if (kind === "person") { if (level) { const ms = await members(meta); if (!ms || !ms.some((/** @type {any} */ x) => String(x.person) === subject)) throw Object.assign(new Error("that person is not a member of this Space"), { code: "not_a_member" }); } makes.push({ key: subject, subject: { kind: "actor", actor: { kind: "person", id: subject, space: k.space } }, actions: [...levelActions(level || "use")] }); }
        if (kind === "team") { if (level) { const ts = await teams(meta); if (!ts || !ts.some((/** @type {any} */ x) => String(x.id) === subject)) throw Object.assign(new Error("there is no team with that id: take the id from the team's own page, or ask an owner or an admin"), { code: "not_found" }); } makes.push({ key: subject, subject: { kind: "group", id: subject }, actions: [...levelActions("use")] }); }
        if (kind === "agent") { const uid = (await agentUid(subject)) || (level ? null : subject); if (!uid) throw Object.assign(new Error("no agent has that name: check the name with the person who made the agent, or share with a person or a team instead"), { code: "not_found" }); makes.push({ key: uid, subject: { kind: "actor", actor: { kind: "agent", id: uid, space: k.space } }, actions: [...levelActions("use")] }); }
        if (kind === "team" && level) makes[0].actions = [...levelActions(level)];
      }
      for (const m of makes) {
        await k.mint.end({ source: vsource(String(id), m.key), reason: "the sharing of this vault changed" });
        if (level) await k.mint.make({ subject: m.subject, actions: m.actions, resource: { prefix }, source: vsource(String(id), m.key), reason: `shared by the owner: ${level}` });
      }
      vault.audit(level ? "share" : "unshare", `vault:${id}`, "owner", true, `${kind}:${subject}${level ? ` (${level})` : ""}`);
      return { ok: true };
    },
    presence("Share a whole vault", ({ vault: v, kind, subject, level }) => level ? `Let ${kind === "everyone" ? "everyone in the Space" : `${kind === "person" ? "" : `${kind} `}${String(subject).slice(0, 64)}`} use the vault ${quoted(v)} (${{ use: "fill in", reveal: "read", edit: "read, edit and rotate" }[/** @type {"use"|"reveal"|"edit"} */ (level)] || level})` : `Stop sharing the vault ${quoted(v)}`));
}
