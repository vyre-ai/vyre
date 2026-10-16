// @ts-check
// skills: the skills a session may use, found by what it is about to do (0.3.1, R031-00j and R031-00k). Three tools, all reads:
//
//   skills.list { project?, level?, limit? }    the skills the caller may use, each { id, name, level, scope, description, tokens }
//   skills.find { query, limit?, project? }     the best of them for an intent in plain words (lib/docs-rank.js, the same ranker as docs.find)
//   skills.get  { id }                          one skill's whole SKILL.md, when the caller may use it
//
// A skill is a SKILL.md folder. Where they live, by level (the same layout core/learn writes and the switchboard loads):
//   vyre      harness/skills/<name>/SKILL.md                              Vyre's own, shipped in the plugin: every caller
//   account   <home>/learned/account/skills/<name>/SKILL.md               what the person installed: the person and the agents working for them
//   project   <home>/learned/projects/<slug>/skills/<name>/SKILL.md       a project's private skills, and <project folder>/.claude/skills/<name>: callers that reach that project
//   agent     <home>/learned/agents/<name>/skills/<name>/SKILL.md         one agent's toolkit: that agent, and the person
// Permission is the permission system's: the project reach is `projects.reach`, the one door core/memory, core/recall and core/files ask, and who is the person is lib/caller's verified check. A caller that
// cannot be placed (an unnamed model session, a guest) gets Vyre's own skills and nothing private. A skill the caller may not use is not listed, not ranked and not readable: it does not exist for them.
// Nothing here writes. The skill library per Space (levels space, personal, agent, project, versioned, with owners) is the next piece and plugs in as one more source in `sourcesOf`.

import fs from "node:fs";
import path from "node:path";
import { PERSON_SURFACES } from "../../lib/person-surfaces.js";
import { PKG_ROOT } from "../../kernel/devbuild.js";
import { isPerson, agentName } from "../../lib/caller.js";
import { frontMatter } from "../../lib/docs-corpus.js";
import { buildIndex, search } from "../../lib/docs-rank.js";
import { tokens } from "../../lib/tokens.js";
import { fit } from "../../lib/harness-caps.js";
import os from "node:os";
import { createHash } from "node:crypto";
import { createLibrary } from "./library.js";
import { createMemberOps } from "./member-ops.js";
import { identityKernel, personalSkillsOnHome } from "./home-kernel.js";
import { materialise as writeFor, AIS, LEVELS, ackOf, declared, hasCode } from "../../lib/skill-library.js";
import { resolveApproved } from "../../lib/skill-resolve.js";
import { runBrowse, roleOf } from "./browse-lib.js";

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_BODY = 64 * 1024;
const err = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/** Test seam: the Vyre package root (where harness/skills is) per home. @type {Map<string, { pkg: string }>} */
export const seams = new Map();
/** Test seam: the script wall a plugin hook runs behind, per home (production finds one itself, and a hook does not run where there is none). @type {Map<string, { findWall?: () => Promise<any>, wall?: any, netOptions?: any }>} */

/** The skill folders under a skills directory, as parsed SKILL.md files. @param {string} dir @param {{ level: string, scope: string | null }} where */
function readDir(dir, where) {
  /** @type {any[]} */ const out = [];
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && NAME.test(e.name)).map((e) => e.name).sort(); } catch { return out; }
  for (const name of names) {
    let text;
    try { const st = fs.statSync(path.join(dir, name, "SKILL.md")); if (!st.isFile() || st.size > MAX_BODY) continue; text = fs.readFileSync(path.join(dir, name, "SKILL.md"), "utf8"); } catch { continue; }
    const { data, body } = frontMatter(text);
    const id = [where.level, ...(where.scope ? [where.scope] : []), name].join("/");
    const needs = (Array.isArray(data.needs) ? data.needs : String(data.needs || "").split(",")).map((/** @type {any} */ x) => String(x).trim()).filter(Boolean).slice(0, 12);
    out.push({ id, name: String(data.name || name), level: where.level, scope: where.scope, description: String(data.description || "").replace(/\s+/g, " ").slice(0, 600), text, body, tokens: tokens(text), ...(needs.length ? { needs, degrade: String(data.degrade || "").slice(0, 200) } : {}) });
  }
  return out;
}

/**
 * Every skill that exists at the levels a caller may reach: Vyre's own always, and each private level only when `reach` allows it.
 * @param {{ pkg: string, home: string, person: boolean, agent: string | null, account: boolean, projects: { slug: string, folders: string[] }[] }} c
 */
