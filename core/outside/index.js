// @ts-check
// outside: Vyre as the home base of agents that are not Vyre sessions (R032-13; team/contracts/ext-agents.md). A person registers an outside agent (Dots, Muse, Hermes, ChatGPT, their own Claude Code on
// another machine), gives it a token and chosen reach, and it speaks MCP at /agents-mcp. It is a kernel actor of its own (`ext_<id>`, no person behind it): the kernel decides every read from the grants the
// person gave it, a write waits at the Gate for the person's yes, every use is an event, and ending it takes everything back at once.
import { PERSON_SURFACES } from "../../lib/caller.js";
import { LIMITS, actorIdOf, reachLine } from "../../lib/outside.js";
import { createDoor } from "../../lib/token-door.js";
import { newPrefixedId } from "../../lib/id.js";
import { MIGRATIONS, openStore, newToken, newAgentId } from "./store.js";
import { createMcp } from "./mcp.js";
import { listen, PATH } from "./listener.js";

const DAY = 86_400_000;
const str = { type: "string" };
const obj = (/** @type {any} */ properties = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties, required });
const fail = (/** @type {string} */ message, /** @type {string} */ code = "failed") => Object.assign(new Error(message), { code });
const PERSON = [...PERSON_SURFACES, "tailnet", "device"];
export const SENDER = "outside";
const CONTENT = { summary: "string (what the outside agent asks for, in words)", agent: "string (its name)", held: "string (its request id)", type: "string", fields: "object (the field values)" };

/** The one-line change a person reads on the card: "Muse wants to add a client: Dana Reyes". @param {string} agent @param {"records_create"|"records_update"} tool @param {{ type: string, fields: Record<string, any> }} c @param {string} label */
export function summaryOf(agent, tool, c, label) {
  const name = Object.entries(c.fields).find(([k, v]) => /^(name|title|subject)$/.test(k) && typeof v === "string");
  const head = name ? `: ${String(name[1]).slice(0, 60)}` : "";
  return `${agent.slice(0, 40)} wants to ${tool === "records_create" ? "add" : "change"} a ${label.toLowerCase().slice(0, 40)}${head}`.replace(/\s+/g, " ");
}

