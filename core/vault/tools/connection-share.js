// @ts-check
// connection-share: a member shares her own app connection (a Clio, a Google, a Notion) with a person, a team or an agent, at Fill in and nothing more. It is a kernel grant on the connection's address
// (connectionUrn), made through the vault module's mint handle, the same grant the hub checks before it lends a token's use (core/mcp). The token is never shared: the hub adds it at the boundary, so
// whoever holds the share can have the app used as her and never has the token. Anything that sends or changes data still waits at the Gate for her yes.
//
// Taking a share away, and deleting the connection, end the grants and tell the hub (mcp.sweep) to discard what those people left waiting at the Gate for it. The hub re-checks every requester anyway;
// the sweep is the cleanup the release gate asks for after every unshare.

import { presence, quoted } from "./presence.js";
import { MEMBER_SURFACES, memberOf } from "./me.js";
import { connectionUrn } from "../connection-token.js";
import { levelActions } from "../../../kernel/seal/uses.js";

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const bad = (/** @type {string} */ m) => Object.assign(new Error(m), { code: "bad_input" });
const KINDS = ["person", "team", "agent"];
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;

/** The one source a share of a connection with one grantee carries. */
export const csource = (/** @type {string} */ person, /** @type {string} */ name, /** @type {string} */ who) => `vault:cshare:${person}:${name}:${who}`;
const prefixOf = (/** @type {string} */ person, /** @type {string} */ name) => `vault:cshare:${person}:${name}:`;

/**
 * @param {{ ctx: any, people: import("../people.js").PeopleVaults, tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void }} o
 * @returns {{ onRemoved: (person: string, name: string) => Promise<void>, onMemberGone: (person: string) => Promise<void> }}
 */
