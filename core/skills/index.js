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
import { PKG_ROOT } from "../../kernel/devbuild.js";
import { isPerson, agentName } from "../../lib/caller.js";
import { frontMatter } from "../../lib/docs-corpus.js";
import { buildIndex, search } from "../../lib/docs-rank.js";
import { tokens } from "../../lib/tokens.js";

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_BODY = 64 * 1024;
const err = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/** Test seam: the Vyre package root (where harness/skills is) per home. @type {Map<string, { pkg: string }>} */
export const seams = new Map();

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
    out.push({ id, name: String(data.name || name), level: where.level, scope: where.scope, description: String(data.description || "").replace(/\s+/g, " ").slice(0, 600), text, body, tokens: tokens(text) });
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
const shown = (s) => ({ id: s.id, name: s.name, level: s.level, ...(s.scope ? { scope: s.scope } : {}), description: s.description, tokens: s.tokens });

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const home = String((ctx.paths && ctx.paths.root) || "");
    const seam = seams.get(home);
    const pkg = seam ? seam.pkg : PKG_ROOT;

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
      if (q.level) list = list.filter((x) => x.level === q.level);
      return list;
    };

    ctx.tool("skills.list", {
      effect: "read",
      description: "The skills you may use, each { id, name, level, scope, description, tokens }. level is vyre (Vyre's own), account (the person's installed skills), project or agent. Narrow with `project` or `level`. Nothing you may not use is listed. skills.find ranks them for what you are about to do.",
      input: { type: "object", properties: { project: { type: "string", maxLength: 64 }, level: { type: "string", enum: ["vyre", "account", "project", "agent"] }, limit: { type: "integer", minimum: 1, maximum: 200 } } },
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        const list = await visible(meta, { project: input.project, level: input.level });
        return { skills: list.slice(0, input.limit || 100).map(shown), total: list.length };
      },
    });

    ctx.tool("skills.find", {
      effect: "read",
      description: "The skills that fit what you are about to do, best first: { id, name, level, description, tokens }. `query` is plain words (\"keep a password out of a file\"). Only skills you may use are ranked. Read one with tools_call skills.get.",
      input: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 300 }, limit: { type: "integer", minimum: 1, maximum: 10 }, project: { type: "string", maxLength: 64 } }, required: ["query"] },
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        const list = await visible(meta, { project: input.project });
        if (!list.length) return { skills: [] };
        const index = buildIndex(list.map((s) => ({ path: s.id, title: s.name, when: s.description, summary: "", headings: [], body: s.body, ref: s })));
        const hits = search(index, String(input.query), { limit: input.limit || 5 });
        return { skills: hits.map((h) => shown(/** @type {any} */ (h.page).ref)) };
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
    return { async stop() {} };
  },
};