export function sourcesOf(c) {
  const out = [...readDir(path.join(c.pkg, "harness", "skills"), { level: "vyre", scope: null })];
  if (c.account) out.push(...readDir(path.join(c.home, "learned", "account", "skills"), { level: "account", scope: null }));
  for (const p of c.projects) {
    if (!SLUG.test(p.slug)) continue;
    out.push(...readDir(path.join(c.home, "learned", "projects", p.slug, "skills"), { level: "project", scope: p.slug }));
    for (const f of p.folders || []) if (path.isAbsolute(f)) out.push(...readDir(path.join(f, ".claude", "skills"), { level: "project", scope: p.slug }));
  }
  // an agent's own toolkit: that agent, and the person (every agent's)
  if (c.agent && SLUG.test(c.agent)) out.push(...readDir(path.join(c.home, "learned", "agents", c.agent, "skills"), { level: "agent", scope: c.agent }));
  else if (c.person) {
    let agents = [];
    try { agents = fs.readdirSync(path.join(c.home, "learned", "agents"), { withFileTypes: true }).filter((e) => e.isDirectory() && SLUG.test(e.name)).map((e) => e.name).sort(); } catch { /* none */ }
    for (const a of agents) out.push(...readDir(path.join(c.home, "learned", "agents", a, "skills"), { level: "agent", scope: a }));
  }
  // the same id twice (a skill in the project's folder and in its learned plugin): the first wins
  const seen = new Set();
  return out.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
}

/** @param {any} s */
const shown = (s) => ({ id: s.id, name: s.name, level: s.level, ...(s.scope ? { scope: s.scope } : {}), description: s.description, tokens: s.tokens, ...(s.needs ? { needs: s.needs } : {}), ...(s.degrade ? { degrade: s.degrade } : {}) });
/**
 * Which of these skills work on a harness (R031-85): each is annotated `works: "degraded"` with its reason, or left out and named in `hidden` with the reason, by the one rule (lib/harness-caps.js fit).
 * A harness nobody has started has no caps and hides nothing. @param {any[]} rows the shown rows @param {Map<string, any>} byId the skills by id @param {Record<string, boolean | null> | null} caps @param {string} harness
 */
