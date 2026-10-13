// @ts-check
// agents: the configuration page's server half. An agent's two instruction files, the context it keeps (uploaded files, folders of its projects), the Vault items its person has put at its disposal, and where it is used.
//
// Nothing here holds a secret. A Vault assignment is a NAME on a list the agent is told about; using the item is still the vault's own rule (vault.agent.grant / vault.agent.fill, the person's yes).
// Model sign-ins are not here at all: the order an agent tries them in is sessions.routes (scope agent:<name>), and the credentials sit in the Vault.
import fs from "node:fs";
import path from "node:path";
import { Access, accessMigration } from "../../lib/access.js";
import { agentDir, agentPart } from "../../lib/files/layout.js";

export const MIGRATIONS = [
  `CREATE TABLE agents_context_links (agent TEXT NOT NULL, path TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (agent, path));
   CREATE TABLE agents_vault_items (agent TEXT NOT NULL, item TEXT NOT NULL, by TEXT, at INTEGER NOT NULL, PRIMARY KEY (agent, item))`,
  // Who else may use or edit an agent, besides its creator, the owner and the admins: a person or a role, at one of two levels. Who added each folder link is kept, because a link is judged against the person adding it.
  `${accessMigration("agents_access")};
   ALTER TABLE agents_context_links ADD COLUMN by TEXT`,
];

export const DOC_FILES = Object.freeze(["AGENTS.md", "CLAUDE.md"]);
const DOC_MAX = 64 * 1024;
export const CONTEXT_MAX = 10 * 1024 * 1024;
const CONTEXT_FILES_MAX = 200;
const ITEM = /^[A-Za-z0-9][A-Za-z0-9 ._:@/-]{0,127}$/;

/** An uploaded file's name is a name and nothing more. @param {unknown} s */
export const contextName = s => String(s ?? "").trim().split(/[\\/]/).pop().replace(/^\.+/, "").trim();

/** Whether `f` is `dir` or lies inside it. */
const inside = (dir, f) => { const r = path.relative(dir, f); return r === "" || (!!r && !r.startsWith("..") && !path.isAbsolute(r)); };
const bad = (/** @type {string} */ m, code = "bad_input") => Object.assign(new Error(m), { code });

/** What an agent is told about its context, after its instructions: names only, never contents. @param {{ dir: string, files: string[], links: string[], items: string[], claude: string }} c */
export function contextBrief(c) {
  const out = [];
  if (c.claude) out.push("", "Notes for Claude:", c.claude);
  if (c.files.length) out.push("", `Context files kept for you, in ${c.dir}: ${c.files.join(", ")}. Read them when they bear on the work.`);
  if (c.links.length) out.push("", `Folders linked for you: ${c.links.join(", ")}.`);
  if (c.items.length) out.push("", `Vault items put at your disposal (names only; using one still needs the person's yes): ${c.items.join(", ")}.`);
  return out.join("\n");
}

/**
 * @param {any} ctx
 * @param {{ db: any, root: string, must: (n: string) => any, mayChange: (m: any, a: any) => Promise<boolean>, notYours: (w: string) => Error, guard: (c: any, w: string) => void,
 *   modelMay: (m: any) => boolean, personOf: (m: any) => Promise<string>, scope: (a: any) => Promise<{ projects: any, cwds: string[] }>,
 *   setWords: (a: any, instructions: string, by: string) => void, seesFull: (m: any) => Promise<boolean>, chainPerson: (m: any) => Promise<string | null>, roleOf: (person: string) => Promise<string | null>, changed?: () => void }} h
 */