export function register({ ctx, people, tool }) {
  const mint = () => { const m = ctx.kernel && ctx.kernel.mint; if (!m) throw Object.assign(new Error("sharing a connection needs the kernel"), { code: "unavailable" }); return m; };
  const sweep = async (/** @type {string} */ person, /** @type {string} */ name) => {
    try { await ctx.call("mcp.sweep", { owner: person, connection: name }); } catch (e) { ctx.log && ctx.log(`vault: mcp.sweep for ${name} failed: ${/** @type {Error} */ (e).message}`); }
  };
  const members = async (/** @type {any} */ meta) => { try { const c = await ctx.kernel.chain(meta); const ms = ctx.kernel.grants && ctx.kernel.grants.members ? await ctx.kernel.grants.members.list(c) : null; return Array.isArray(ms) ? ms : null; } catch { return null; } };
  const teams = async (/** @type {any} */ meta) => { try { const c = await ctx.kernel.chain(meta); const ts = ctx.kernel.grants && ctx.kernel.grants.teams ? await ctx.kernel.grants.teams.list(c) : null; return Array.isArray(ts) ? ts : null; } catch { return null; } };
  const agentUid = async (/** @type {string} */ name) => { try { const r = await ctx.call("agents.uid", { name: String(name).toLowerCase() }); return r && r.data ? String(r.data.uid) : null; } catch { return null; } };
  const own = async (/** @type {string} */ id, /** @type {string} */ name) => {
    if (!(await people.service(id).has(name))) throw Object.assign(new Error(`you have no connection named ${String(name).slice(0, 80)}`), { code: "not_found" });
  };

  tool("vault.me.connection.share", MEMBER_SURFACES, "Share one of your app connections with a person, a team or an agent, at Fill in only: they can have the app used as you and never get the token. level null takes the share away.",
    obj({ name: str, kind: { type: "string", enum: KINDS }, subject: str, level: { type: ["string", "null"], enum: ["use", null] } }, ["name", "kind", "subject"]),
    async (input, meta) => {
      const id = await memberOf(ctx.kernel, meta);
      const name = String(input.name || ""), { kind, subject } = input;
      let { level } = input;
      if (!KINDS.includes(kind)) throw bad("a connection is shared with a person, a team or an agent");
      if (typeof subject !== "string" || !SUBJECT.test(subject)) throw bad(`name the ${kind} to share with`);
      if (level === undefined) level = null;
      if (level !== null && level !== "use") throw bad("a connection is shared at Fill in only");
      await own(id, name);
      /** @type {any} */ let who, key = subject;
      if (kind === "person") who = { kind: "actor", actor: { kind: "person", id: subject, space: ctx.kernel.space } };
      if (kind === "team") who = { kind: "group", id: subject };
      if (kind === "agent") {
        // Only an agent she may instruct herself (she made it, or was given Can use or Can edit): one that others also instruct would let them use her connection through it. Anything else is not found.
        if (level) { const who = await ctx.call("agents.instructors", { agent: String(subject).toLowerCase() }); if (who.error || !who.data) throw Object.assign(new Error("no agent has that name"), { code: "not_found" }); }
        const uid = (await agentUid(subject)) || (level ? null : subject);
        if (!uid) throw Object.assign(new Error("no agent has that name"), { code: "not_found" });
        key = uid; who = { kind: "actor", actor: { kind: "agent", id: uid, space: ctx.kernel.space } };
      }
      if (level) {
        if (kind === "person") { const ms = await members(meta); if (!ms || !ms.some((/** @type {any} */ x) => String(x.person) === subject)) throw Object.assign(new Error("that person is not a member of this Space"), { code: "not_a_member" }); }
        if (kind === "team") { const ts = await teams(meta); if (!ts || !ts.some((/** @type {any} */ x) => String(x.id) === subject)) throw Object.assign(new Error("there is no team with that id"), { code: "not_found" }); }
      }
      const m = mint();
      await m.end({ source: csource(id, name, key), reason: "the sharing of this connection changed" });
      if (level) await m.make({ subject: who, actions: [...levelActions("use")], resource: { prefix: connectionUrn(ctx.kernel.space, id, name) }, source: csource(id, name, key), reason: "shared by its owner: Fill in" });
      else await sweep(id, name);
      return { ok: true };
    },
    presence("Share an app connection", ({ name, kind, subject, level }) => level ? `Let ${kind === "person" ? "" : `${kind} `}${String(subject).slice(0, 64)} use ${quoted(name)} as you, and only fill in` : `Stop sharing ${quoted(name)} with ${String(subject).slice(0, 64)}`));

  tool("vault.me.connection.shares", MEMBER_SURFACES, "Who one of your app connections is shared with: a person, a team or an agent, each at Fill in. Never the token.", obj({ name: str }, ["name"]),
    async (input, meta) => {
      const id = await memberOf(ctx.kernel, meta), name = String(input.name || "");
      await own(id, name);
      const gs = (await mint().list({ source: prefixOf(id, name) })) || [];
      return { shares: gs.map((/** @type {any} */ g) => { const s = g.subject || {}; return s.kind === "group" ? { kind: "team", subject: String(s.id), level: "use" } : { kind: s.actor && s.actor.kind === "agent" ? "agent" : "person", subject: String(s.actor && s.actor.id), level: "use" }; }) };
    });

  tool("vault.me.connection.directory", MEMBER_SURFACES, "Who a connection can be shared with: the other members, the groups, and the agents you may instruct (each with who else instructs it). Names and ids, never a value.", obj({}),
    async (_input, meta) => {
      const id = await memberOf(ctx.kernel, meta);
      const ms = (await members(meta)) || [], ts = (await teams(meta)) || [];
      const listed = await ctx.call("agents.list", {}).catch(() => null);
      const rows = listed && Array.isArray(listed.data) ? listed.data : listed && listed.data && Array.isArray(listed.data.agents) ? listed.data.agents : [];
      const agents = [];
      for (const a of rows) {
        if (!a || !(a.uid || a.id) || !a.name) continue;
        const who = await ctx.call("agents.instructors", { agent: String(a.name).toLowerCase() }).catch(() => null);
        if (!who || who.error || !who.data) continue;
        const others = [who.data.made_by, ...(Array.isArray(who.data.shares) ? who.data.shares : [])].filter((/** @type {any} */ x) => typeof x === "string" && x);
        agents.push({ id: String(a.uid || a.id), name: String(a.name), instructors: [...new Set([id, ...others])] });
      }
      return { people: ms.filter((/** @type {any} */ m) => String(m.person) !== id).map((/** @type {any} */ m) => ({ id: String(m.person), name: String(m.name || m.display_name || m.person), role: String(m.role || "") })),
        groups: ts.map((/** @type {any} */ t) => ({ id: String(t.id), name: String(t.name), people: [...(t.members || [])], agents: [...(t.agents || [])] })), agents };
    });

  return {
    /** A member left the Space (or her access ended): every share of every connection of hers ends and the hub is told once for each. */
    onMemberGone: async (person) => {
      const gs = (await mint().list({ source: `vault:cshare:${person}:` })) || [];
      const names = new Set();
      for (const g of gs) { await mint().end({ source: g.source, reason: "the member left" }); const n = String(g.source).slice(`vault:cshare:${person}:`.length).split(":")[0]; if (n) names.add(n); }
      for (const n of names) await sweep(person, n);
    },
    /** The connection was deleted (or its owner left): every share on it ends and the hub is told once. */
    onRemoved: async (person, name) => {
      const gs = (await mint().list({ source: prefixOf(person, name) })) || [];
      for (const g of gs) await mint().end({ source: g.source, reason: "the connection was removed" });
      await sweep(person, name);
    },
  };
}