function forHarness(rows, byId, caps, harness) {
  /** @type {any[]} */ const kept = [], hidden = [];
  for (const r of rows) {
    const s = byId.get(r.id);
    const f = fit(s && s.needs, caps, { harness, degrade: s && s.degrade });
    if (f.works === false) hidden.push({ id: r.id, reason: f.reason });
    else kept.push(f.works === "degraded" ? { ...r, works: "degraded", reason: f.reason } : r);
  }
  return { skills: kept, ...(hidden.length ? { hidden } : {}) };
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const home = String((ctx.paths && ctx.paths.root) || "");
    const seam = seams.get(home);
    const pkg = seam ? seam.pkg : PKG_ROOT;

    // ---- the library (R031-18..21): versions as `skill` records, approvals, and what each AI is given -----------------------------------------------------------------------------------
    const kernelOk = () => ctx.kernel && ctx.kernel.records && typeof ctx.kernel.serviceChain === "function";
    /** The home Space id (identity library): pinned at start from the home's kernel record. */
    let homeSpacePinned = "";
    try { const j = JSON.parse(fs.readFileSync(path.join(home, "kernel", "space.json"), "utf8")); homeSpacePinned = String(j.space || ""); } catch { homeSpacePinned = kernelOk() ? String(ctx.kernel.space || "") : ""; }
    const libDeps = () => ({
      agentOwner: async (/** @type {string} */ name) => { try { const r = await ctx.call("agents.list", {}); const l = r && !r.error && Array.isArray(r.data) ? r.data : []; const a = l.find((/** @type {any} */ x) => x.name === name); return a && a.owner ? String(a.owner) : null; } catch { return null; } },
      projectOwner: async (/** @type {string} */ slug) => { try { const rows = (await ctx.kernel.records.query(ctx.kernel.serviceChain("skills"), "project", { filter: { field: "slug", op: "eq", value: slug }, page: { limit: 1 } })).rows; const o = rows[0] && rows[0].data.owner; return o && o.actor ? String(o.actor.id) : null; } catch { return null; } },
      mcpAdd: async (/** @type {any} */ server) => { const r = await ctx.call("mcp.add", server); if (r.error) throw new Error(r.error.message); return r.data; },
      log: (/** @type {string} */ m) => ctx.log(m),
    });
    const lib = createLibrary({ kernel: () => { if (!kernelOk()) throw err("unavailable", "the skill library needs the kernel"); return ctx.kernel; }, ...libDeps() });
    const identityLib = createLibrary({
      kernel: () => {
        if (!kernelOk()) throw err("unavailable", "the skill library needs the kernel");
        const k = identityKernel({ kernel: ctx.kernel, registry: null, homeSpacePinned });
        if (!k || !k.records) throw err("unavailable", "the identity skill library needs the home Space");
        return k;
      },
      ...libDeps(),
    });
    const personalOnHome = () => personalSkillsOnHome({ kernel: ctx.kernel, registry: null, homeSpacePinned });
    const libraryFor = (/** @type {string | undefined} */ level) => (level === "personal" && personalOnHome() ? identityLib : lib);
    /** Approved rows for this Space plus identity personal skills from the home Space when the running Space is hosted. */
    const mergedApproved = async (/** @type {any} */ who) => {
      const localRows = await lib.approved({ ...who, person: who.person || null });
      if (!who.person || !personalOnHome()) return localRows;
      const personalRows = await identityLib.approved({ person: who.person, agent: null, projects: [], allAgents: false });
      const withoutPersonal = localRows.filter((/** @type {any} */ i) => i.level !== "personal");
      return resolveApproved([...withoutPersonal, ...personalRows.filter((/** @type {any} */ i) => i.level === "personal")], who);
    };
    /** The caller's kernel chain, or null when the call carries none (a guest, a bare label). @param {any} meta */
    const chainOf = async (meta) => { try { return kernelOk() && typeof ctx.kernel.chain === "function" ? await ctx.kernel.chain(meta || {}) : null; } catch { return null; } };
    const personIdOf = (/** @type {any} */ chain) => { const h = chain && chain.hops && chain.hops[0]; return h && h.actor.kind === "person" ? String(h.actor.id) : null; };
    /** Library items as the same entries the on-disk levels give, a plugin's skills flattened. @param {any[]} items */
    const entriesOf = (items) => {
      const out = [];
      for (const i of items) {
        const prefix = i.level === "personal" ? "personal" : [i.level, ...(i.scope ? [i.scope] : [])].join("/");
        const parts = i.kind === "plugin" ? (JSON.parse(String(i.body)).skills || []).map((/** @type {any} */ s) => ({ name: s.name, id: `${prefix}/${i.name}/${s.name}`, text: s.body })) : [{ name: i.name, id: `${prefix}/${i.name}`, text: i.body }];
        for (const p of parts) {
          const { data, body } = frontMatter(p.text);
          out.push({ id: p.id, name: String(data.name || p.name), level: i.level, scope: i.scope || null, description: String(data.description || "").replace(/\s+/g, " ").slice(0, 600), text: p.text, body, tokens: tokens(p.text) });
        }
      }
      return out;
    };

    /** The projects the person has, with their folders. */
    const allProjects = async () => {
      try {
        const r = await ctx.call("projects.list", {});
        const l = r && !r.error && r.data && Array.isArray(r.data.projects) ? r.data.projects : [];
        return l.map((/** @type {any} */ p) => ({ slug: String(p.slug), folders: [p.home, ...(Array.isArray(p.workspaces) ? p.workspaces : [])].filter(Boolean).map(String) }));
      } catch { return []; }
    };

    /** What this caller may reach, through the permission system. @param {any} meta @param {string | undefined} wantProject */
    const scopeOf = async (meta, wantProject) => {
      const person = isPerson(meta);
      const agent = agentName(meta);
      /** @type {any} */ let reach = null;
      try {
        const r = await ctx.call("projects.reach", { caller: String((meta && meta.caller) || ""), ...(agent ? { agent } : {}), ...(meta && meta.thread ? { thread: meta.thread } : {}), kind: "content", person });
        reach = r && !r.error ? r.data : null;
      } catch { reach = null; }   // refused (a guest, an unnamed session) or unavailable: no private level
      const mine = reach && reach.all === true ? await allProjects() : reach && Array.isArray(reach.projects) ? reach.projects.map((/** @type {any} */ p) => ({ slug: String(p.slug), folders: Array.isArray(p.folders) ? p.folders.map(String) : [] })) : [];
      return { person, agent, account: Boolean(person || agent), projects: wantProject ? mine.filter((/** @type {any} */ p) => p.slug === wantProject) : mine };
    };

    /** The skills a caller may use. @param {any} meta @param {{ project?: string, level?: string }} q */
    const visible = async (meta, q) => {
      const s = await scopeOf(meta, q.project);
      let list = sourcesOf({ pkg, home, person: s.person, agent: s.agent, account: s.account, projects: s.projects });
      if (kernelOk() && s.account) {
        const chain = await chainOf(meta);
        const approved = await mergedApproved({ person: personIdOf(chain), agent: s.agent, projects: s.projects.map((/** @type {any} */ p) => p.slug), allAgents: Boolean(s.person && !s.agent) }).catch(() => []);
        const seen = new Set(list.map((x) => x.id));
        list = [...list, ...entriesOf(approved).filter((x) => !seen.has(x.id))];
      }
      if (q.level) list = list.filter((x) => x.level === q.level);
      return list;
    };

    /** What a harness showed it can do (sessions.harness.get), or null when no session of it has started. @param {string} harness */
    const harnessCaps = async (harness) => {
      try { const r = await ctx.call("sessions.harness.get", { provider: String(harness) }); const h = r && !r.error && r.data && Array.isArray(r.data.harnesses) ? r.data.harnesses[0] : null; return h ? h.caps : null; } catch { return null; }
    };
    const membershipOf = async (/** @type {string | null} */ person) => {
      if (!person || !kernelOk() || typeof ctx.kernel.membership !== "function") return null;
      try { return await ctx.kernel.membership(person); } catch { return null; }
    };
    const approvedMapFor = async (/** @type {string | null} */ person) => {
      const map = new Map();
      if (!person) return map;
      const items = await mergedApproved({ person, agent: null, projects: [], allAgents: false }).catch(() => []);
      for (const i of items) for (const e of entriesOf([i])) map.set(e.id, { ...e, kind: i.kind, body: i.body });
      return map;
    };
    const maySeeDraft = (/** @type {{ person: string | null, role: string }} */ who, /** @type {any} */ v) => {
      if (v.level === "personal") return v.scope === who.person;
      if (v.state !== "draft") return true;
      if (who.role === "owner" || who.role === "admin") return true;
      return v.proposer === `person:${who.person}`;
    };
    const maySeeVersion = (/** @type {{ person: string | null, role: string }} */ who, /** @type {any} */ v) => {
      if (v.level === "personal") return v.scope === who.person;
      if (v.level === "space" && v.state === "draft") return who.role === "owner" || who.role === "admin" || v.proposer === `person:${who.person}`;
      return true;
    };
    const collectDrafts = async (/** @type {{ person: string | null, role: string }} */ who, /** @type {string | undefined} */ level) => {
      if (!kernelOk()) return [];
      /** @type {any[]} */ const out = [];
      const libs = [{ L: lib, home: false }, ...(personalOnHome() ? [{ L: identityLib, home: true }] : [])];
      for (const { L } of libs) {
        const rows = await L.versions({ state: "draft", ...(level ? { level } : {}) });
        out.push(...rows);
      }
      const seen = new Set();
      return out.filter((v) => {
        const k = `${v.level}|${v.scope}|${v.name}|${v.version}`;
        if (seen.has(k) || !maySeeDraft(who, v)) return false;
        seen.add(k);
        return true;
      });
    };
    /** @param {any} input @param {any} meta @param {{ member?: boolean, person?: string }} [o] */
    const browsePack = async (input, meta, o = {}) => {
      const chain = await chainOf(meta);
      const person = o.person || personIdOf(chain);
      const mem = person ? await membershipOf(person) : null;
      const role = o.member ? roleOf(mem) : (mem && mem.role === "member" ? "member" : mem && mem.role === "admin" ? "admin" : "owner");
      const visibleForBrowse = async (/** @type {{ level?: string }} */ q) => {
        if (o.member && person) {
          let list = sourcesOf({ pkg, home, person: true, agent: null, account: true, projects: [] });
          if (kernelOk()) {
            const approved = await mergedApproved({ person, agent: null, projects: [], allAgents: false }).catch(() => []);
            const seen = new Set(list.map((/** @type {any} */ x) => x.id));
            list = [...list, ...entriesOf(approved).filter((/** @type {any} */ x) => !seen.has(x.id))];
          }
          if (q.level) list = list.filter((/** @type {any} */ x) => x.level === q.level);
          return list;
        }
        return visible(meta, { project: input.project, level: q.level });
      };
      const pack = await runBrowse({
        shown,
        identityPersonal: personalOnHome,
        visible: visibleForBrowse,
        versionsFor: async (lv, f) => libraryFor(lv).versions(f),
        draftsFor: async (who, lv) => collectDrafts(who, lv),
        maySeeVersion,
        approvedMap: await approvedMapFor(person),
      }, input, { person, role, chain });
      return pack;
    };

    ctx.tool("skills.list", {
      effect: "read",
      description: "The skills you may use, each { id, name, level, scope, description, tokens }. Narrow with project or level. skills.find ranks them.",
      input: { type: "object", properties: { project: { type: "string", maxLength: 64 }, level: { type: "string", enum: ["vyre", "space", "personal", "account", "project", "agent"] }, limit: { type: "integer", minimum: 1, maximum: 200 }, harness: { type: "string", maxLength: 20 } } },
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        const pack = await browsePack(input, meta);
        const list = pack.skills || [];
        const rows = list.slice(0, input.limit || 100).map((/** @type {any} */ s) => ({ id: s.id, name: s.name, level: s.level, ...(s.scope ? { scope: s.scope } : {}), description: s.description, tokens: s.tokens, ...(s.harnesses ? { harnesses: s.harnesses } : {}), ...(s.needs ? { needs: s.needs } : {}), ...(s.degrade ? { degrade: s.degrade } : {}) }));
        if (!input.harness) return { skills: rows, total: list.length, drafts: pack.drafts, role: pack.role };
        const raw = await visible(meta, { project: input.project, level: input.level });
        const byId = new Map(raw.map((/** @type {any} */ s) => [s.id, s]));
        return { ...forHarness(rows, byId, await harnessCaps(input.harness), String(input.harness)), total: list.length };
      },
    });

    ctx.tool("skills.find", {
      effect: "read",
      description: "Skills that fit what you are about to do, best first, as { id, name, level, description, tokens }. Read one with tools_call skills.get.",
      input: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 300, description: "plain words, such as \"keep a password out of a file\"" }, limit: { type: "integer", minimum: 1, maximum: 10 }, project: { type: "string", maxLength: 64 }, harness: { type: "string", maxLength: 20 } }, required: ["query"] },
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        const list = await visible(meta, { project: input.project });
        if (!list.length) return { skills: [] };
        const index = buildIndex(list.map((s) => ({ path: s.id, title: s.name, when: s.description, summary: "", headings: [], body: s.body, ref: s })));
        const hits = search(index, String(input.query), { limit: input.limit || 5 });
        const rows = hits.map((h) => shown(/** @type {any} */ (h.page).ref));
        if (!input.harness) return { skills: rows };
        return forHarness(rows, new Map(list.map((/** @type {any} */ s) => [s.id, s])), await harnessCaps(input.harness), String(input.harness));
      },
    });

    ctx.tool("skills.get", {
      effect: "read",
      description: "One skill's whole SKILL.md, by the id skills.list or skills.find gave. Refused as not found when you may not use it.",
      input: { type: "object", properties: { id: { type: "string", minLength: 3, maxLength: 200 } }, required: ["id"] },
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        const parts = String(input.id).split("/");
        const project = parts[0] === "project" ? parts[1] : undefined;
        const list = await visible(meta, { project });
        const s = list.find((x) => x.id === input.id);
        if (!s) throw err("not_found", `No skill "${String(input.id).slice(0, 80)}" that you may use. skills.list shows the ones you may.`);
        return { ...shown(s), text: s.text };
      },
    });

    // ---- drafting and approving: anyone drafts, the level's owner says yes -------------------------------------------------------------------------------------------------------------
    const WHO_CAN = ["cli", "local", "deck", "capsule", "tailnet", "device", "space", "agent", "mcp", "harness"];
    const need = async (/** @type {any} */ meta) => { const c = await chainOf(meta); if (!c) throw err("denied", "this call carries no person: a skill is drafted and approved for someone"); return c; };
    const obj = (/** @type {any} */ properties, /** @type {string[]} */ required = []) => ({ type: "object", properties, required });
    const common = { name: { type: "string" }, level: { type: "string", enum: [...LEVELS] }, scope: { type: "string", description: "personal: you (default); agent: the agent's name; project: its short name; space: leave out" } };
    ctx.tool("skills.draft", { effect: "write", callers: WHO_CAN,
      description: "Draft a skill or plugin into the library; nothing uses it until the level's owner approves. Body: SKILL.md, or plugin JSON for kind plugin.",
      input: obj({ ...common, kind: { type: "string", enum: ["skill", "plugin"] }, body: { type: "string", description: "kind skill: a SKILL.md with name and description in its front matter. kind plugin: JSON { name, description, skills?, commands?, hooks?, mcp? }; a hook or MCP server is code and the draft says what it declares" }, note: { type: "string" } }, ["name", "level", "body"]),
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => libraryFor(i.level).draft(await need(meta), i) });
    // A lesson (a procedure the person keeps repeating, learn's proposal) is drafted for the install's owner, at the project level when it is a project's, else their own. A draft only: approving is the person's.
    ctx.tool("skills.draft.learned", { effect: "write", internal: true, callers: ["module"],
      description: "Draft a skill learn proposed from a repeated procedure: at the agent's own level when one agent repeated it, else the project's, else the owner's own. A draft; its level's owner approves it.",
      input: obj({ name: { type: "string" }, body: { type: "string" }, project: { type: "string" }, agent: { type: "string" } }, ["name", "body"]),
      run: async (/** @type {any} */ i) => {
        if (!kernelOk()) throw err("unavailable", "the kernel is not wired on this box yet");
        // the lesson is for whoever repeated the work: an agent that did it every time gets it at its own level; otherwise the project's or the owner's
        const agent = typeof i.agent === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(i.agent) ? i.agent : "";
        const level = agent ? "agent" : i.project ? "project" : "personal";
        return lib.draftFor(String(ctx.kernel.owner), { name: i.name, body: i.body, level, scope: agent || i.project || "", note: agent ? `Drafted from a procedure ${agent} repeated.` : "Drafted from a procedure you repeated.", proposer: "learn" });
      } });
    ctx.tool("skills.approve", { effect: "write", callers: [...PERSON_SURFACES, "tailnet", "device", "space"],
      description: "Say yes to a draft: it becomes the version in use at its level and the one before is retired. Only the level's owner: you for a personal skill, an agent's owner, a project's owner, an owner or an admin for the Space. A plugin with code needs ack: the value skills.draft gave, which is the hash of exactly what it declares.",
      input: obj({ ...common, version: { type: "integer" }, ack: { type: "string" } }, ["name", "level", "version"]),
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => libraryFor(i.level).approve(await need(meta), i) });
    ctx.tool("skills.rollback", { effect: "write", callers: [...PERSON_SURFACES, "tailnet", "device", "space"],
      description: "Go back to an earlier version of a skill: it is written again as a new approved version (the owner's own act). to: the version to restore.",
      input: obj({ ...common, to: { type: "integer" }, ack: { type: "string" } }, ["name", "level", "to"]),
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => libraryFor(i.level).rollback(await need(meta), i) });
    ctx.tool("skills.decline", { effect: "write", callers: [...PERSON_SURFACES, "tailnet", "device", "space"],
      description: "Turn down a draft waiting for a yes: the proposer or the level's owner retires it.",
      input: obj({ ...common, version: { type: "integer" } }, ["name", "level", "version"]),
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => libraryFor(i.level).decline(await need(meta), i) });
    ctx.tool("skills.versions", { effect: "read", callers: WHO_CAN,
      description: "The library's versions, newest first, with who drafted each and which is in use. state: draft shows those waiting for a yes.",
      input: obj({ ...common, state: { type: "string", enum: ["draft", "approved", "retired"] } }),
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => { await need(meta); return { versions: await libraryFor(i.level).versions(i) }; } });
    ctx.tool("skills.browse", { effect: "read", callers: WHO_CAN,
      description: "Skills and plugins in the library for the Skills screen: list what you may use at each level, drafts you proposed, and version history for one skill.",
      input: obj({ level: { type: "string", enum: [...LEVELS] }, state: { type: "string", enum: ["draft", "approved", "retired"] }, name: { type: "string" }, scope: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 } }),
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => browsePack(i, meta) });

    // the proposal kind "skill" (flows-host.js): the same card as any other change
    ctx.tool("skills.change.draft", { internal: true, callers: ["module"], description: "Check a draft can be approved and say whose yes it needs. For the proposals path.",
      input: obj({ name: { type: "string" }, level: { type: "string" }, scope: { type: "string" }, version: { type: "integer" }, proposer: { type: "string" } }, ["name", "level", "version", "proposer"]),
      run: async (/** @type {any} */ i) => {
        const rec = await libraryFor(String(i.level)).get(String(i.name), String(i.level), String(i.scope ?? ""), Number(i.version));
        if (rec.data.state !== "draft") throw err("bad_state", `version ${i.version} is a ${rec.data.state}, not a draft`);
        const owner = rec.data.owner || null;
        let ack; if (rec.data.kind === "plugin") { const p = JSON.parse(String(rec.data.body)); if (hasCode(p)) ack = ackOf(p); }
        return { id: `${rec.data.level}|${rec.data.scope || ""}|${rec.data.name}|${rec.data.version}`, hash: rec.data.hash, owner, ...(ack ? { ack, declares: declared(JSON.parse(String(rec.data.body))) } : {}), title: `Use the ${rec.data.kind} ${rec.data.name} (${rec.data.level}${rec.data.scope ? " " + rec.data.scope : ""}, version ${rec.data.version})?` };
      } });
    const parseId = (/** @type {string} */ id) => { const [level, scope, name, version] = String(id).split("|"); return { level, scope, name, version: Number(version) }; };
    ctx.tool("skills.change.title", { internal: true, callers: ["module"], description: "The title a stored skill change really has, or null. For the proposals path.", input: obj({ id: { type: "string" }, hash: { type: "string" } }, ["id", "hash"]),
      run: async (/** @type {any} */ i) => { try { const k = parseId(i.id); const rec = await libraryFor(k.level).get(k.name, k.level, k.scope, k.version); return rec.data.state === "draft" && rec.data.hash === i.hash ? `Use the ${rec.data.kind} ${rec.data.name} (${rec.data.level}${rec.data.scope ? " " + rec.data.scope : ""}, version ${rec.data.version})?` : null; } catch { return null; } } });
    ctx.tool("skills.change.apply", { internal: true, callers: ["module"], description: "Approve the draft on its owner's yes. For the proposals path.", input: obj({ id: { type: "string" }, hash: { type: "string" }, approver: { type: "string" }, ack: { type: "string" } }, ["id", "hash", "approver"]),
      run: async (/** @type {any} */ i) => { const k = parseId(i.id); const store = libraryFor(k.level); const rec = await store.get(k.name, k.level, k.scope, k.version); if (rec.data.hash !== i.hash) throw err("conflict", "that draft changed since it was proposed"); let ack = i.ack; if (rec.data.kind === "plugin") { const p = JSON.parse(String(rec.data.body)); if (hasCode(p)) ack = ackOf(p); } return store.applyApproval({ kind: "person", id: String(i.approver) }, { ...k, ack }); } });

    // ---- what each AI is given, and a plugin's hooks ---------------------------------------------------------------------------------------------------------------------------
    ctx.tool("skills.materialise", { internal: true, callers: ["module"], description: "Write the approved library for one AI and one session (ai: claude, codex or grok; person, agent, project): a plugin folder for Claude and Grok, a skills folder for Codex. Returns the folder.",
      input: obj({ ai: { type: "string", enum: [...AIS] }, manifest: { type: "string" }, person: { type: "string" }, agent: { type: "string" }, project: { type: "string" } }, ["ai"]),
      run: async (/** @type {any} */ i) => {
        if (!kernelOk()) return { dir: null, skills: [] };
        const approved = await mergedApproved({ person: i.person || String(ctx.kernel.owner || ""), agent: i.agent || null, projects: i.project ? [String(i.project)] : [], allAgents: false });
        if (!approved.length) return { dir: null, skills: [] };
        const id = createHash("sha256").update(JSON.stringify([i.ai, approved.map((/** @type {any} */ a) => [a.name, a.level, a.scope, a.version, a.hash])])).digest("hex").slice(0, 16);
        const dir = path.join(home || os.tmpdir(), "materialised", String(i.ai), id);
        const done = fs.existsSync(path.join(dir, ".done"));
        const r = done ? { dir, skills: [], commands: [], hooks: 0 } : writeFor(dir, i.ai, approved, { manifest: typeof i.manifest === "string" ? i.manifest : undefined, hookCommand: (plugin, hook) => `vyre call skills.hook.run '{"plugin":"${plugin}","hook":"${hook}"}'` });
        if (!done) fs.writeFileSync(path.join(dir, ".done"), "");
        return { ...r, dir };
      } });
    ctx.tool("skills.hook.run", { internal: true, callers: ["module", "hook"], description: "Run one approved plugin hook in the script sandbox: no network of its own, only the hosts the plugin declared. Returns what the script emitted.",
      input: obj({ plugin: { type: "string" }, hook: { type: "string" }, payload: { type: "object" } }, ["plugin", "hook"]),
      run: async (/** @type {any} */ i) => {
        const rows = (await lib.approved({ person: String(ctx.kernel.owner || ""), allAgents: true, projects: [] })).filter((/** @type {any} */ x) => x.kind === "plugin" && x.name === i.plugin);
        const item = rows[0];
        if (!item) throw err("not_found", `no approved plugin ${String(i.plugin).slice(0, 60)}`);
        const hook = (JSON.parse(String(item.body)).hooks || []).find((/** @type {any} */ h) => h.id === i.hook);
        if (!hook) throw err("not_found", `${i.plugin} has no hook ${String(i.hook).slice(0, 60)}`);
        const r = await ctx.call("watchers.hook.run", { script: hook.script, payload: i.payload || null, hosts: hook.network || [] });
        if (r && r.error) throw err(r.error.code || "unavailable", r.error.message || "the hook could not run");
        return { ...r.data, declared: hook.network || [] };
      } });
    // A team member's own skills on the team's server: the member door's rows (core/work/member-tools.js) run these two entries under her chain, in the Space (callInSpace); the home Space's library only.
    const memberLibrary = { ...lib, approved: mergedApproved, draft: (/** @type {any} */ c, /** @type {any} */ i) => libraryFor(i.level).draft(c, i), approve: (/** @type {any} */ c, /** @type {any} */ i) => libraryFor(i.level).approve(c, i), decline: (/** @type {any} */ c, /** @type {any} */ i) => libraryFor(i.level).decline(c, i), rollback: (/** @type {any} */ c, /** @type {any} */ i) => libraryFor(i.level).rollback(c, i), versions: (/** @type {any} */ f) => libraryFor(f.level).versions(f) };
    const memberOps = createMemberOps({
      library: memberLibrary, entriesOf, shown,
      vyreSkills: () => sourcesOf({ pkg, home, person: false, agent: null, account: false, projects: [] }).filter((x) => x.level === "vyre"),
      browse: async (/** @type {string} */ person, /** @type {any} */ chain, /** @type {any} */ input) => browsePack(input, { caller: "module", kernelFacts: chain }, { member: true, person }),
    });
    const serve = (/** @type {string[]} */ calls) => async (/** @type {any} */ i, /** @type {any} */ extra) => {
      if (!extra || !extra.in_space_chain || !extra.in_space) throw err("denied", "only the team server's member door runs this");
      if (!kernelOk()) throw err("unavailable", "the skill library needs the kernel");
      if (String(extra.in_space) !== String(ctx.kernel.space || "")) throw err("not_allowed", "Skills for members are kept in this server's own Space; this Space has no skill library of its own. Ask the owner.");
      if (!calls.includes(i.call)) throw err("bad_input", `call is one of ${calls.join(", ")}`);
      const chain = extra.in_space_chain, h = chain.hops && chain.hops.length === 1 ? chain.hops[0] : null;
      if (!h || h.actor.kind !== "person") throw err("not_found", "not found");
      return /** @type {any} */ (memberOps)[i.call](String(h.actor.id), chain, i.input && typeof i.input === "object" ? i.input : {});
    };
    const serveInput = (/** @type {string[]} */ calls) => obj({ call: { type: "string", enum: calls }, input: { type: "object" } }, ["call"]);
    ctx.tool("skills.serve", { effect: "read", internal: true, callers: ["module"], description: "A team member's own skills on the team's server: browse, list, get or versions, as that member, in that Space. Only the daemon's member door runs it.", input: serveInput(["browse", "list", "get", "versions"]), run: serve(["browse", "list", "get", "versions"]) });
    ctx.tool("skills.serve-write", { effect: "write", internal: true, callers: ["module"], description: "A team member's own skills on the team's server: draft, approve, decline or rollback, as that member, in that Space. Only the daemon's member door runs it.", input: serveInput(["draft", "approve", "decline", "rollback"]), run: serve(["draft", "approve", "decline", "rollback"]) });
    return { async stop() {} };
  },
};