/** @param {any} ctx @param {{ now?: () => number }} [seam] */
export function registerOutside(ctx, seam = {}) {
  const now = seam.now || Date.now;
  ctx.store.migrate(MIGRATIONS);
  const store = openStore(ctx.store.db, now);
  const K = ctx.kernel;
  const door = createDoor({ now });
  const emit = (/** @type {string} */ type, /** @type {any} */ payload) => { try { ctx.events.emit(type, payload); } catch { /* an event nobody hears */ } };
  /** @type {{ port: number, url: string, close: () => Promise<void> } | null} */ let listener = null;
  /** @type {string | null} */ let publicBase = null;
  const addr = () => (publicBase ? `${publicBase}${PATH}` : listener ? listener.url : "");

  const spaceId = () => K.space;
  const actorOf = (/** @type {string} */ id) => ({ kind: "agent", id: actorIdOf(id), space: spaceId() });
  const must = (/** @type {unknown} */ id) => { const a = store.agent(String(id || "")); if (!a) throw fail("no such outside agent", "not_found"); return a; };
  const live = (/** @type {unknown} */ id) => { const a = must(id); if (a.revoked) throw fail(`${a.name} was ended; register it again to give it access`, "conflict"); return a; };
  const personChain = async (/** @type {any} */ meta) => {
    if (!K) throw fail("outside agents need the kernel, which this build runs without", "unavailable");
    const c = await K.chain(meta);
    if (!c || !Array.isArray(c.hops) || c.hops.length !== 1 || c.hops[0].actor.kind !== "person") throw fail("only a person at their own surface does this", "denied");
    return c;
  };
  const caller = (/** @type {any} */ meta) => String((meta && meta.caller) || "person").slice(0, 80);

  // ---- reach: what a person gives, as kernel grants ---------------------------------------------------------------------------------------------------------------------------------
  /** The person must hold what they give: delegation only narrows. */
  const mayGive = async (/** @type {any} */ chain, /** @type {string} */ action, /** @type {string} */ resource) => {
    const d = await K.authorize({ chain, action, resource, probe: true });
    if (!d || d.effect !== "allow") throw fail(`you do not hold that access yourself, so you cannot give it (${action}${d && d.reason ? `: ${d.reason}` : ""})`, "denied");
  };
  const mint = (/** @type {any} */ agent, /** @type {string[]} */ actions, /** @type {string} */ prefix, /** @type {number} */ until, /** @type {string} */ reason) => K.mint.make({
    subject: { kind: "actor", actor: actorOf(agent.id) }, actions, resource: { prefix }, conditions: { when: { expires: until }, rate: { n: Math.max(1, agent.rate), per_seconds: 60 } },
    source: `outside:${agent.id}`, reason: reason.slice(0, 200) });
  const u = (/** @type {string} */ tail) => `vyre://${spaceId()}/${tail}`;

  /** @param {any} chain @param {string} ref @returns {Promise<{ id: string, slug: string, name: string, drive_path: string }>} */
  const projectFor = async (chain, ref) => {
    const r = /** @type {any} */ (await ctx.call("work.project.ref", { project: String(ref || "") }));
    if (r.error || !r.data) throw fail(`${String(ref || "").slice(0, 60)} is not a project of yours`, "not_found");
    const rec = await K.records.get(chain, "project", r.data.id).catch(() => null);
    if (!rec) throw fail(`${String(ref).slice(0, 60)} is not a project of yours`, "not_found");
    return { id: String(r.data.id), slug: String(r.data.slug || ""), name: String(r.data.name || r.data.slug || ""), drive_path: String(rec.data.drive_path || "") };
  };

  /** @param {any} agent @param {any} what @param {any} chain @param {number} until */
  async function giveReach(agent, what, chain, until) {
    if (!what || typeof what !== "object") throw fail("say what to give: { kind: records | memory | files }", "bad_input");
    /** @type {string[]} */ const grants = [];
    if (what.kind === "records") {
      const types = [...new Set((Array.isArray(what.types) ? what.types : []).map(String))];
      if (!types.length || types.length > 40) throw fail("name the record types to give, such as [\"client\", \"matter\"]", "bad_input");
      const defs = ((await K.outside.definitions(chain).catch(() => [])) || []).filter((/** @type {any} */ t) => types.includes(String(t.name)));
      const missing = types.filter(t => !defs.some((/** @type {any} */ x) => x.name === t));
      if (missing.length) throw fail(`${missing[0].slice(0, 60)} is not a record type here`, "not_found");
      const write = what.write === true;
      for (const t of types) {
        await mayGive(chain, "records.read", u(`${t}/*`));
        if (write) { await mayGive(chain, "records.create", u(`${t}/*`)); await mayGive(chain, "records.update", u(`${t}/*`)); }
      }
      for (const t of types) grants.push(await mint(agent, write ? ["records.read", "records.create", "records.update"] : ["records.read"], u(t), until, `outside agent ${agent.name}: records of ${t}`));
      const spec = { types, write, defs: defs.map((/** @type {any} */ t) => ({ name: t.name, label: t.label || t.name, fields: (t.fields || []).map((/** @type {any} */ f) => ({ name: f.name, label: f.label || f.name, kind: f.kind })) })) };
      // What it was given before for these same types is now covered by this: its row and its grants go, so the list reads as one line per thing.
      for (const old of store.reach(agent.id)) {
        if (old.kind !== "records" || !old.spec.types.every((/** @type {string} */ x) => types.includes(x)) || (old.spec.write && !write)) continue;
        for (const g of old.grants) await K.mint.end({ id: g, reason: "given again" });
        store.dropReach(old.id);
      }
      store.addReach(agent.id, "records", spec, grants);
      return { kind: "records", types, write };
    }
    if (what.kind === "memory" || what.kind === "files") {
      const p = await projectFor(chain, what.project);
      if (what.kind === "memory") {
        await mayGive(chain, "memory.read", u("memory/*")); await mayGive(chain, "project.reach", u(`project/${p.id}`));
        grants.push(await mint(agent, ["memory.read"], u("memory/*"), until, `outside agent ${agent.name}: memory`));
        grants.push(await mint(agent, ["project.reach"], u(`project/${p.id}`), until, `outside agent ${agent.name}: ${p.name}`));
      } else {
        if (!p.drive_path) throw fail(`${p.name} has no files folder`, "bad_input");
        await mayGive(chain, "drive.read", u(`file/${p.drive_path}/*`));
        grants.push(await mint(agent, ["drive.read"], u(`file/${p.drive_path}`), until, `outside agent ${agent.name}: files of ${p.name}`));
      }
      store.addReach(agent.id, what.kind, { projects: [p] }, grants);
      return { kind: what.kind, project: p.name };
    }
    if (what.kind === "vault") throw fail("a Vault reach is given with the Vault's own pass for now: share the credentials from the Vault screen", "unavailable");
    throw fail("kind is records, memory or files", "bad_input");
  }

  const endGrants = async (/** @type {string} */ agentId, /** @type {string} */ reason) => { if (K && K.mint) await K.mint.end({ source: `outside:${agentId}`, reason }); };

  // ---- the Gate: a write waits for the person's yes ---------------------------------------------------------------------------------------------------------------------------------
  let offered = false;
  const offer = async () => {
    if (offered) return;
    const r = /** @type {any} */ (await ctx.call("gate.offer", { name: SENDER, tool: "outside.release", kinds: ["act"], content: CONTENT }));
    if (r.error) throw fail(`the Gate did not take the ${SENDER} sender: ${r.error.message}`, "failed");
    offered = true;
  };
  /** @param {any} agent @param {"records_create"|"records_update"} tool @param {{ type: string, urn?: string, fields: Record<string, any> }} change */
  async function hold(agent, tool, change) {
    await offer();
    const reach = store.reach(agent.id).filter(r => r.kind === "records");
    const label = (reach.flatMap(r => r.spec.defs || []).find((/** @type {any} */ t) => t.name === change.type) || {}).label || change.type;
    const summary = summaryOf(agent.name, tool, change, label);
    const id = newPrefixedId("hd");
    store.hold({ id, agent: agent.id, tool, change, gate: null });
    const r = /** @type {any} */ (await ctx.call("gate.request", { kind: "act", via: SENDER, to: [`outside:${agent.name}`.slice(0, 80)], content: { summary, agent: agent.name, held: id, type: change.type, fields: change.fields }, why: `${agent.name} asked for this through /agents-mcp` }));
    if (r.error || !r.data || !r.data.id) { store.settle(id, "failed", "the Gate did not hold it"); throw fail("the Gate did not hold this change, so nothing was done", "failed"); }
    store.setGate(id, String(r.data.id));
    emit("outside.held", { id: agent.id, name: agent.name, held: id, tool });
    return { held: id, summary };
  }
  /** What a held request is now, in the agent's words. @param {any} h */
  async function heldState(h) {
    if (h.state === "waiting" && h.gate) {
      const g = /** @type {any} */ (await ctx.call("gate.get", { id: h.gate }));
      if (g && g.data && g.data.state === "rejected") store.settle(h.id, "declined");
    }
    const n = store.held(h.id);
    return { held: n.id, state: n.state, ...(n.error ? { error: n.error } : {}) };
  }

  // ---- the endpoint -----------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const refused = (/** @type {string} */ source, /** @type {string} */ reason, agent = "") => emit("outside.refused", { source: String(source).slice(0, 64), reason, ...(agent ? { id: agent } : {}) });
  // An agent given a Vault reach also gets the Vault's two tools, served by the Vault (trust): none until it offers them, and none for an agent that holds no vault reach.
  const extra = async (/** @type {any} */ agent) => {
    const r = /** @type {any} */ (await ctx.call("vault.mcp.agent.tools", { agent: agent.id }));
    if (r.error || !r.data || !Array.isArray(r.data.tools) || !r.data.tools.length) return null;
    return { tools: r.data.tools, call: async (/** @type {string} */ tool, /** @type {any} */ args, /** @type {string} */ source) => { const c = /** @type {any} */ (await ctx.call("vault.mcp.agent.call", { agent: agent.id, tool, arguments: args, source })); if (c.error) throw fail(c.error.message, c.error.code); return c.data; } };
  };
  const mcp = createMcp({ store, door, now, kernel: K, emit, hold, heldState, extra, refuse: refused, name: "vyre" });

  // ---- tools ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const lines = (/** @type {string} */ url, /** @type {string} */ token, /** @type {string} */ name) => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "agent";
    return { claude: `claude mcp add --transport http vyre-${slug} ${url} --header "Authorization: Bearer ${token}"`, codex: `codex mcp add vyre-${slug} --url ${url} --bearer-token-env-var VYRE_AGENT_TOKEN   # then: export VYRE_AGENT_TOKEN=${token}` };
  };
  const view = (/** @type {any} */ a) => {
    const reach = store.reach(a.id);
    return { id: a.id, name: a.name, kind: a.kind, note: a.note || "", reach: reachLine(reach.map(r => ({ kind: r.kind, ...r.spec })), x => x), gives: reach.map(r => ({ id: r.id, kind: r.kind, ...(r.kind === "records" ? { types: r.spec.types, write: r.spec.write } : { projects: (r.spec.projects || []).map((/** @type {any} */ p) => p.name) }) })),
      expires: a.expires, lastUsed: a.last_used ?? null, uses: a.uses, status: store.status(a) };
  };

  ctx.tool("outside.register", {
    description: "Register an outside agent (Dots, Muse, Hermes, ChatGPT, your own Claude Code elsewhere): { name, note?, days? }. Returns its token once and the address to connect. It reaches nothing yet.",
    input: obj({ name: str, note: str, days: { type: "number" } }, ["name"]), callers: PERSON,
    presence: { summary: (/** @type {any} */ i) => `Let ${String(i && i.name || "an agent").slice(0, 60)} connect to your Vyre` },
    run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      await personChain(meta);
      const name = String(i.name || "").replace(/\s+/g, " ").trim().slice(0, LIMITS.nameChars);
      if (!name) throw fail("name the agent, such as Muse", "bad_input");
      const days = Math.min(LIMITS.maxDays, Math.max(0.01, Number(i.days) || LIMITS.defaultDays));
      const id = newAgentId(), token = newToken(), expires = now() + days * DAY;
      store.create({ id, name, note: String(i.note || "").slice(0, LIMITS.noteChars), token, expires, rate: LIMITS.defaultRate, by: caller(meta) });
      emit("outside.registered", { id, name, kind: "any" });
      return { id, name, kind: "any", note: String(i.note || "").slice(0, LIMITS.noteChars), token, url: addr(), expires, lines: lines(addr() || "<the address Vyre shows when the box is reachable>", token, name) };
    },
  });

  ctx.tool("outside.token", {
    description: "Make a new token for an outside agent: { id }. The old one stops working at once. Shown once.",
    input: obj({ id: str }, ["id"]), callers: PERSON,
    presence: { summary: (/** @type {any} */ i) => `Give ${String(i && i.id || "an agent").slice(0, 40)} a new token` },
    run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      await personChain(meta);
      const a = live(i.id), token = newToken();
      store.setToken(a.id, token); door.forget(a.id);
      return { id: a.id, name: a.name, token, url: addr(), lines: lines(addr() || "<the address Vyre shows when the box is reachable>", token, a.name) };
    },
  });

  ctx.tool("outside.grant", {
    description: "Give an outside agent something to reach: { id, what: { kind: records, types, write? } or { kind: memory, project } or { kind: files, project }, days?, rate? }. A write only ever asks you.",
    input: obj({ id: str, what: { type: "object" }, days: { type: "number" }, rate: { type: "integer" } }, ["id", "what"]), callers: PERSON,
    presence: { summary: (/** @type {any} */ i) => `Let ${String(i && i.id || "an agent").slice(0, 40)} reach ${i && i.what && i.what.kind === "records" ? (Array.isArray(i.what.types) ? i.what.types.slice(0, 5).join(", ") : "records") : i && i.what && i.what.kind === "files" ? "a project's files" : "a project's memory"}${i && i.what && i.what.write ? " and ask to change them" : ""}` },
    run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      const chain = await personChain(meta);
      const a = live(i.id);
      if (a.expires <= now()) throw fail(`${a.name} has expired; make a new token to extend it`, "conflict");
      const rate = Math.min(LIMITS.maxRate, Math.max(1, Math.round(Number(i.rate) || a.rate)));
      if (rate !== a.rate) { store.setExpiry(a.id, a.expires, rate); door.forget(a.id); }
      const until = i.days ? Math.min(a.expires, now() + Math.max(0.01, Number(i.days)) * DAY) : a.expires;
      const given = await giveReach({ ...a, rate }, i.what, chain, until);
      emit("outside.granted", { id: a.id, kind: given.kind, resource: given.kind === "records" ? (given.types || []).join(",") : given.project || "", ...(given.write ? { write: true } : {}) });
      return { id: a.id, granted: given, reach: view(must(a.id)).reach };
    },
  });

  ctx.tool("outside.ungrant", {
    description: "Take one thing back from an outside agent: { id, grant } (a grant id from outside.list). The agent keeps the rest.",
    input: obj({ id: str, grant: str }, ["id", "grant"]), callers: PERSON,
    run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      await personChain(meta);
      const a = must(i.id), r = store.reach(a.id).find(x => x.id === String(i.grant));
      if (!r) throw fail("that is not something this agent was given", "not_found");
      if (K && K.mint) for (const g of r.grants) await K.mint.end({ id: g, reason: "taken back by the person" });
      store.dropReach(r.id);
      return { id: a.id, reach: view(must(a.id)).reach };
    },
  });

  ctx.tool("outside.list", {
    description: "Your outside agents: name, what each may reach, until when, last used. Never a token.",
    input: obj(), callers: [...PERSON],
    run: async () => ({ agents: store.all().map(view) }),
  });

  ctx.tool("outside.revoke", {
    description: "End an outside agent: { id }. Its token opens nothing, its grants are taken back, and what it asked for and is still waiting is dropped. Needs no one's proof.",
    input: obj({ id: str }, ["id"]), callers: PERSON,
    run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      await personChain(meta);
      const a = must(i.id);
      if (a.revoked) return { id: a.id, revoked: false };
      store.revoke(a.id); door.forget(a.id);
      await endGrants(a.id, "the outside agent was ended");
      for (const h of store.heldOf(a.id)) store.settle(h.id, "declined", "the agent was ended");
      emit("outside.revoked", { id: a.id, name: a.name, by: "owner" });
      return { id: a.id, revoked: true };
    },
  });

  ctx.tool("outside.release", {
    internal: true,
    description: "The Gate's call once the person approved an outside agent's change: does exactly that change as the agent, under only what it was given. Only the Gate.",
    input: obj({ id: str, to: { type: "array", items: str }, content: { type: "object" } }, ["id", "content"]),
    run: async (/** @type {any} */ { id, content }, /** @type {any} */ { caller: who }) => {
      if (who !== "module:gate") throw fail("only the Gate releases what a person approved", "denied");
      const h = store.heldByGate(id);
      if (!h || h.state !== "waiting") throw fail("that request is no longer waiting", "conflict");
      const a = must(h.agent);
      if (a.revoked || a.expires <= now()) { store.settle(h.id, "declined", "the agent was ended"); throw fail(`${a.name} was ended, so nothing was done`, "denied"); }
      const chain = K.outside.chain(a.id);
      const type = String(content.type || h.change.type), fields = content.fields && typeof content.fields === "object" ? content.fields : h.change.fields;
      if (type !== h.change.type) throw fail("the type of a request cannot change when it is approved", "bad_input");
      try {
        if (h.tool === "records_create") await K.records.create(chain, type, fields);
        else { const rid = String(h.change.urn).split("/").pop(); const cur = await K.records.get(chain, type, rid); await K.records.update(chain, type, rid, fields, cur ? cur.version : undefined); }
      } catch (e) {
        const msg = String(/** @type {any} */ (e) && /** @type {any} */ (e).message || e).slice(0, 200);
        store.settle(h.id, "failed", msg);
        throw fail(`${a.name}'s change could not be made: ${msg}`, "failed");
      }
      store.settle(h.id, "done");
      return { done: true };
    },
  });

  ctx.tool("outside.mcp.status", {
    internal: true, description: "Whether /agents-mcp is listening on loopback, and its port: { listening, port }. Only the wink module (the public gate) asks.", input: obj(),
    run: async (/** @type {any} */ _i, /** @type {any} */ { caller: who }) => {
      if (who !== "module:wink") throw fail("only the public gate asks where /agents-mcp listens", "denied");
      return { listening: Boolean(listener), port: listener ? listener.port : null };
    },
  });
  ctx.tool("outside.mcp.base", {
    internal: true, description: "The public address the gate serves this box on, or null: { base }. Only the wink module sets it; tokens made afterwards name it.", input: obj({ base: { type: ["string", "null"] } }),
    run: async (/** @type {any} */ { base }, /** @type {any} */ { caller: who }) => {
      if (who !== "module:wink") throw fail("only the public gate sets the public address", "denied");
      publicBase = typeof base === "string" && /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(base) ? base : null;
      return { ok: true };
    },
  });

  return {
    handle: mcp.handle, perform: mcp.perform, store, door,
    /** Start the loopback listener (a build with the kernel; a port in config `outside.port`, else any free one). */
    async listen() {
      const o = (ctx.config && ctx.config.outside) || {};
      listener = await listen({ host: o.host || "127.0.0.1", port: Number(o.port || 0), handle: mcp.handle });
      ctx.log(`outside agents: /agents-mcp listening on ${listener.url}`);
    },
    async stop() { if (listener) await listener.close(); listener = null; },
  };
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> } & Record<string, any>> }} */
export default {
  async start(ctx) {
    const o = registerOutside(ctx);
    if (ctx.kernel && ctx.kernel.outside) { try { await o.listen(); } catch (e) { ctx.log.warn(`outside agents: no listener (${/** @type {Error} */ (e).message})`); } }
    return o;
  },
};