export function register(ctx, h) {
  const { db } = h;
  const shared = new Access(db, "agents_access");
  const home = (/** @type {any} */ a) => path.join(h.root, agentDir(String(a.uid)));
  const ctxDir = (/** @type {any} */ a) => path.join(h.root, agentPart(String(a.uid), "context"));
  const only = (/** @type {any} */ meta, what) => {
    const { caller } = meta;
    h.guard(caller, what);
    if (!h.modelMay(meta)) throw Object.assign(new Error("only the person changes an agent's files, context and vault list"), { code: "denied" });
  };
  /**
   * What the caller may do with this agent: "edit" (its creator, the owner, an admin, or anyone given Can edit, by name or by role), "use" (given Can use), or "none".
   * @param {any} meta @param {any} a @returns {Promise<"edit" | "use" | "none">}
   */
  const levelOf = async (meta, a) => {
    if (await h.mayChange(meta, a)) return "edit";
    const me = await h.chainPerson(meta);
    if (!me) return "none";
    return shared.level(a.name, { person: me, role: await h.roleOf(me).catch(() => null) });
  };
  const readOk = async (/** @type {any} */ meta, /** @type {any} */ a) => { only(meta, "read another agent's files"); if ((await levelOf(meta, a)) !== "edit") throw h.notYours("reads its files (Can edit)"); };
  const writeOk = async (/** @type {any} */ meta, /** @type {any} */ a) => { only(meta, "change another agent's files"); if ((await levelOf(meta, a)) !== "edit") throw h.notYours("changes its files (Can edit)"); };
  const useOk = async (/** @type {any} */ meta, /** @type {any} */ a) => { only(meta, "read another agent's use"); if ((await levelOf(meta, a)) === "none") throw h.notYours("sees where it is used (Can use)"); };
  const shareOk = async (/** @type {any} */ meta, /** @type {any} */ a) => { only(meta, "share another agent"); if (!(await h.mayChange(meta, a))) throw h.notYours("shares it"); };
  // The folder layout (lib/files/layout.js, files-layout): agents/<id>/ with instructions/, context/, memory/ and work/.
  const claudeFile = (/** @type {any} */ a) => path.join(h.root, agentPart(String(a.uid), "instructions"), "CLAUDE.md");
  const oldClaudeFile = (/** @type {any} */ a) => path.join(home(a), "CLAUDE.md");   // where an earlier build kept it: still read, never written
  const ensureParts = (/** @type {any} */ a) => { for (const part of ["instructions", "context", "memory"]) fs.mkdirSync(path.join(h.root, agentPart(String(a.uid), part)), { recursive: true, mode: 0o700 }); };
  const readClaude = (/** @type {any} */ a) => { for (const f of [claudeFile(a), oldClaudeFile(a)]) { try { return fs.readFileSync(f, "utf8"); } catch { /* the next place */ } } return ""; };
  const listFiles = (/** @type {any} */ a) => {
    try { return fs.readdirSync(ctxDir(a), { withFileTypes: true }).filter(e => e.isFile()).map(e => { const s = fs.statSync(path.join(ctxDir(a), e.name)); return { name: e.name, size: s.size, at: Math.round(s.mtimeMs) }; }).sort((x, y) => x.name.localeCompare(y.name)); }
    catch { return []; }
  };
  const links = (/** @type {any} */ a) => db.prepare("SELECT path FROM agents_context_links WHERE agent = ? ORDER BY at").all(a.name).map((/** @type {any} */ r) => String(r.path));
  const items = (/** @type {any} */ a) => db.prepare("SELECT item FROM agents_vault_items WHERE agent = ? ORDER BY at").all(a.name).map((/** @type {any} */ r) => String(r.item));

  /** What a launch adds to an agent's brief. */
  const brief = (/** @type {any} */ a) => contextBrief({ dir: ctxDir(a), files: listFiles(a).map((/** @type {any} */ f) => f.name), links: links(a), items: items(a), claude: readClaude(a).trim() });

  ctx.tool("agents.docs.get", {
    description: "An agent's two instruction files: AGENTS.md (its instructions) and CLAUDE.md (extra notes for Claude).",
    input: { type: "object", required: ["agent"], properties: { agent: { type: "string" } } },
    run: async ({ agent }, meta) => { const a = h.must(agent); await readOk(meta, a); return { files: { "AGENTS.md": a.instructions || "", "CLAUDE.md": readClaude(a) } }; },
  });
  ctx.tool("agents.docs.set", {
    description: "Write one of an agent's instruction files. AGENTS.md is its instructions (a new version); CLAUDE.md is kept beside it. Applies from the next turn.",
    input: { type: "object", required: ["agent", "file", "text"], properties: { agent: { type: "string" }, file: { type: "string", enum: [...DOC_FILES] }, text: { type: "string" } } },
    run: async ({ agent, file, text }, meta) => {
      const a = h.must(agent);
      await writeOk(meta, a);
      if (!DOC_FILES.includes(file)) throw bad(`file is ${DOC_FILES.join(" or ")}`);
      if (typeof text !== "string" || text.length > DOC_MAX) throw bad(`the text is up to ${DOC_MAX / 1024} KB`);
      if (a.builtin && file === "CLAUDE.md") throw Object.assign(new Error(`${a.name} is built in: only its instructions change`), { code: "denied" });
      if (file === "AGENTS.md") h.setWords(a, text, await h.personOf(meta));
      else { ensureParts(a); const f = claudeFile(a); fs.writeFileSync(f + ".tmp", text, { mode: 0o600 }); fs.renameSync(f + ".tmp", f); }
      return { ok: true, file };
    },
  });

  ctx.tool("agents.context.list", {
    description: "What an agent keeps as context: the files uploaded to it and the folders linked to it.",
    input: { type: "object", required: ["agent"], properties: { agent: { type: "string" } } },
    run: async ({ agent }, meta) => { const a = h.must(agent); await readOk(meta, a); return { files: listFiles(a), links: links(a) }; },
  });
  ctx.tool("agents.context.add", {
    description: "Keep a file as an agent's context (agents/<id>/context/). base64 is the file's bytes, up to 10 MB; the same name replaces the file.",
    input: { type: "object", required: ["agent", "name", "base64"], properties: { agent: { type: "string" }, name: { type: "string" }, base64: { type: "string" } } },
    run: async ({ agent, name, base64 }, meta) => {
      const a = h.must(agent);
      await writeOk(meta, a);
      const n = contextName(name);
      if (!n || n.length > 120 || /[\u0000-\u001f]/.test(n)) throw bad("give the file a plain name");
      if (typeof base64 !== "string" || base64.length > Math.ceil(CONTEXT_MAX * 4 / 3) + 8) throw bad("a context file is up to 10 MB");
      const buf = Buffer.from(base64, "base64");
      if (buf.length > CONTEXT_MAX) throw bad("a context file is up to 10 MB");
      const dir = ctxDir(a);
      ensureParts(a);
      if (!fs.existsSync(path.join(dir, n)) && listFiles(a).length >= CONTEXT_FILES_MAX) throw bad(`an agent keeps up to ${CONTEXT_FILES_MAX} context files`);
      const f = path.join(dir, n);
      if (!inside(dir, f) || f === dir) throw bad("give the file a plain name");
      fs.writeFileSync(f + ".tmp", buf, { mode: 0o600 });
      fs.renameSync(f + ".tmp", f);
      return { ok: true, name: n, size: buf.length };
    },
  });
  ctx.tool("agents.context.remove", {
    description: "Take a file out of an agent's context.",
    input: { type: "object", required: ["agent", "name"], properties: { agent: { type: "string" }, name: { type: "string" } } },
    run: async ({ agent, name }, meta) => {
      const a = h.must(agent);
      await writeOk(meta, a);
      const f = path.join(ctxDir(a), contextName(name));
      if (!contextName(name) || !inside(ctxDir(a), f) || !fs.existsSync(f)) throw Object.assign(new Error(`${a.name} has no context file ${name}`), { code: "not_found" });
      fs.rmSync(f);
      return { ok: true };
    },
  });
  ctx.tool("agents.context.link", {
    description: "Link a folder as an agent's context. The folder must lie inside one of the agent's projects: linking never gives an agent reach it did not have.",
    input: { type: "object", required: ["agent", "path"], properties: { agent: { type: "string" }, path: { type: "string" } } },
    run: async ({ agent, path: p }, meta) => {
      const a = h.must(agent);
      await writeOk(meta, a);
      if (typeof p !== "string" || !path.isAbsolute(p) || p.length > 1024) throw bad("give the folder's full path");
      let real;
      try { real = fs.realpathSync(p); if (!fs.statSync(real).isDirectory()) throw new Error("x"); } catch { throw bad("that is not a folder on this machine"); }
      const { cwds } = await h.scope(a);
      if (!cwds.some(c => { try { return inside(fs.realpathSync(c), real); } catch { return false; } })) throw Object.assign(new Error(`${a.name} cannot see that folder: it is not inside one of its projects. Add the folder to a project ${a.name} works in first`), { code: "denied" });
      // A link is judged against the person ADDING it: she can link only a folder of a project she can read herself.
      const person = await h.personOf(meta);
      if (person) {
        const pl = await ctx.call("projects.list", {}).catch(() => null);
        const owning = (pl && !pl.error && pl.data && Array.isArray(pl.data.projects) ? pl.data.projects : []).filter((/** @type {any} */ p) => (a.projects === "*" || a.projects.includes(p.slug)) && [p.home, ...(p.workspaces || p.folders || [])].filter(Boolean).some((/** @type {string} */ c) => { try { return inside(fs.realpathSync(c), real); } catch { return false; } }));
        for (const p of owning) {
          const may = await ctx.call("work.project.may-read", { project: p.slug, person }).catch(() => null);
          if (!(may && !may.error && may.data && may.data.ok === true)) throw Object.assign(new Error(`you cannot read the project ${p.slug} yourself, so you cannot link its folders for an agent. Link a folder of a project you can open`), { code: "denied" });
        }
      }
      db.prepare("INSERT OR IGNORE INTO agents_context_links (agent, path, by, at) VALUES (?,?,?,?)").run(a.name, real, await h.personOf(meta), Date.now());
      return { ok: true, path: real };
    },
  });
  ctx.tool("agents.context.unlink", {
    description: "Unlink a folder from an agent's context. The folder itself is not touched.",
    input: { type: "object", required: ["agent", "path"], properties: { agent: { type: "string" }, path: { type: "string" } } },
    run: async ({ agent, path: p }, meta) => { const a = h.must(agent); await writeOk(meta, a); db.prepare("DELETE FROM agents_context_links WHERE agent = ? AND path = ?").run(a.name, String(p)); return { ok: true }; },
  });

  ctx.tool("agents.vault.list", {
    description: "The Vault items put at an agent's disposal (names only).",
    input: { type: "object", required: ["agent"], properties: { agent: { type: "string" } } },
    run: async ({ agent }, meta) => { const a = h.must(agent); await readOk(meta, a); return { assigned: items(a) }; },
  });
  ctx.tool("agents.vault.assign", {
    description: "Put a Vault item at an agent's disposal: its name goes on the agent's list and in its brief. It grants no access by itself: using an item is still the vault's own rule and the person's yes.",
    input: { type: "object", required: ["agent", "item"], properties: { agent: { type: "string" }, item: { type: "string" } } },
    run: async ({ agent, item }, meta) => {
      const a = h.must(agent);
      await writeOk(meta, a);
      if (a.builtin) throw Object.assign(new Error(`${a.name} is built in and takes no Vault items`), { code: "denied" });
      if (typeof item !== "string" || !ITEM.test(item)) throw bad("that is not a Vault item name");
      db.prepare("INSERT OR IGNORE INTO agents_vault_items (agent, item, by, at) VALUES (?,?,?,?)").run(a.name, item, await h.personOf(meta), Date.now());
      return { ok: true };
    },
  });
  ctx.tool("agents.vault.unassign", {
    description: "Take a Vault item off an agent's list. Grants the vault already made for it are revoked in the Vault.",
    input: { type: "object", required: ["agent", "item"], properties: { agent: { type: "string" }, item: { type: "string" } } },
    run: async ({ agent, item }, meta) => { const a = h.must(agent); await writeOk(meta, a); db.prepare("DELETE FROM agents_vault_items WHERE agent = ? AND item = ?").run(a.name, String(item)); return { ok: true }; },
  });

  ctx.tool("agents.access.get", {
    description: "Who may use or edit an agent besides its creator, the owner and the admins, and the people and roles that could be picked.",
    input: { type: "object", required: ["agent"], properties: { agent: { type: "string" } } },
    run: async ({ agent }, meta) => {
      const a = h.must(agent);
      await writeOk(meta, a);
      const access = shared.list(a.name);
      const sp = ctx.kernel && ctx.kernel.space ? await ctx.call("spaces.members.list", { space: ctx.kernel.space }).catch(() => null) : null;
      const people = sp && !sp.error && sp.data && Array.isArray(sp.data.members) ? sp.data.members.map((/** @type {any} */ m) => ({ id: String(m.person), name: String(m.name || m.person), role: String(m.role || "") })) : [];
      const rl = await ctx.call("roles.list", {}).catch(() => null);
      const rrows = rl && !rl.error && rl.data ? (Array.isArray(rl.data) ? rl.data : rl.data.roles || []) : [];
      const roles = rrows.map((/** @type {any} */ r) => ({ id: String(r.id || r.role || r.name), name: String(r.name || r.label || r.id) })).filter((/** @type {any} */ r) => r.id && r.id !== "owner");
      return { access, people, roles };
    },
  });
  ctx.tool("agents.access.set", {
    description: "Share an agent with a person or a role: Can use (chat with it, assign it, use it in flows) or Can edit (change its instructions, context, models and links). level null takes the access away. Only its creator, the owner or an admin shares it.",
    input: { type: "object", required: ["agent", "kind", "subject"], properties: { agent: { type: "string" }, kind: { type: "string", enum: ["person", "role"] }, subject: { type: "string" }, level: { type: ["string", "null"], enum: ["use", "edit", null] } } },
    run: async ({ agent, kind, subject, level }, meta) => {
      const a = h.must(agent);
      await shareOk(meta, a);
      if (a.builtin && level) throw Object.assign(new Error(`${a.name} is built in and is not shared`), { code: "denied" });
      shared.set(a.name, { kind, subject, level: level ?? null }, await h.personOf(meta));
      if (h.changed) h.changed();
      return { ok: true };
    },
  });

  ctx.tool("agents.used", {
    description: "Where an agent is used: its chats, and the flows that name it as a doer.",
    input: { type: "object", required: ["agent"], properties: { agent: { type: "string" } } },
    run: async ({ agent }, meta) => {
      const a = h.must(agent);
      await useOk(meta, a);
      const th = await ctx.call("threads.list", { agent: a.name }).catch(() => null);
      const rows = th && !th.error && Array.isArray(th.data) ? th.data : th && th.data && Array.isArray(th.data.threads) ? th.data.threads : [];
      const chats = rows.slice(0, 50).map((/** @type {any} */ t) => ({ id: String(t.id), title: String(t.title || t.name || t.summary || "Chat") }));
      /** @type {{ id: string, name: string }[]} */ const flows = [];
      const fl = await ctx.call("flows.list", {}).catch(() => null);
      const frows = fl && !fl.error && Array.isArray(fl.data) ? fl.data : fl && fl.data && Array.isArray(fl.data.flows) ? fl.data.flows : [];
      const refs = [`teammate:${a.name}`, `agent:${a.name}`];
      for (const f of frows.slice(0, 60)) {
        const g = await ctx.call("flows.get", { id: f.id }).catch(() => null);
        const text = g && !g.error ? JSON.stringify(g.data && g.data.flow || "") : "";
        if (refs.some(r => text.includes(`"${r}"`))) flows.push({ id: String(f.id), name: String(f.name || f.title || f.id) });
      }
      return { chats, flows };
    },
  });
  return { brief, levelOf };
}
