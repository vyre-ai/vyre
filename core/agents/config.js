// @ts-check
// agents: the configuration page's server half. An agent's instructions (AGENTS.md; CLAUDE.md is only a pointer at it), the context it keeps (uploaded files, folders of its projects), the Vault items its person has put at its disposal, and where it is used.
//
// Nothing here holds a secret. A Vault assignment is a NAME on a list the agent is told about; using the item is still the vault's own rule (vault.agent.grant / vault.agent.fill, the person's yes).
// Model sign-ins are not here at all: the order an agent tries them in is sessions.routes (scope agent:<name>), and the credentials sit in the Vault.
import fs from "node:fs";
import path from "node:path";
import { agentDir, agentPart } from "../../lib/files/layout.js";
import { writeDocs, writeRootFile, MIRROR_FILES, POINTER, withNotes } from "../../lib/folder-docs.js";

export const MIGRATIONS = [
  `CREATE TABLE agents_context_links (agent TEXT NOT NULL, path TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (agent, path));
   CREATE TABLE agents_vault_items (agent TEXT NOT NULL, item TEXT NOT NULL, by TEXT, at INTEGER NOT NULL, PRIMARY KEY (agent, item))`,
  // Who added each folder link is kept, because a link is judged against the person adding it. Who else may use or edit an agent is a kernel grant (below), not a table.
  `ALTER TABLE agents_context_links ADD COLUMN by TEXT`,
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

/** What an agent is told about what it may reach beyond its folder: the folders linked for it and the Vault item names put at its disposal. Names only. The instructions and context files are named by the orientation block (lib/orientation.js), never copied. @param {{ links: string[], items: string[] }} c */
export function contextBrief(c) {
  const out = [];
  if (c.links.length) out.push("", `Folders linked for you: ${c.links.join(", ")}.`);
  if (c.items.length) out.push("", `Vault items put at your disposal (names only; using one still needs the person's yes): ${c.items.join(", ")}.`);
  return out.join("\n");
}

/**
 * @param {any} ctx
 * @param {{ db: any, root: string, must: (n: string) => any, mayChange: (m: any, a: any) => Promise<boolean>, notYours: (w: string) => Error, guard: (c: any, w: string) => void,
 *   modelMay: (m: any) => boolean, personOf: (m: any) => Promise<string>, scope: (a: any) => Promise<{ projects: any, cwds: string[] }>,
 *   setWords: (a: any, instructions: string, by: string) => void, seesFull: (m: any) => Promise<boolean>, chainPerson: (m: any) => Promise<string | null>, roleOf: (person: string) => Promise<string | null>, changed?: () => void, staffOf?: (person: string) => Promise<boolean> }} h
 */
export function register(ctx, h) {
  const { db } = h;
  /** The agent's address in the kernel, and the one source its sharing grants carry. */
  const urnOf = (/** @type {any} */ a) => `vyre://${ctx.kernel.space}/agent/${a.uid}`;
  const sourceOf = (/** @type {any} */ a, /** @type {string} */ person) => `agents:access:${a.uid}:${person}`;
  /** Who an agent is shared with, read live from the kernel: [{ kind: "person", subject, level, by }]. @param {any} a */
  const sharedWith = async a => {
    const gs = (ctx.kernel && ctx.kernel.mint ? await ctx.kernel.mint.list({ source: `agents:access:${a.uid}:` }) : []) || [];
    return gs.filter((/** @type {any} */ g) => g.subject && g.subject.actor).map((/** @type {any} */ g) => ({ kind: "person", subject: String(g.subject.actor.id), level: g.actions.includes("agents.edit") ? "edit" : "use", by: /^shared by (\S+):/.exec(String(g.reason || ""))?.[1] ?? null }));
  };
  const home = (/** @type {any} */ a) => path.join(h.root, agentDir(String(a.uid)));
  const ctxDir = (/** @type {any} */ a) => path.join(h.root, agentPart(String(a.uid), "context"));
  const only = (/** @type {any} */ meta, what) => {
    const { caller } = meta;
    h.guard(caller, what);
    // Person surfaces only: an agent (a caller labelled with one, or a verified agent behind the call), a model, a guest never reads or edits an agent's configuration through these tools; an agent gets its own
    // instructions and context when its session starts.
    if (!h.modelMay(meta) || (meta && meta.agent) || /:agent:|^mcp|^harness|guest/.test(String(caller || ""))) throw Object.assign(new Error("only a person changes or reads an agent's files, context, sharing and vault list; an agent gets its own at the start of its session"), { code: "denied" });
  };
  /**
   * What the caller may do with this agent: "edit" (its creator, the owner, an admin, or anyone given Can edit, by name or by role), "use" (given Can use), or "none".
   * @param {any} meta @param {any} a @returns {Promise<"edit" | "use" | "none">}
   */
  const levelOf = async (/** @type {any} */ meta, /** @type {any} */ a) => {
    if (await h.mayChange(meta, a)) return "edit";
    if (!ctx.kernel || typeof ctx.kernel.authorize !== "function" || typeof ctx.kernel.chain !== "function") return "none";
    const chain = await ctx.kernel.chain(meta).catch(() => null);
    if (!chain) return "none";
    // the kernel's authorize is the only place this is decided: a grant on this agent for this person, or nothing
    for (const [action, level] of /** @type {const} */ ([["agents.edit", "edit"], ["agents.use", "use"]])) {
      const d = await ctx.kernel.authorize({ chain, action, resource: urnOf(a) }).catch(() => null);
      if (d && d.effect === "allow") return level;
    }
    return "none";
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
  /** The agent's instructions as a person and a session read them: AGENTS.md, with notes an older CLAUDE.md kept apart appended once under "Notes" (they are folded into the stored words on the next write). */
  const viewOf = (/** @type {any} */ a) => withNotes(String(a.instructions || ""), readClaude(a));
  const listFiles = (/** @type {any} */ a) => {
    try { return fs.readdirSync(ctxDir(a), { withFileTypes: true }).filter(e => e.isFile()).map(e => { const s = fs.statSync(path.join(ctxDir(a), e.name)); return { name: e.name, size: s.size, at: Math.round(s.mtimeMs) }; }).sort((x, y) => x.name.localeCompare(y.name)); }
    catch { return []; }
  };
  const links = (/** @type {any} */ a) => db.prepare("SELECT path FROM agents_context_links WHERE agent = ? ORDER BY at").all(a.name).map((/** @type {any} */ r) => String(r.path));
  const items = (/** @type {any} */ a) => db.prepare("SELECT item FROM agents_vault_items WHERE agent = ? ORDER BY at").all(a.name).map((/** @type {any} */ r) => String(r.item));

  /** What a launch adds to an agent's brief. */
  const brief = (/** @type {any} */ a) => contextBrief({ links: links(a), items: items(a) });
  /**
   * The agent's folder as a session reads it: AGENTS.md (its instructions) at its root, CLAUDE.md as exactly a pointer at it, so Claude Code and Codex read it natively when the session runs there, and the folders
   * the orientation names. Written fresh at every launch from the stored truth; never from the session. Notes an older build kept in CLAUDE.md are moved beside the stored words first, so the pointer loses nothing. @param {any} a
   * @returns {{ dir: string, instructions: boolean, context: boolean }}
   */
  const materialize = a => {
    ensureParts(a);
    const kept = claudeFile(a);
    if (!fs.existsSync(kept)) { const old = readClaude(a); if (old.trim()) { try { fs.writeFileSync(kept, old, { mode: 0o600, flag: "wx" }); } catch { /* written by a racing launch */ } } }
    const words = viewOf(a).trim();
    writeDocs(home(a), "AGENTS.md", words ? words + "\n" : "");
    writeDocs(home(a), "CLAUDE.md", words ? POINTER : "");
    // the same words under the other tools' names (Grok reads GROK.md)
    for (const m of MIRROR_FILES) writeRootFile(home(a), m, words ? words + "\n" : "");
    return { dir: home(a), instructions: Boolean(words), context: listFiles(a).length > 0 };
  };

  // Who made an agent, for the kernel: an agent may check another agent's work only while the person who made it is an owner or an admin (kernel/tasks), so the kernel asks, live, each time.
  ctx.tool("agents.maker", {
    description: "The person who made an agent (its owner row), or null. For the kernel's check of an agent that approves another agent's work.",
    internal: true, callers: ["module"],
    input: { type: "object", required: ["agent"], properties: { agent: { type: "string" } } },
    run: async ({ agent }) => { const a = h.must(agent); return { made_by: a.owner ? String(a.owner) : null }; },
  });
  ctx.tool("agents.instructions", {
    description: "An agent's instructions text (its AGENTS.md), for a session's system prompt.", internal: true, callers: ["module"],
    input: { type: "object", required: ["agent"], properties: { agent: { type: "string" } } },
    run: async ({ agent }) => { const a = h.must(agent); return { name: a.name, text: viewOf(a) }; },
  });
  ctx.tool("agents.docs.get", {
    description: "An agent's instructions: AGENTS.md. (CLAUDE.md beside it is only a pointer at it.)",
    input: { type: "object", required: ["agent"], properties: { agent: { type: "string" } } },
    run: async ({ agent }, meta) => { const a = h.must(agent); await readOk(meta, a);
      // who made it and who last changed its words: a less-privileged author's words run with a more privileged asker's authority, so the page says so
      const last = /** @type {any} */ (db.prepare("SELECT by FROM agents_versions WHERE agent = ? ORDER BY n DESC LIMIT 1").get(a.name));
      const made = a.owner ? { id: String(a.owner), staff: h.staffOf ? await h.staffOf(String(a.owner)).catch(() => false) : false } : null;
      return { files: { "AGENTS.md": viewOf(a) }, made_by: made, edited_by: last && last.by ? String(last.by) : null };
    },
  });
  ctx.tool("agents.docs.set", {
    description: "Write an agent's instructions (file AGENTS.md; a new version). CLAUDE.md is only a pointer at it and cannot be written. Applies from the next turn.",
    input: { type: "object", required: ["agent", "file", "text"], properties: { agent: { type: "string" }, file: { type: "string" }, text: { type: "string" } } },
    run: async ({ agent, file, text }, meta) => {
      const a = h.must(agent);
      await writeOk(meta, a);
      if (file !== "AGENTS.md") throw bad("Instructions live in AGENTS.md. Write them there; CLAUDE.md only points at it.");
      if (typeof text !== "string" || text.length > DOC_MAX) throw bad(`the text is up to ${DOC_MAX / 1024} KB`);
      // notes an older CLAUDE.md kept apart go into AGENTS.md once, under "Notes", and the separate file is retired
      const full = withNotes(text, readClaude(a));
      if (full.length > DOC_MAX) throw bad(`the text and the old notes together are over ${DOC_MAX / 1024} KB: shorten them`);
      h.setWords(a, full, await h.personOf(meta));
      try { fs.rmSync(claudeFile(a), { force: true }); } catch { /* nothing kept apart */ }
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
      if (!contextName(name) || !inside(ctxDir(a), f) || !fs.existsSync(f)) throw Object.assign(new Error(`${a.name} has no context file ${name}. agents.context.list shows what it keeps`), { code: "not_found" });
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
          if (!(may && !may.error && may.data && may.data.ok === true)) throw Object.assign(new Error(`you cannot read the project ${p.slug} yourself, so you cannot link its folders for an agent. Ask the project's owner to add you, or link a folder of a project you can open`), { code: "denied" });
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
      if (a.builtin) throw Object.assign(new Error(`${a.name} is built in and takes no Vault items. Put the item on an agent you made, with agents.vault.assign`), { code: "denied" });
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
      const access = await sharedWith(a);
      // the people who could be picked: the Space's members, read through the kernel on the CALLER's own chain (it shows a manager and above everyone, a member only what she may see). A role is not
      // offered: an agent is shared with a person for now.
      let people = [];
      try {
        const chain = ctx.kernel && typeof ctx.kernel.chain === "function" ? await ctx.kernel.chain(meta) : null;
        const ms = chain && ctx.kernel.grants && ctx.kernel.grants.members ? await ctx.kernel.grants.members.list(chain) : [];
        people = (Array.isArray(ms) ? ms : []).map((/** @type {any} */ m) => ({ id: String(m.person), name: String(m.name || m.display_name || m.person), role: String(m.role || "") }));
      } catch { people = []; }
      const roles = [];
      return { access, people, roles };
    },
  });
  ctx.tool("agents.access.set", {
    description: "Share an agent with a person or a role: Can use (chat with it, assign it, use it in flows) or Can edit (change its instructions, context, models and links). level null takes the access away. Only its creator, the owner or an admin shares it.",
    input: { type: "object", required: ["agent", "kind", "subject"], properties: { agent: { type: "string" }, kind: { type: "string", enum: ["person"] }, subject: { type: "string" }, level: { type: ["string", "null"], enum: ["use", "edit", null] } } },
    run: async ({ agent, kind, subject, level }, meta) => {
      const a = h.must(agent);
      await shareOk(meta, a);
      if (a.builtin && level) throw Object.assign(new Error(`${a.name} is built in and is not shared. Share an agent you made instead, with agents.access.set`), { code: "denied" });
      if (kind !== "person") throw bad("an agent is shared with a person for now; a role comes later");
      if (typeof subject !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/.test(subject)) throw bad("name the person to share with");
      if (level !== null && level !== undefined && !["use", "edit"].includes(level)) throw bad("level is use, edit or null");
      if (!ctx.kernel || !ctx.kernel.mint) throw Object.assign(new Error("sharing an agent needs the kernel"), { code: "unavailable" });
      const by = await h.personOf(meta);
      await ctx.kernel.mint.end({ source: sourceOf(a, subject), reason: "the sharing of this agent changed" });
      if (level) await ctx.kernel.mint.make({ subject: { kind: "actor", actor: { kind: "person", id: subject, space: ctx.kernel.space } }, actions: level === "edit" ? ["agents.use", "agents.edit"] : ["agents.use"], resource: { prefix: urnOf(a) }, source: sourceOf(a, subject), reason: `shared by ${by || "the owner"}: ${level === "edit" ? "Can edit" : "Can use"}` });
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
  /** The sharing as short lines for the agent record: "per_x (edit)". @param {any} a */
  const sharedLine = async a => (await sharedWith(a).catch(() => [])).map((/** @type {any} */ g) => `${g.subject} (${g.level})`);
  /** An agent that is gone takes its sharing with it. @param {any} a */
  const clearShared = async a => { if (ctx.kernel && ctx.kernel.mint) for (const g of await ctx.kernel.mint.list({ source: `agents:access:${a.uid}:` })) await ctx.kernel.mint.end({ id: g.id, reason: "the agent was removed" }); };
  /**
   * Who made an agent and who it is shared with, for the list: the maker's person id, and [{ person, level }]. The owner, an admin, the maker and anyone with Can edit see every share; anyone
   * else sees only their own, so a list never shows who else was given an agent. @param {any} meta @param {any} a @param {boolean} staff
   */
  const sharesFor = async (meta, a, staff) => {
    const all = (await sharedWith(a).catch(() => [])).map((/** @type {any} */ g) => ({ person: g.subject, level: g.level }));
    if (staff || (await levelOf(meta, a)) === "edit") return { made_by: a.owner || null, shares: all };
    const me = await h.chainPerson(meta);
    return { made_by: a.owner || null, shares: me ? all.filter((/** @type {any} */ g) => g.person === me) : [] };
  };
  return { brief, materialize, levelOf, sharedLine, clearShared, sharesFor };
}
