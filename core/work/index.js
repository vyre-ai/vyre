// @ts-check
// work: the 0.3 work layer as module tools (DESIGN-native-assistant, DESIGN-tasks). Three things, one module, all over the kernel contracts:
//  - native.*   the tool surface generated from the Space's definitions and the action registry (kernel/tools), the situation and the component for a result
//  - teammates.* what a teammate starts with, adding one under the adder's ceiling, the doing-now line
//  - recall.*   the three-layer memory: lines, meaning search, answers with citations, fact proposals
// The module holds no authority. `ctx.kernel` (platform's) hands over the assembled Kernel and `ctx.kernel.chainFor(extra)`, which builds the chain from
// the call's own facts; a tool never builds or accepts a chain from its input. Until platform wires ctx.kernel every tool answers `unavailable`.

import { createTimeline } from "./timeline.js";
import { createToolSurface } from "../../kernel/tools/surface.js";
import { buildSituation } from "./native/situation.js";
import { createHub } from "./hub.js";
import { planUpgrade, runUpgrade, manifestPath } from "./chat-upgrade.js";
import crypto from "node:crypto";
import { planMove, runMove, linkedClosure } from "./project-move.js";
import { toComponent } from "./native/components.js";
import { teammateContext } from "./team/context.js";
import { teammateFromRole, markReviewed, checkAdd, addCardData } from "./team/roles.js";
import { delegateGrants } from "./team/delegate.js";
import { createDoingLine } from "./team/doing.js";
import { createMemoryEngine } from "./memory/index.js";
import { exportKnow, importKnow, forgetKnow } from "./memory/move.js";
import { holdersOf, createRing } from "../../lib/chat-keys.js";
import { createTemplates, registerTemplateTools } from "./templates.js";
import { createPersistent } from "./persistent.js";
import { parseStored } from "../../lib/attachments.js";
import { retryWhileAway, storeAway } from "./retry-away.js";

const obj = (properties = {}, required = []) => ({ type: "object", properties, required });
const unavailable = () => Object.assign(new Error("the kernel is not wired on this box yet; try again in a minute, or ask the owner or an admin"), { code: "unavailable" });
const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
/** Who may call the tools the assistant itself uses: the person's surfaces, modules and a model session. Every one runs under the caller's own kernel chain, which decides what it reaches; a model with no valid session token has no chain and is refused. */
const WORK_CALLERS = ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "space", "agent", "module", "mcp", "harness"];
const urnOk = (/** @type {any} */ s) => typeof s === "string" && /^vyre:\/\/[^/]+\/[^/]+\/[^/]+$/.test(s);

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    /** @type {any} */ let surface = null;
    /** @type {any} */ let engine = null;
    /** @type {Map<string, any>} */ const doing = new Map();

    /** The kernel and the chain for this call. Both come from platform; a refusal to build a chain is the caller's, not ours. */
    const kernelOf = () => { const k = ctx.kernel; if (!k || typeof k.chainFor !== "function") throw unavailable(); return k; };
    const chainOf = (/** @type {any} */ extra) => kernelOf().chainFor(extra || {});
    /**
     * The room this call is running in, from the running session and never from the tool's input (a model that can name the chat can leave it out). `null` means
     * the kernel says it is a chat of one person; otherwise it is the kernel's room handle (no chain of another person ever reaches this module). If the kernel cannot say which, or says group and gives no audience, the
     * call is refused: there is no fallback to the one to one view.
     */
    const audienceOf = async (/** @type {any} */ extra) => {
      const k = kernelOf();
      const unknown = (/** @type {string} */ why) => Object.assign(new Error(why), { code: "unavailable" });
      if (typeof k.audienceFor !== "function") throw unknown("the room this runs in is not known, so nothing is built for it");
      // The kernel says `no_audience` for a call with no session of its own (the person at a surface, a session opened with no chat). That is one to one only when the call's own chain names no
      // chat either; a chain that names a chat and has no audience stays refused.
      const room = await k.audienceFor(extra || {}).catch(async (/** @type {any} */ e) => {
        if (e && e.code === "no_audience") { const own = await chainOf(extra).catch(() => null); if (own && !own.room) return { group: false }; }
        throw e;
      });
      if (!room || typeof room.group !== "boolean") throw unknown("the room this runs in is not known, so nothing is built for it");
      if (!room.group) return null;
      if (typeof room.read !== "function" || typeof room.canRead !== "function") throw unknown("this is a group chat and its audience is not known, so nothing is built for it");
      return room;
    };
    // KW-1 (kernel side): a `session` resource is read only by the person its `owner` attribute names, and no attribute means nobody. This module holds a session's lines, so it says whose they
    // are: the Space's owner (Recall indexes the owner's own sessions), and the project when the lines sit under one. Only for its own type, only `owner` and `project` (AT-1).
    if (ctx.kernel && typeof ctx.kernel.registerAttrs === "function") {
      ctx.kernel.registerAttrs("session", (/** @type {string} */ urn) => {
        const m = /^vyre:\/\/[^/]+\/session\/([A-Za-z0-9_.:-]{1,128})$/.exec(String(urn));
        if (!m) return {};
        try {
          const meta = engineOf().lines.meta(m[1]);
          if (!meta) return {};
          const p = /^vyre:\/\/[^/]+\/project\/([a-z0-9][a-z0-9_-]{0,79})$/i.exec(meta.record);
          return { owner: String(ctx.kernel.owner), ...(p ? { project: p[1] } : {}) };
        } catch { return {}; }
      });
    }
    const surfaceOf = () => surface || (surface = createToolSurface({ kernel: kernelOf(), space: kernelOf().space, types: async c => (kernelOf().definitions ? kernelOf().definitions(c) : []), actions: () => (kernelOf().actions ? kernelOf().actions() : []) }));
    // One engine per Space: a call that runs in a hosted Space has that Space's own kernel handle and its own database (`ctx.store.db` is a router that picks the running Space's file), and an engine built once
    // holds the home's. Keyed by the running Space's id, built inside the call.
    /** @type {Map<string, any>} */ const engines = new Map();
    const engineOf = () => {
      const k = kernelOf();
      if (engines.has(k.space)) return engines.get(k.space);
      if (!k.serviceChain || !k.chainForPerson || !ctx.store || !ctx.store.db) throw unavailable();
      const made = (createMemoryEngine({ kernel: k, db: ctx.store.db, space: k.space, serviceChain: k.serviceChain("memory"), chainFor: k.chainForPerson, ...(k.embed ? { embed: k.embed } : {}), ...(k.fieldDef ? { fieldDef: k.fieldDef, ownerOf: k.ownerOf } : {}) })); engines.set(k.space, made); return made;
    };

    // The Project hub: a Project is one record; each session is a summary record linked to it (core/work/hub.js, team/0.3/DESIGN-project-hub.md).
    /** @type {any} */ let hub = null;
    const hubOf = () => hub || (hub = createHub({ kernel: kernelOf(), call: async (tool, input) => { try { return await ctx.call(tool, input); } catch { return null; } }, ...(ctx.config && ctx.config.machine_name ? { machine: String(ctx.config.machine_name) } : {}), log: ctx.log }));
    if (ctx.kernel && ctx.events && typeof ctx.events.on === "function") {
      const hear = (/** @type {string} */ type, /** @type {(p: any, e: any) => any} */ f) => ctx.events.on(type, (/** @type {any} */ e) => { void Promise.resolve(f(e && e.payload, e)).catch(() => {}); });
      // a project made through the old project list (the CLI, the app) gets its record
      hear("project.created", p => (p && typeof p.project === "string" ? hubOf().ensureProject(p.project, p.name) : null));
      hear("thread.started", p => hubOf().onStarted(p));
      hear("thread.stopped", p => hubOf().onStopped(p));
      hear("thread.status", p => hubOf().onStatus(p));
      // a terminal session's chat was made (the switchboard, from the Harness's SessionStart)
      hear("thread.chat", p => hubOf().onChatLinked(p));
      // the kernel's own chat.created and chat.changed, passed on by the daemon (they are visible to the Space's owner only, which the daemon speaks as)
      hear("chat.created", p => hubOf().onChatCreated(p));
      hear("chat.changed", p => hubOf().onChatChanged(p));
      // a name changed in the old project list or on a thread reaches Records; a name changed in Records reaches them (core/work/hub.js)
      hear("project.changed", p => hubOf().onProjectChanged(p));
      hear("thread.renamed", p => hubOf().onThreadRenamed(p));
      // a /rename inside Claude Code reaches the transcript, which Recall indexes: checked at each turn's end
      hear("turn.completed", p => hubOf().onTurn(p));
      const k0 = ctx.kernel;
      if (k0.events && typeof k0.events.subscribe === "function" && typeof k0.serviceChain === "function") {
        try { k0.events.subscribe(k0.serviceChain("work"), "work-hub", {}, async (/** @type {any} */ e) => { if (e && (e.type === "project.updated" || e.type === "chat-record.updated")) await hubOf().onRecordChanged(e); }); } catch { /* no event feed in this kernel: the records are written from the switchboard's events alone */ }
      }
      // An upgraded box with agent project access from before reach became a kernel grant: ONE Needs-you item, once, so the person restores it (projects.access.restore, their own call). Nothing is
      // granted by the upgrade itself, so until then every agent is denied.
      const raiseRestore = async () => {
        try {
          const r = await ctx.call("projects.access.pending", {});
          const n = r && r.data ? Number(r.data.pending) : 0;
          const per = r && r.data && r.data.by_project ? Object.entries(r.data.by_project).map(([p, c]) => `${p} (${c})`).join(", ") : "";
          if (!n) return;
          const dbh = ctx.store.db;
          dbh.exec("CREATE TABLE IF NOT EXISTS work_flags (key TEXT PRIMARY KEY, at INTEGER NOT NULL)");
          if (dbh.prepare("SELECT 1 FROM work_flags WHERE key = 'access-restore'").get()) return;
          const k = kernelOf();
          const general = await hubOf().personalProject();
          await k.ask.request(k.serviceChain("work"), {
            title: "Restore who could see your projects", record: general.urn,
            doer: { kind: "person", id: String(k.owner), space: k.space }, output: { kind: "decision" }, source: "manual",
            note: `Before this update ${n} project access row${n === 1 ? "" : "s"} said which of your agents could reach which project${per ? `: ${per}` : ""}. They are kept, and nothing reaches a project until you restore them: run projects.access.restore, which turns each into the grant it was, in your own call. What you had revoked stays revoked.`,
          });
          dbh.prepare("INSERT INTO work_flags (key, at) VALUES ('access-restore', ?)").run(Date.now());
        } catch (e) { if (storeAway(e)) throw e; ctx.log(`work: the access-restore item was not raised: ${/** @type {Error} */ (e).message} ${String(/** @type {Error} */ (e).stack).split("\n").slice(1, 4).join(" | ")}`); /* a start never fails for this: the rows wait, and projects.access.pending says so */ }
      };
      const t = setTimeout(() => { void retryWhileAway(raiseRestore).catch(() => {}); }, 1500); if (typeof t.unref === "function") t.unref();
      // every person has a private Personal project, made on first need; the owner's now, and the old shared General is moved into its creators' once
      // (a team Space's own record store may still be starting: this is tried again until it is there, not given up on until the next restart)
      void retryWhileAway(() => hubOf().personalProject().then(() => hubOf().migrateGeneral())).catch((/** @type {Error} */ e) => ctx.log(`work: Personal project / General migration did not finish: ${e.message}`));
    }
    // Project templates and "start a project" (core/work/templates.js): the stages a project runs are the Flows stage module's, reached through the Flows host.
    registerTemplateTools({ ctx, chainOf, templates: createTemplates({ kernel: kernelOf, hub: hubOf, log: ctx.log,
      flows: () => { const h = ctx.flowsHost; return h && ctx.kernel ? h.get(ctx.kernel.space) : null; } }) });
    // One persistent chat per person for their assistant and for @Engineer (core/work/persistent.js, R031-94)
    /** @type {any} */ let persistent = null;
    const persistentOf = () => persistent || (persistent = createPersistent({ db: ctx.store.db, kernel: kernelOf,
      agentOf: async (/** @type {any} */ chain, /** @type {string} */ chat) => { const r = (await kernelOf().records.query(chain, "chat-record", { filter: { field: "chat", op: "eq", value: chat }, page: { limit: 1 } })).rows[0]; return r ? String(r.data.agents || "").split(",").map(x => x.trim()).filter(Boolean) : []; } }));
    ctx.tool("work.chat.persistent", { description: "Your pinned chat with your assistant or @Engineer (kind): its id or null if none yet, and whether you may have one.",
      input: obj({ kind: { type: "string", enum: ["assistant", "engineer"], description: "One of each per person, the same chat as the session rolls over. The Engineer is for an owner or an admin" } }, ["kind"]), run: async (/** @type {any} */ i, /** @type {any} */ extra) => (async () => { const c = await chainOf(extra); return persistentOf().get(c, i); })() });
    ctx.tool("work.chat.pinned", { description: "Whether a chat is a person's pinned assistant or Engineer chat: { kind: \"assistant\" | \"engineer\" | null }. For vyred, which lets only the pinned assistant chat run with the assistant's authority.", internal: true, callers: ["module"],
      input: obj({ person: { type: "string" }, chat: { type: "string" } }, ["person", "chat"]), run: async (/** @type {any} */ i) => { if (!ctx.store || !ctx.store.db) throw unavailable(); return { kind: persistentOf().kindOf(String(i.person), String(i.chat)) }; } });
    // A chat's name for the home's list of what runs on a person's computer (core/runner lent-home titleOf, through the daemon): any chat id, no person chain, at most 120 characters. Only the daemon's own modules ask.
    ctx.tool("work.chat.title", { description: "A chat's name, at most 120 characters: { title }. For the daemon, which names a lent chat on its computer's list.", internal: true, callers: ["module"],
      input: obj({ chat: { type: "string" } }, ["chat"]), run: async (/** @type {any} */ i) => { const rec = await hubOf().chatRecord(String(i.chat)); return { title: rec && rec.data && rec.data.title ? String(rec.data.title).slice(0, 120) : "" }; } });
    // Share to project (R031-41): a share is one `file-share` record by someone in the chat. The kernel does the rest: it opens that one file to the project's members and, for an encrypted chat, wraps the file's key into the project's ring (and rotates it when the last share goes).
    // The files a chat made or received, by name, with which are shared to its project. The chat's folders are sealed: the names come from the chat's own index, for the people in the chat only.
    // One timeline per record and project, and a chat's link to a record (core/work/timeline.js; R031-41, R031-46)
    /** @type {any} */ let tl = null;
    const timelineOf = () => tl || (tl = createTimeline({ kernelOf, hub: hubOf, inChat: (/** @type {any} */ c, /** @type {string} */ n) => inChat(c, n), me: (/** @type {any} */ c) => String((c.hops[0] && c.hops[0].actor.id) || ""),
      // the credentials linked to a record and how they were used (the Vault answers with names and times only)
      vaultUses: async (/** @type {string} */ urn, /** @type {number} */ limit) => { const r = /** @type {any} */ (await ctx.call("vault.uses.for", { urn, limit }, { relay: true })); return r && r.data && Array.isArray(r.data.uses) ? r.data.uses : []; } }));
    ctx.tool("work.timeline", { description: "Everything linked to a record or project, newest first: tasks, files, messages, documents, chats you may read. Give a record urn or project name.",
      input: obj({ record: { type: "string", description: "A record urn. A chat shows only if you are in it or its people shared it, and then only its title" }, project: { type: "string", description: "A project short name" }, limit: { type: "integer", minimum: 1, maximum: 200 } }), run: async (/** @type {any} */ i, /** @type {any} */ extra) => timelineOf().timeline(await chainOf(extra), i) });
    ctx.tool("work.link.suggest", { description: "Which records (client, contact, project) a piece of chat text names, for a link prompt. At most three you may read.",
      input: obj({ text: { type: "string", maxLength: 4000 } }, ["text"]), run: async (/** @type {any} */ i, /** @type {any} */ extra) => timelineOf().suggest(await chainOf(extra), i) });
    ctx.tool("work.chat.link", { description: "Say that a chat is about a record (give its urn; null takes the link off). The chat stays private to its people; `shared: true` shows it, by title, on that record's timeline to everyone who can see the record.",
      input: obj({ chat: { type: "string" }, record: { type: ["string", "null"] }, shared: { type: "boolean" } }, ["chat"]), run: async (/** @type {any} */ i, /** @type {any} */ extra) => timelineOf().link(await chainOf(extra), i) });
    ctx.tool("work.file.list", { description: "The files this chat has, received (chat/) and made (made/): name, size, time, shared with the project or not. Only for someone in the chat.",
      input: obj({ chat: { type: "string" } }, ["chat"]), run: async (/** @type {any} */ i, /** @type {any} */ extra) => {
        const k = kernelOf(), chain = await chainOf(extra), chat = String(i.chat);
        const rec = ((await k.records.query(chain, "chat-record", { filter: { field: "chat", op: "eq", value: chat }, page: { limit: 1 } })).rows || [])[0];
        const root = rec && rec.data && rec.data.drive ? String(rec.data.drive) : "";
        if (!root) return { files: [], root: "" };
        const shares = new Set(((await k.records.query(chain, "file-share", { page: { limit: 500 } }).catch(() => ({ rows: [] }))).rows || []).map((/** @type {any} */ r) => String(r.data.path)));
        const files = [];
        for (const kind of ["chat", "made"]) {
          for (const e of (await k.drive.list(chain, `${root}/${kind}/${chat}`).catch(() => [])) || []) {
            const path = String(e.path || ""), stored = path.slice(`${root}/${kind}/${chat}/`.length), name = (kind === "chat" && parseStored(stored)) ? /** @type {any} */ (parseStored(stored)).name : stored; // an attached file is stored as <id>-<name>; the panel shows the name
            if (stored && !stored.endsWith("/")) files.push({ path, name, kind: kind === "made" ? "made" : "received", size: Number(e.size || 0), at: Number(e.at || e.mtime || 0), shared: shares.has(path) });
          }
        }
        return { root, files };
      } });
    ctx.tool("work.file.share", { description: "Share one file of a chat you are in with that chat's project: its members open that one file and nothing else. Give the file's path (Projects/<project>/chat/<chat>/<name>).",
      input: obj({ path: { type: "string", maxLength: 500 } }, ["path"]), run: async (/** @type {any} */ i, /** @type {any} */ extra) => {
        const k = kernelOf(), chain = await chainOf(extra), m = /^Projects\/[^/]+\/(?:chat|made)\/([^/]+)\/./.exec(String(i.path));
        // only a chat's own people can share its files: a chat that is not theirs is not there for them
        const row = m ? ((await k.records.query(chain, "chat-record", { filter: { field: "chat", op: "eq", value: m[1] }, page: { limit: 1 } })).rows || [])[0] : null, me = chain.hops[0] && chain.hops[0].actor.id;
        if (!row || !String(row.data.people || "").split(",").map((/** @type {string} */ x) => x.trim()).includes(me)) throw Object.assign(new Error("that file is not in a chat of yours (work.file.list shows the files of a chat you are in)"), { code: "not_found" });
        const r = await k.records.create(chain, "file-share", { path: String(i.path) }); return { shared: true, id: r.id };
      } });
    ctx.tool("work.file.unshare", { description: "Take a shared file back: the project's members lose it at once. Give the file's path. You can take back the shares you made; an admin can take back any.",
      input: obj({ path: { type: "string", maxLength: 500 } }, ["path"]), run: async (/** @type {any} */ i, /** @type {any} */ extra) => {
        const k = kernelOf(), chain = await chainOf(extra);
        const rows = (await k.records.query(chain, "file-share", { filter: { field: "path", op: "eq", value: String(i.path) }, page: { limit: 50 } })).rows || [];
        let removed = 0;
        for (const r of rows) { try { await k.records.remove(chain, "file-share", r.id, r.version); removed++; } catch { /* not this person's to take back */ } }
        return { unshared: removed };
      } });
    ctx.tool("work.chat.pin", { description: "Make a chat you are in your pinned chat of a kind (assistant or engineer). A second, different chat of the same kind is refused and names the first: there is one each.",
      input: obj({ kind: { type: "string", enum: ["assistant", "engineer"] }, chat: { type: "string" } }, ["kind", "chat"]), run: async (/** @type {any} */ i, /** @type {any} */ extra) => (async () => { const c = await chainOf(extra); return persistentOf().pin(c, i); })() });
    ctx.tool("work.project.create", {
      description: "Make a Project: one record that holds the work's sessions, Drive folder (Projects/<short name>), repository and memory. Give a name, and optionally a repo (a git remote) and a client record.",
      input: obj({ name: { type: "string" }, repo: { type: "string" }, client: { type: "string" }, slug: { type: "string" } }, ["name"]),
      run: async (input, extra) => {
        const rec = await hubOf().createProject(await chainOf(extra), { name: input.name, repo: input.repo, client: input.client, slug: input.slug });
        return { project: rec.urn, slug: rec.data.slug, drive_path: rec.data.drive_path, memory_scope: rec.data.memory_scope };
      },
    });
    // Moving a Project to another Space (core/work/project-move.js, team/0.3/DESIGN-project-move.md): a side is a Space's gateway with the mover's own chain in THAT Space.
    const sideOf = async (/** @type {string} */ space, /** @type {any} */ extra) => {
      const k = kernelOf();
      // a Space on another server (My Cloud on the person's own server): this home cannot carry chats there yet, so the chats port steps aside and the upgrade goes on without it (0.3.0, team/BACKLOG.md)
      const chain = await k.chainIn(space, extra).catch((/** @type {any} */ e) => { if (e && e.code === "not_found" && space !== k.space) throw fail("not_hosted", "this server cannot carry chats to a Space on another server yet; they stay in this Space"); throw e; });
      // every Space, this one included, through its own gateway: its records, its Drive, its definitions and its moves
      const gw = (await k.for(space)).gateway;
      // the chats and members of that Space too, for a chat that moves with its project (core/work/chat-carry.js): the target's own, under the mover's own chain there
      return { space, gw, records: gw.records, drive: gw.drive, chain, types: async (/** @type {any} */ c) => (gw.definitions ? gw.definitions(c) : []), ...(gw.grants && gw.grants.chats ? { chats: gw.grants.chats } : {}), ...(gw.members ? { members: gw.members } : {}) };
    };
    // The sealed carry of a chat's files from one Space to the other (pool to pool inside the sealing processes), when the source's gateway has it: `moves.carryFiles(fromChain, toChain, { entries, move_id })`.
    // The record types a target lacks are installed from the source's own definitions, under the same approval (a plan that needs them says so in its hash).
    const withCarry = (/** @type {any} */ from, /** @type {any} */ to) => {
      // the kernel gives the work module `moves.carryFiles` on its own handle (network-2, kernel/moves/carry.js: bytes go pool to pool inside the kernel, never to a module)
      const mv = kernelOf().moves || (from.gw && from.gw.moves);
      if (mv && typeof mv.carryFiles === "function") from.carry = (/** @type {any[]} */ entries, /** @type {any} */ o) => mv.carryFiles(from.chain, to.chain, { entries, move_id: o.move_id, ...(o.upgrade_id ? { upgrade_id: o.upgrade_id } : {}) });
      if (to.gw && to.gw.records && typeof to.gw.records.define === "function") to.install = async (/** @type {any} */ c, /** @type {string[]} */ names) => {
        const defs = (await from.types(from.chain)).filter((/** @type {any} */ t) => names.includes(t.name));
        if (defs.length !== names.length) throw Object.assign(new Error("a record type of this project is not defined here, so it cannot be installed in the other Space"), { code: "blocked" });
        await to.gw.records.define(c, { add_types: defs });
      };
      return from;
    };
    ctx.tool("work.project.move-plan", {
      description: "Preview moving a Project to another Space: counts of records, files and sealed fields, blockers, and the plan hash to approve. Reads only.",
      input: obj({ project: { type: "string" }, to_space: { type: "string" }, client: { type: "string" } }, ["project", "to_space"]),
      run: async (input, extra) => {
        const k = kernelOf();
        const to0 = await sideOf(String(input.to_space), extra);
        const plan = await planMove({ from: withCarry(await sideOf(k.space, extra), to0), to: to0, project: String(input.project), client: input.client === "move" ? "move" : "leave" });
        return { plan_hash: plan.hash, counts: plan.counts, blockers: plan.blockers, from: plan.from, to: plan.to };
      },
    });
    ctx.tool("work.project.move", {
      description: "Move a Project to another Space: the target makes a NEW project (new id, new Drive folder) and the linked records and files are copied across as you, verified, and the old Space keeps a 'moved to' marker. Needs an owner or admin in both Spaces and one phone yes for the plan you were shown (plan_hash).",
      input: obj({ project: { type: "string" }, to_space: { type: "string" }, client: { type: "string" }, plan_hash: { type: "string" } }, ["project", "to_space", "plan_hash"]),
      run: async (input, extra) => {
        const k = kernelOf();
        const to = await sideOf(String(input.to_space), extra), from = withCarry(await sideOf(k.space, extra), to);
        if (!from.gw.moves || typeof from.gw.moves.out !== "function" || !to.gw.moves || typeof to.gw.moves.in !== "function") throw Object.assign(new Error("moving a project to another Space is not built into this kernel yet, so nothing was moved; update the kernel on both sides, then try again"), { code: "unavailable" });
        // A move is saved as it goes (the id map, the move id, what is done), so a crash or a retry resumes it: no second target project, no second approval, no record copied twice.
        const db = ctx.store.db;
        db.exec("CREATE TABLE IF NOT EXISTS work_moves (key TEXT PRIMARY KEY, state TEXT NOT NULL, at INTEGER NOT NULL)");
        const key = `${from.space}|${to.space}|${String(input.project)}`;
        const row = /** @type {any} */ (db.prepare("SELECT state FROM work_moves WHERE key = ?").get(key));
        /** @type {any} */ const state = row ? JSON.parse(String(row.state)) : {};
        const save = (/** @type {any} */ st) => { db.prepare("INSERT INTO work_moves (key, state, at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET state = excluded.state, at = excluded.at").run(key, JSON.stringify(st), Date.now()); };
        // a resumed move that already emptied part of the source continues under the plan it was approved with; anything else is planned afresh and must be what the person saw
        const plan = state.plan && state.plan.hash === input.plan_hash ? state.plan : await planMove({ from, to, project: String(input.project), client: input.client === "move" ? "move" : "leave" });
        if (plan.hash !== input.plan_hash) throw Object.assign(new Error("the project is not what you were shown; plan the move again"), { code: "stale_plan" });
        state.plan = plan; save(state);
        // one yes, verified in the source Space's sealing process, bound to this exact plan; the target checks it carries the same one
        if (!state.move_id) { const o = await from.gw.moves.out(from.chain, { to: to.space, project: plan.project, plan_hash: plan.hash }, { presence: extra && extra.kernel_proof }); state.move_id = o.move_id; save(state); }
        const out = { move_id: String(state.move_id) };
        if (!state.move_in) { await to.gw.moves.in(to.chain, { from: from.space, project: plan.project, plan_hash: plan.hash, move_id: out.move_id }); state.move_in = true; save(state); }
        // The memory room moves with it: each Space has its own memory instance, reached through that Space's handle under the mover's chain there (the target proves the source with the signed evidence).
        // A kernel that cannot reach a Space's memory this way has no `memory` port, and the move says so instead of leaving the room behind unseen.
        const mem = (/** @type {any} */ side, /** @type {string} */ tool) => {
          const h = side.space === k.space ? null : (k.for ? k.for(side.space) : null);
          if (side.space !== k.space && !(h && typeof h.call === "function")) return null;
          return async (/** @type {any} */ i) => {
            const input = { move_id: out.move_id, plan_hash: plan.hash, project: plan.project, ...i };
            const r = h ? await h.call(tool, input, side.chain) : await ctx.call(tool, input);
            if (r && r.error) throw Object.assign(new Error(String(r.error.message || r.error.code || "the memory move failed")), { code: String(r.error.code || "failed") });
            return r && r.data !== undefined ? r.data : r;
          };
        };
        const room = { offer: mem(to, "memory.room.offer"), export: mem(from, "memory.room.export"), import: mem(to, "memory.room.import"), forget: mem(from, "memory.room.forget") };
        const memory = Object.values(room).every(Boolean) ? room : undefined;
        // the Work engine's own lines: this module's tools, in each Space (the own Space through ctx.call, the other through its handle)
        const kn = { export: mem(from, "work.know.move-export"), import: mem(to, "work.know.move-import"), forget: mem(from, "work.know.move-forget") };
        const know = Object.values(kn).every(Boolean) ? kn : undefined;
        const done = await runMove({ from, to, plan, ports: { state, save, move_id: out.move_id, ...(memory ? { memory } : {}), ...(know ? { know } : {}), ...(from.gw.moves.reseal ? { reseal: (/** @type {any} */ ref, /** @type {string} */ urn, /** @type {string} */ field) => from.gw.moves.reseal(from.chain, to.chain, { ref, to: urn, field, move_id: out.move_id }) } : {}) } });
        if (!done.left_behind.length) db.prepare("DELETE FROM work_moves WHERE key = ?").run(key);
        return { project: done.target, moved: done.moved, left_behind: done.left_behind.length, memory: memory ? "moved" : "not moved: this kernel cannot reach the other Space's memory yet" };
      },
    });
    // The SOURCE side of a move to a Space on another server (windows' remote form, team/0.3/DESIGN-project-move.md, "As built"): the spaces module serves the target home's pull from here, under the
    // person's own chain in this Space, so a field hidden from them is never sent. Ops: plan (the plan the person approved, recomputed here: its hash must be the approved one), record, file, sealed.
    // Each is refused unless this Space's log holds the move's own `project.move_started` for this move id, plan hash and project, by that person.
    ctx.tool("work.move.serve", {
      description: "Serve a move to another server from this Space: { space, person, op: plan | record | file | sealed, move_id, plan_hash, project, to_space, ... }. The spaces module's own; reads under the person's chain here.",
      callers: ["module"],
      input: obj({ space: { type: "string" }, person: { type: "string" }, op: { type: "string" }, move_id: { type: "string" }, plan_hash: { type: "string" }, project: { type: "string" }, to_space: { type: "string" }, client: { type: "string" }, urn: { type: "string" }, path: { type: "string" }, offset: { type: "number" }, length: { type: "number" }, ref: { type: "string" } }, ["space", "person", "op", "move_id", "plan_hash", "project"]),
      run: async (i, extra) => {
        const k = kernelOf();
        if (String((extra && extra.caller) || "") !== "module:spaces") throw fail("denied", "work.move.serve is the spaces module's");
        if (String(i.space) !== k.space) throw fail("bad_input", "this is not the Space the move starts from");
        const chain = k.chainForPerson(String(i.person));
        // the move's own event, by this person, for exactly this plan and project
        const evs = await k.events.read(chain, { type: "project.move_started" });
        const ev = evs.find((/** @type {any} */ e) => e && e.data && e.data.move_id === i.move_id);
        if (!ev || ev.data.plan_hash !== i.plan_hash || ev.subject !== i.project || !String(ev.actor).startsWith(`person:${i.person}@`)) throw fail("not_found", "no such move");
        const side = { space: k.space, records: k.records, drive: k.drive, chain, types: async () => [] };
        const closure = async () => new Set(await linkedClosure(side, String(i.project)));
        if (i.op === "plan") {
          const plan = await planMove({ from: side, to: { space: String(i.to_space), remote: true }, project: String(i.project), client: i.client === "move" ? "move" : "leave" });
          if (plan.hash !== i.plan_hash) throw fail("stale_plan", "the project is not what was approved");
          if (plan.blockers.length) throw fail("blocked", plan.blockers.join("; "));
          return { hash: plan.hash, ids: plan.ids, counts: plan.counts, sealed: plan.sealed, files: plan.files.map((/** @type {string} */ p) => ({ path: p, size: plan.sizes[p] || 0, sha256: plan.hashes[p] || null })) };
        }
        if (i.op === "record") {
          if (!(await closure()).has(String(i.urn))) throw fail("denied", "that record is not part of this project");
          const [, , , type, id] = String(i.urn).split("/");
          const r = await k.records.get(chain, type, id);
          return r ? { urn: r.urn, version: r.version, data: r.data } : null;
        }
        if (i.op === "file") {
          const root = await k.records.get(chain, "project", String(i.project).split("/").pop());
          const folder = root && root.data.drive_path;
          const p = String(i.path || "");
          if (!folder || !p.startsWith(`${folder}/`) || p.split("/").some((/** @type {string} */ x) => x === ".." || x === ".")) throw fail("denied", "that file is not in this project's folder");
          const got = await k.drive.get(chain, p);
          const bytes = got instanceof Uint8Array ? got : (got.bytes || got.data);
          const off = Math.max(0, Number(i.offset) || 0), len = Math.min(1 << 20, Math.max(0, Number(i.length) || (1 << 20)));
          return { base64: Buffer.from(bytes.subarray(off, off + len)).toString("base64"), size: bytes.length };
        }
        if (i.op === "sealed") throw fail("unavailable", "a sealed value crosses servers through the sealing process, which this build does not offer yet; nothing was sent");
        throw fail("bad_input", "op is plan, record, file or sealed");
      },
    });
    // The Work engine's session lines move with the project (core/work/memory/move.js). Each call refuses unless THIS Space's log holds the kernel's event for the move, the way the memory room's
    // do: `project.move_started` in the source, `project.move_in` in the target, for this move id, plan hash and project. The mover's own chain reads the log.
    const knowProof = async (/** @type {any} */ extra, /** @type {"project.move_started"|"project.move_in"} */ type, /** @type {any} */ i) => {
      kernelOf();
      // run by the move (this module's own tool, through ctx.call or the Space handle), never by a person's surface or another module: the authority is the move's own event in this Space's log
      if (String((extra && extra.caller) || "") !== "module:work") throw fail("denied", "the Work engine's lines move only inside a project move");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(i.move_id)) || !/^[A-Za-z0-9_-]{43}$/.test(String(i.plan_hash)) || !urnOk(i.project)) throw fail("bad_input", "a move names its move id, plan hash and project");
      // Inside a hosted Space this module runs with THAT Space's own kernel handle (windows' per-Space stores), so `kernelOf()` already reads the running Space's log; a call that crossed into it
      // carries the caller's chain there (`in_space_chain`, set only by the registry), which is the one that may read it.
      const chain = extra && extra.in_space_chain ? extra.in_space_chain : kernelOf().serviceChain("work");
      const evs = await kernelOf().events.read(chain, { type });
      const ev = evs.find((/** @type {any} */ e) => e && e.data && e.data.move_id === i.move_id);
      if (!ev || ev.data.plan_hash !== i.plan_hash || (type === "project.move_started" ? ev.subject !== i.project : ev.data.project !== i.project)) throw fail("not_found", "no such move");
    };
    const knowMove = obj({ move_id: { type: "string" }, plan_hash: { type: "string" }, project: { type: "string", description: "the project's record urn in the Space the move starts from" } }, ["move_id", "plan_hash", "project"]);
    ctx.tool("work.know.move-export", {
      description: "Source side of a project's Work-engine lines move: the lines of the project's records, read for the move. Refused unless this Space's log holds project.move_started for it. Returns { rows, digest, count }.",
      callers: ["module"],
      input: { ...knowMove, properties: { ...knowMove.properties, records: { type: "array", items: { type: "string" } } } },
      run: async (i, extra) => {
        engineOf(); await knowProof(extra, "project.move_started", i);
        const k = kernelOf();
        const allowed = new Set(await linkedClosure({ records: k.records, chain: k.serviceChain("work") }, String(i.project)));
        const records = (Array.isArray(i.records) ? i.records : [i.project]).map(String);
        if (records.some((/** @type {string} */ r) => !allowed.has(r))) throw fail("denied", "that record is not part of this project");
        return exportKnow(ctx.store.db, { records });
      },
    });
    ctx.tool("work.know.move-import", {
      description: "Target side: writes the exported lines under the target project's records (one transaction, a repeat is a no-op) and indexes them. Refused unless this Space's log holds project.move_in for the move. Returns the receipt { digest, count }.",
      callers: ["module"],
      input: { ...knowMove, properties: { ...knowMove.properties, rows: { type: "array", items: { type: "object" } }, map: { type: "object" }, from_space: { type: "string" } } },
      run: async (i, extra) => {
        engineOf(); await knowProof(extra, "project.move_in", i);
        const k = kernelOf();
        const r = importKnow(ctx.store.db, Array.isArray(i.rows) ? i.rows : [], { map: i.map && typeof i.map === "object" ? i.map : {}, from: String(i.from_space || ""), to: k.space });
        for (const s of r.sessions) { try { await engineOf().index({ kind: "lines", session: s }); } catch { /* indexed by the next sweep */ } }
        return { digest: r.digest, count: r.count };
      },
    });
    ctx.tool("work.know.move-forget", {
      description: "Source side, after the target imported: needs the receipt; refuses if the lines changed since the export; drops them and what was derived from them. Returns { forgotten }.",
      callers: ["module"],
      input: { ...knowMove, properties: { ...knowMove.properties, records: { type: "array", items: { type: "string" } }, receipt: { type: "object" } } },
      run: async (i, extra) => {
        engineOf(); await knowProof(extra, "project.move_started", i);
        const k = kernelOf();
        const allowed = new Set(await linkedClosure({ records: k.records, chain: k.serviceChain("work") }, String(i.project)));
        const records = (Array.isArray(i.records) ? i.records : [i.project]).map(String);
        if (records.some((/** @type {string} */ r) => !allowed.has(r))) throw fail("denied", "that record is not part of this project");
        return forgetKnow(ctx.store.db, { records, receipt: i.receipt });
      },
    });
    // The Project record for a short name, made if this Space has none yet: what the projects module asks before it grants an agent reach (a grant names the record).
    ctx.tool("work.project.ensure", {
      description: "The Project record for a short name (made if there is none): { urn, slug, name }. For the projects module's own use.",
      input: obj({ slug: { type: "string" }, name: { type: "string" } }, ["slug"]),
      callers: ["module"],
      run: async (input, extra) => {
        kernelOf();
        if (String((extra && extra.caller) || "") !== "module:projects") throw Object.assign(new Error("only the projects module ensures a project this way; work.project.create makes one"), { code: "denied" });
        const rec = await hubOf().ensureProject(String(input.slug), typeof input.name === "string" ? input.name : undefined);
        if (!rec) throw Object.assign(new Error("no such project (projects.list shows them)"), { code: "not_found" });
        return { urn: rec.urn, slug: rec.data.slug, name: rec.data.name };
      },
    });
    ctx.tool("work.team.member", {
      description: "Put a teammate (core/team) on a Project's team as a team-member record, or take it off. For the teammates module's own use.",
      input: obj({ action: { type: "string", enum: ["add", "remove"] }, project: { type: "string" }, agent: { type: "string" }, role: { type: "string" }, instructions: { type: "string" } }, ["action", "project", "agent"]),
      callers: ["module"],
      run: async (input, extra) => {
        kernelOf();
        if (String((extra && extra.caller) || "") !== "module:team") throw Object.assign(new Error("only the teammates module changes a project's members this way; work.team.add adds a teammate"), { code: "denied" });
        const made = await hubOf().teamMember({ action: input.action === "remove" ? "remove" : "add", project: String(input.project), agent: String(input.agent),
          ...(typeof input.role === "string" ? { role: input.role } : {}), ...(typeof input.instructions === "string" ? { instructions: input.instructions } : {}) });
        if (!made) throw Object.assign(new Error("no such project (projects.list shows them)"), { code: "not_found" });
        return made;
      },
    });
    ctx.tool("work.project.ref", {
      description: "The Project a reference names (its record id, its address or its short name): { id, urn, slug, name }. Nothing is made, and a Project the caller may not read is not found. A part that holds only a short name asks this for the id before it keys anything by it.",
      input: obj({ project: { type: "string" } }, ["project"]),
      // The person's own surfaces and paired devices, and modules: never a model, a hook or an anonymous caller, who would otherwise be told a Project's id and name.
      callers: ["cli", "local", "deck", "capsule", "device", "module"],
      run: async (input, extra) => {
        const k = kernelOf();
        const rec = await hubOf().projectOf(String(input.project || ""));
        // The record again under the caller's own chain: what the caller may not read, it does not learn. A first-party module (the teammates, the harness) and the registry itself (module:vyred, turning a projectArg id into a short name) have no person behind them and is
        // answered from the service's own read; an added module is not answered.
        const viaModule = String((extra && extra.caller) || "").startsWith("module:");
        const mine = !rec ? null : viaModule ? ((extra && extra.firstParty) || (extra && extra.caller) === "module:vyred" ? rec : null) : await k.records.get(await chainOf(extra), "project", rec.id).catch(() => null);
        if (!rec || !mine) throw Object.assign(new Error("no such project (projects.list shows them)"), { code: "not_found" });
        return { id: rec.id, urn: rec.urn, slug: rec.data.slug, name: rec.data.name };
      },
    });
    ctx.tool("work.project.members", {
      description: "Who is on a Project's team: each assistant or person with the role it fills, from the project's team records ({ members: [{ agent, role }] }). Read under the caller's own chain: a Project the caller may not read is not found.",
      input: obj({ project: { type: "string", description: "The Project's record id, address or short name" } }, ["project"]),
      callers: ["cli", "local", "deck", "capsule", "device"],
      run: async (input, extra) => {
        const k = kernelOf(), chain = await chainOf(extra);
        const rec = await hubOf().projectOf(String(input.project || ""));
        const mine = rec ? await k.records.get(chain, "project", rec.id).catch(() => null) : null;
        if (!rec || !mine) throw Object.assign(new Error("no such project (projects.list shows them)"), { code: "not_found" });
        const rows = (await k.records.query(chain, "team-member", { filter: { field: "project", op: "eq", value: { urn: rec.urn } }, page: { limit: 200 } }).catch(() => ({ rows: [] }))).rows || [];
        return { members: rows.map((/** @type {any} */ r) => { const d = r.data || {}; return { agent: String((d.actor && d.actor.actor && d.actor.actor.id) || d.name || ""), role: String(d.role || "") }; }).filter((/** @type {any} */ m) => m.agent) };
      },
    });
    ctx.tool("work.project.rename", {
      description: "Rename a Project, from Records' side: the record, its Drive folder (files and all) and the project list all take the new name; its ids stay.",
      input: obj({ project: { type: "string" }, name: { type: "string" } }, ["project", "name"]),
      run: async (input, extra) => {
        const rec = await hubOf().projectOf(input.project);
        if (!rec) throw Object.assign(new Error("no such project (projects.list shows them)"), { code: "not_found" });
        const r = await hubOf().renameProject(rec, input.name, "record", await chainOf(extra));
        return { project: r.urn, slug: r.data.slug, name: r.data.name, drive_path: r.data.drive_path };
      },
    });
    // A person reads a chat's row through Records (title, who, when, project, where it lives) if they may read the project; the chat itself (its messages, its runs) only if they are in it: the kernel's own
    // chat read decides, never the record's `people`.
    const inChat = (/** @type {any} */ chain, /** @type {string} */ chat) => { try { kernelOf().chats.read(chain, chat); return true; } catch { return false; } };
    // A person acting for themselves: a chain of exactly one person hop (their own device or their own session), never a model's or an agent's session (an agent hop), a viewer or a delegate chain. A
    // cross-Space move or a history import is the person's own act; the spaces module relays the person (core/modules RELAY_ALLOWED) after the person's one approval.
    const mustBeThePerson = (/** @type {any} */ chain, /** @type {string} */ what) => {
      const hops = chain && Array.isArray(chain.hops) ? chain.hops : [];
      if (hops.length !== 1 || !hops[0].actor || hops[0].actor.kind !== "person" || chain.viewer === true) throw Object.assign(new Error(`${what} is the person's own act: an assistant or a model session cannot do it`), { code: "denied" });
    };
    const rowOf = (/** @type {any} */ r) => ({ id: r.id, urn: r.urn, ...r.data });
    ctx.tool("work.chat.list", {
      description: "List chats you may see in this Space (title, project, who, when, status). Chats you are in also show run providers and the last line.",
      input: obj({ project: { type: "string", description: "the project's short name" }, q: { type: "string", description: "a word in the title" }, mine: { type: "boolean", description: "true lists only your own chats" }, limit: { type: "integer" } }),
      run: async (input, extra) => {
        const chain = await chainOf(extra);
        const k = kernelOf();
        const proj = input.project ? await hubOf().projectOf(input.project) : null;
        const res = await k.records.query(chain, "chat-record", { page: { limit: Math.min(Number(input.limit) || 200, 500) } });
        const q = typeof input.q === "string" ? input.q.toLowerCase() : "";
        let rows = (res.rows || []).filter((/** @type {any} */ r) => (!proj || (r.data.project && r.data.project.urn === proj.urn)) && (!q || String(r.data.title || "").toLowerCase().includes(q)));
        // the project's name, read under the caller's own chain; for the chats the caller is in, what the engine knows: the providers of its runs and the last line (never on the record)
        const mine = new Set((await k.chats.mine(chain)).map((/** @type {any} */ m) => m.chat));
        // unread: the messages (people's words and whole replies) others made in a chat after this person's read marker (stream.mark-read), counted from the stream's own tables, read only. 0 when there is none.
        const personId = String((chain.hops && chain.hops[0] && chain.hops[0].actor && chain.hops[0].actor.id) || "");
        const db = ctx.store && ctx.store.db;
        const unreadOf = (/** @type {string} */ who, /** @type {string} */ chat) => {
          if (!db || !who) return 0;
          try {
            const mark = /** @type {any} */ (db.prepare("SELECT upto FROM stream_groups_marks WHERE person = ? AND session = ?").get(`person:${who}`, chat));
            const row = /** @type {any} */ (db.prepare("SELECT COUNT(DISTINCT json_extract(json, '$.data.message')) AS n FROM stream_frames WHERE session = ? AND cur > ? AND json_extract(json, '$.type') IN ('chat.user-message', 'chat.text-done') AND json_extract(json, '$.data.history') IS NULL AND COALESCE(json_extract(json, '$.author'), '') != ?").get(chat, mark ? Number(mark.upto) : 0, `person:${who}`));
            return row ? Number(row.n) || 0 : 0;
          } catch { return 0; }
        };
        const projRows = (await k.records.query(chain, "project", { page: { limit: 500 } })).rows || [];
        const projects = new Map(projRows.map((/** @type {any} */ p) => [p.urn, p.data.name]));
        // Personal is private: a chat filed in somebody else's Personal project is not listed (R031-03)
        const others = new Set(projRows.filter((/** @type {any} */ p) => p.data.personal_of && p.data.personal_of !== personId).map((/** @type {any} */ p) => p.urn));
        rows = rows.filter((/** @type {any} */ r) => !(r.data.project && others.has(r.data.project.urn)));
        rows = await Promise.all(rows.map(async (/** @type {any} */ r) => {
          const base = { ...rowOf(r), project_name: (r.data.project && projects.get(r.data.project.urn)) || null };
          if (!mine.has(r.data.chat)) return base;
          const runs = ((await ctx.call("threads.of-chat", { chat: r.data.chat }).then((/** @type {any} */ x) => (x && x.data) || {}).catch(() => ({}))).runs) || [];
          const line = runs.filter((/** @type {any} */ x) => x.last_line).sort((/** @type {any} */ a, /** @type {any} */ b) => (b.last || 0) - (a.last || 0))[0];
          return { ...base, open: true, unread: unreadOf(personId, r.data.chat), providers: [...new Set(runs.map((/** @type {any} */ x) => x.provider).filter(Boolean))], ...(line ? { last_line: line.last_line } : {}) };
        }));
        if (input.mine) rows = rows.filter((/** @type {any} */ r) => r.open);
        const pins = persistentOf().pinnedOf(personId);
        if (pins.size) rows = rows.map((/** @type {any} */ r) => (pins.has(r.chat) ? { ...r, pinned: pins.get(r.chat) } : r));
        rows.sort((/** @type {any} */ a, /** @type {any} */ b) => String(b.last_active || "").localeCompare(String(a.last_active || "")));
        return { chats: rows };
      },
    });
    ctx.tool("work.chat.get", {
      description: "One chat you are in: its record, its slots (assistants and models running, with thread, provider, model, account, status) and transcript address.",
      input: obj({ chat: { type: "string" } }, ["chat"]),
      run: async (input, extra) => {
        const chain = await chainOf(extra);
        const chat = String(input.chat);
        const c = (() => { try { return kernelOf().chats.read(chain, chat); } catch { return null; } })();
        if (!c) throw Object.assign(new Error("no such chat (work.chat.list shows the chats you may see)"), { code: "not_found" });
        const rec = await hubOf().chatRecord(chat);
        const runs = ((await ctx.call("threads.of-chat", { chat }).then((/** @type {any} */ r) => (r && r.data) || {}).catch(() => ({}))).runs) || [];
        const slots = runs.map((/** @type {any} */ r) => ({ slot: r.slot || (r.agent ? `agent:${r.agent}` : null), thread: r.thread, provider: r.provider, model: r.model, account: r.account, status: r.status, live: r.live }));
        return { chat: rec ? rowOf(rec) : { chat }, open: true, people: [...c.people], agents: [...c.assistants], slots, transcript: `vyre://${kernelOf().space}/chat/${chat}`, ...(c.ring ? { ring: c.ring } : {}) };
      },
    });
    // Personal to My Cloud (windows' upgrade, one approval for the whole move): the person's chats move to their other Space under their own chain in both, ids kept (core/work/chat-upgrade.js).
    // The spaces module calls these on the person's behalf (it relays the person to exactly these two tools).
    const upgradeRows = async (/** @type {any} */ from) => {
      const k = kernelOf();
      const mine = new Set((await k.chats.mine(from.chain)).map((/** @type {any} */ m) => m.chat));
      return ((await from.records.query(from.chain, "chat-record", { page: { limit: 500 } })).rows || []).filter((/** @type {any} */ r) => mine.has(r.data.chat));
    };
    ctx.tool("work.chat.upgrade-plan", {
      description: "Preview moving your chats to your other Space (Personal to My Cloud): chat, file and byte counts, and blockers. Reads only.",
      input: obj({ to: { type: "string", description: "the other Space to move your chats to" } }, ["to"]),
      run: async (input, extra) => {
        const k = kernelOf();
        const here = await sideOf(k.space, extra);
        mustBeThePerson(here.chain, "planning to move your chats to another Space");
        const to = await sideOf(String(input.to), extra);
        mustBeThePerson(to.chain, "planning to move your chats to another Space");
        const from = withCarry(here, to);
        return planUpgrade({ from, rows: await upgradeRows(from) });
      },
    });
    ctx.tool("work.chat.upgrade-move", {
      description: "Move your chats from this Space to your other Space (Personal to My Cloud): each keeps its id, title and people, is filed under General there, and its files go sealed. A chat that cannot move is named in `left` and the others still do.",
      input: obj({ to: { type: "string" }, move_id: { type: "string" }, upgrade_id: { type: "string" } }, ["to"]),
      run: async (input, extra) => {
        const k = kernelOf();
        const here = await sideOf(k.space, extra);
        mustBeThePerson(here.chain, "moving your chats to another Space"); // before anything else is looked at
        const to = await sideOf(String(input.to), extra);
        mustBeThePerson(to.chain, "moving your chats to another Space");
        const from = withCarry(here, to);
        const history = async (/** @type {string} */ chat) => {
          const st = await ctx.call("stream.export-chat", { chat }).then((/** @type {any} */ r) => (r && r.data) || { frames: [], members: [] });
          const th = await ctx.call("threads.export-chat", { chat }).then((/** @type {any} */ r) => (r && r.data) || { runs: [], events: [] });
          return { frames: st.frames, members: st.members, runs: th.runs, events: th.events };
        };
        return runUpgrade({ from, to, rows: await upgradeRows(from), ports: { history, ...(input.move_id ? { move_id: String(input.move_id) } : {}), ...(input.upgrade_id ? { upgrade_id: String(input.upgrade_id) } : {}) } });
      },
    });
    ctx.tool("work.chat.history-import", {
      description: "Put back the history of a chat that came here with the chat upgrade: its frames, its runs (stopped) and their events, read in order from the numbered chunks the move carried in the chat's own folder, each checked against its hash. You must be in the chat. It resumes where it stopped; a chat that already had its own frames here is left as it is.",
      input: obj({ chat: { type: "string" } }, ["chat"]),
      run: async (input, extra) => {
        const chain = await chainOf(extra);
        mustBeThePerson(chain, "putting back a chat's history");
        const chat = String(input.chat);
        if (!inChat(chain, chat)) throw Object.assign(new Error("no such chat (work.chat.list shows the chats you may see)"), { code: "not_found" });
        const rec = await hubOf().chatRecord(chat);
        if (!rec || !rec.data.drive) throw Object.assign(new Error("this chat has no folder here; bring it over with work.chat.upgrade-move first"), { code: "not_found" });
        const folder = `${rec.data.drive}/chat/${chat}`;
        const read = async (/** @type {string} */ path) => { const got = await kernelOf().drive.get(chain, path); return Buffer.from(/** @type {any} */ (got && (got.bytes || got.data || got))); };
        /** @type {any} */ let manifest;
        try { manifest = JSON.parse((await read(manifestPath(folder))).toString("utf8")); } catch { throw Object.assign(new Error("this chat carried no history; leave it, there is nothing to put back"), { code: "not_found" }); }
        if (!manifest || manifest.v !== 1 || manifest.chat !== chat || !Array.isArray(manifest.chunks)) throw Object.assign(new Error("that history is not this chat's"), { code: "bad_input" });
        // which chunks are already back, so a stopped import carries on instead of putting anything twice
        const db = ctx.store && ctx.store.db;
        if (!db) throw Object.assign(new Error("this module has no store here; ask the owner or an admin"), { code: "unavailable" });
        db.exec("CREATE TABLE IF NOT EXISTS work_history_imports (chat TEXT NOT NULL, n INTEGER NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY (chat, n))");
        const done = new Set(/** @type {any[]} */ (db.prepare("SELECT n FROM work_history_imports WHERE chat = ?").all(chat)).map(r => Number(r.n)));
        const total = { frames: 0, members: 0, runs: 0, events: 0, chunks: 0 };
        let first = done.size === 0;
        for (const c of [...manifest.chunks].sort((x, y) => x.n - y.n)) {
          if (done.has(c.n)) continue;
          const bytes = await read(String(c.path));
          if (crypto.createHash("sha256").update(bytes).digest("hex") !== c.sha256) throw Object.assign(new Error(`a chunk of this chat's history did not arrive intact (${c.n}); nothing after it was put back`), { code: "verify_failed" });
          const part = JSON.parse(bytes.toString("utf8"));
          if (part.chat !== chat || part.n !== c.n) throw Object.assign(new Error(`chunk ${c.n} is not this chat's`), { code: "bad_input" });
          const st = await ctx.call("stream.import-chat", { chat, frames: part.frames || [], members: part.members || [], fresh: first }).then((/** @type {any} */ r) => (r && r.data) || {});
          if (st.note) { db.prepare("INSERT OR IGNORE INTO work_history_imports (chat, n, sha256) VALUES (?,?,?)").run(chat, c.n, "skipped"); return { chat, ...total, note: st.note }; }
          const th = await ctx.call("threads.import-chat", { chat, runs: part.runs || [], events: part.events || [] }).then((/** @type {any} */ r) => (r && r.data) || {});
          db.prepare("INSERT OR IGNORE INTO work_history_imports (chat, n, sha256) VALUES (?,?,?)").run(chat, c.n, c.sha256);
          first = false;
          total.frames += st.frames || 0; total.members += st.members || 0; total.runs += th.runs || 0; total.events += th.events || 0; total.chunks++;
        }
        return { chat, ...total };
      },
    });
    // Exact recall (the user's ruling, 5 Oct 2026: 0.2.9): a span of a chat, word for word, addressed by chat and line range. The ONE gate is the chat: the kernel's chats.read on the asker's own chain (a person in
    // it, or an assistant the chat lists), so a non-member is told "no such chat" exactly as for a chat that does not exist. The words come from the lines the Space's memory already keeps for each run
    // (core/work/memory/lines.js: scrubbed on the way in, so a sealed value is a placeholder), never a second store. Only the user's and the assistant's words come back; tool output stays out.
    ctx.tool("work.chat.span", {
      description: "Read an exact span of a chat you are in, word for word: lines from..to of each run or one slot, with line addresses.",
      input: obj({ chat: { type: "string" }, slot: { type: "string", description: "one run of the chat, as work.chat.get names it (agent:<id> or model:<provider>/<model>#<n>), or terminal:<first 8 of a terminal session's id>; all runs and terminal sessions when absent" }, from: { type: "integer", minimum: 0, description: "the first line, 0 or more" }, to: { type: "integer", minimum: 0, description: "the last line, inclusive; at most 199 lines after from are read in one call" } }, ["chat", "from"]),
      run: async (input, extra) => {
        const chain = await chainOf(extra);
        const chat = String(input.chat);
        const c = (() => { try { return kernelOf().chats.read(chain, chat); } catch { return null; } })();
        if (!c) throw Object.assign(new Error("no such chat (work.chat.list shows the chats you may see)"), { code: "not_found" });
        const from = Number(input.from);
        if (!Number.isInteger(from) || from < 0) throw fail("bad_input", "from is a line number, 0 or more");
        const to = input.to === undefined ? from + 99 : Number(input.to);
        if (!Number.isInteger(to) || to < from) throw fail("bad_input", "to is the last line, inclusive, and not before from");
        const last = Math.min(to, from + 199);
        const of = await ctx.call("threads.of-chat", { chat }).then((/** @type {any} */ r) => (r && r.data) || {}).catch(() => ({}));
        // A terminal session in the chat (the user's long Claude Code sessions) is a run too: its id is the lines' session id, and its slot is `terminal:<first 8 of the id>`.
        const allRuns = [...(of.runs || []), ...((of.terminals || []).map((/** @type {string} */ id) => ({ thread: id, slot: `terminal:${String(id).slice(0, 8)}`, terminal: true })))];
        const slotOf = (/** @type {any} */ r) => r.slot || (r.agent ? `agent:${r.agent}` : null);
        const runs = input.slot ? allRuns.filter((/** @type {any} */ r) => slotOf(r) === String(input.slot)) : allRuns;
        if (input.slot && !runs.length) throw Object.assign(new Error("no such slot in that chat (work.chat.get lists the slots of a chat)"), { code: "not_found" });
        const e = engineOf();
        /** @type {any[]} */ const out = [];
        let budget = 96 * 1024;
        for (const r of runs) {
          const got = e.lines.exact(String(r.thread), from, last);
          const words = (got || []).filter((/** @type {any} */ l) => l.role === "user" || l.role === "assistant");
          const lines = [];
          for (const l of words) { budget -= Buffer.byteLength(l.text); if (budget < 0) break; lines.push({ seq: l.seq, role: l.role, text: l.text, at: l.at, address: l.address }); }
          const cut = lines.length < words.length;
          out.push({ slot: slotOf(r), thread: r.thread, kept: got !== null, lines, ...(cut ? { more: true, next: words[lines.length].seq } : last < to ? { more: true, next: last + 1 } : {}) });
        }
        return { chat, from, to: last, runs: out, sealed: "placeholders" };
      },
    });
    ctx.tool("work.chat.create", {
      description: "Start a chat: who is in it (people and agents of this Space, by id; you are always in it) and the Project it belongs to (your Personal project when none). Returns the chat's id.",
      input: obj({ title: { type: "string" }, project: { type: "string" }, people: { type: "array", items: { type: "string" } }, agents: { type: "array", items: { type: "string" } }, models: { type: "array", items: { type: "object" } },
        id: { type: "string", description: "the chat's id (chat_<uuid>), chosen by the device that made the ring: the ring is bound to it" }, ring: { type: "object", description: "the chat's key ring, made on the creator's device (createRing in lib/chat-keys.js: wrapped to every device of every participant); with it the chat's folders are stored sealed. Left out, the chat is in the clear." } }),
      run: async (input, extra) => {
        if (Array.isArray(input.models) && input.models.length) throw Object.assign(new Error("a model joins a chat when it is first asked in it; start the chat and ask it there"), { code: "bad_input" });
        const chain = await chainOf(extra);
        // A chat with a person in it is never in the clear on disk. When no device made the ring (a chat started by the CLI, a Flow), the server makes it: a chat key wrapped to each participant device's
        // public agree point, kept only as the session lease. A participant with no agree point stops the start, by name.
        let ring = input.ring, id = input.id ? String(input.id) : undefined, keys = null;
        const k0 = kernelOf();
        const direct = chain && chain.viewer !== true && chain.delegated !== true && chain.hops && chain.hops.length === 1 && chain.hops[0].actor.kind === "person";
        if (!ring && direct && k0.chats && k0.chats.keys && typeof k0.chats.keys.adopt === "function") {
          const me = chain.hops[0].actor.id;
          const people = [...new Set([me, ...(Array.isArray(input.people) ? input.people.map(String) : [])])];
          /** @type {Record<string, any>} */ let holders = {};
          const missing = [];
          for (const p of people) {
            const r = await ctx.call("spaces.identity.devices.read", { person: p }).then((/** @type {any} */ x) => (x && x.data) || x).catch(() => null);
            const devs = r && Array.isArray(r.devices) ? r.devices : [];
            if (!devs.length) missing.push(p); else holders = { ...holders, ...holdersOf(devs) };
          }
          if (missing.length) throw fail("no_agree_point", `this chat cannot start: no key-agreement point for ${missing.join(", ")}. Their device must be updated and opened once.`);
          id = id || `chat_${crypto.randomUUID()}`;
          const made = createRing(id, holders);
          ring = made.doc; keys = made.keys;
        }
        const open = () => k0.chats.create(chain, { people: input.people || [], assistants: input.agents || [], ...(id ? { id } : {}), ...(ring ? { ring } : {}) });
        let made;
        try {
          try { made = await open(); }
          catch (e) {
            // A built-in agent (the Engineer) that no run has made an actor of the Space yet is registered, then the chat starts: a person's first Engineer chat is not refused.
            if (!/belongs to the Space/.test(String(e && /** @type {any} */ (e).message)) || !Array.isArray(input.agents) || !input.agents.length || typeof ctx.agentActor !== "function") throw e;
            // only a built-in agent (agents.list says builtin) is registered this way: a name a caller makes up is not made an actor of the Space
            const known = await ctx.call("agents.list", {}).then((/** @type {any} */ r) => (r && r.data) || []).catch(() => []);
            for (const a of input.agents) {
              if (!known.some((/** @type {any} */ x) => x && x.name === String(a) && x.builtin === true)) throw e;
              await ctx.agentActor(String(a));
            }
            made = await open();
          }
        } catch (e) {
          // The same chat asked for again (a client that retried a call whose answer was lost, or one that waited for the store to come up): the id the caller chose is theirs already, and the answer is the chat as it is.
          const again = input.id && /chat id is new/.test(String(e && /** @type {any} */ (e).message)) ? (() => { try { return k0.chats.read(chain, String(input.id)); } catch { return null; } })() : null;
          if (!again) { if (keys) keys.lock(); throw e; }
          made = { id: String(input.id), people: again.people || [], assistants: again.assistants || [] };
          keys = null;
        }
        if (keys) k0.chats.keys.adopt(chain, keys);
        const rec = await hubOf().ensureChatRecord(made.id, { title: input.title || null, project: input.project || null, people: made.people, agents: made.assistants });
        return { chat: made.id, title: rec && rec.data.title, project: rec && rec.data.project && rec.data.project.urn, people: [...made.people], agents: [...made.assistants] };
      },
    });
    ctx.tool("work.chat.change", {
      description: "Add or remove people and agents in a chat you are in. Only a person in the chat does it, acting directly; an owner or admin outside the chat cannot.",
      input: obj({ chat: { type: "string" }, add_people: { type: "array", items: { type: "string" } }, remove_people: { type: "array", items: { type: "string" } }, add_agents: { type: "array", items: { type: "string" } }, remove_agents: { type: "array", items: { type: "string" } },
        ring: { type: "object", description: "on a chat with a key ring: the ring the change made on a participant's device (addHolders for someone added, removeHolders for someone removed, which rotates the key); required when people are added or removed" } }, ["chat"]),
      run: async (input, extra) => {
        const chain = await chainOf(extra);
        const c = await kernelOf().chats.change(chain, String(input.chat), { add_people: input.add_people, remove_people: input.remove_people, add_assistants: input.add_agents, remove_assistants: input.remove_agents, ...(input.ring ? { ring: input.ring } : {}) });
        return { chat: c.id, people: [...c.people], agents: [...c.assistants] };
      },
    });
    // A chat's key, lent to this server by a participant's own device for the chat's files to open (kernel/gateway/chat-keys.js). The server never makes or keeps a key: the device opens the ring with its own key and
    // answers the request with the keys wrapped to a one-use key, which live in this process's memory and nowhere else.
    const lease = () => { const k = kernelOf(); if (!k.chats || !k.chats.keys) throw Object.assign(new Error("this kernel keeps no sealed chats; update it to one that does"), { code: "unavailable" }); return k.chats.keys; };
    ctx.tool("work.chat.keys.begin", {
      description: "Ask to lend a chat's key: returns { request, session_pub, epoch }. The device opens the chat's ring (work.chat.get names it) with its own key and answers with work.chat.keys.finish.",
      input: obj({ chat: { type: "string" } }, ["chat"]),
      run: async (input, extra) => lease().begin(await chainOf(extra), String(input.chat)),
    });
    ctx.tool("work.chat.keys.finish", {
      description: "Answer a key request: the chat's keys wrapped to the request's session_pub (bundleFor in lib/chat-keys.js). The server holds them in memory only, and the chat's files open for its participants while they are held; a rotation drops them.",
      input: obj({ request: { type: "string" }, bundle: { type: "object" } }, ["request", "bundle"]),
      run: async (input, extra) => lease().finish(await chainOf(extra), String(input.request), input.bundle),
    });
    ctx.tool("work.chat.keys.lock", {
      description: "Wipe a chat's key from this server's memory now.",
      input: obj({ chat: { type: "string" } }, ["chat"]),
      run: async (input, extra) => lease().lock(await chainOf(extra), String(input.chat)),
    });
    ctx.tool("work.chat.keys.status", {
      description: "Whether a chat keeps its folders sealed (it has a key ring), its ring's epoch, and whether its key is lent to this server now.",
      input: obj({ chat: { type: "string" } }, ["chat"]),
      run: async (input, extra) => { const k = kernelOf(); await k.chats.read(await chainOf(extra), String(input.chat)); const epoch = k.chats.epoch ? k.chats.epoch(String(input.chat)) : 0; return { sealed: epoch > 0, epoch, unlocked: epoch > 0 && lease().unlocked(String(input.chat)) }; },
    });
    ctx.tool("work.chat.rename", {
      description: "Rename a chat: the record's title and every run's name agree; its id does not change.",
      input: obj({ chat: { type: "string" }, title: { type: "string" } }, ["chat", "title"]),
      run: async (input, extra) => {
        const chain = await chainOf(extra);
        if (!inChat(chain, String(input.chat))) throw Object.assign(new Error("no such chat (work.chat.list shows the chats you may see)"), { code: "not_found" });
        const rec = await hubOf().chatRecord(String(input.chat));
        if (!rec) throw Object.assign(new Error("no record of that chat (work.chat.list shows the chats you may see)"), { code: "not_found" });
        const r = await hubOf().renameChat(rec, input.title, "record", chain);
        return { chat: r.data.chat, title: r.data.title };
      },
    });
    ctx.tool("work.chat.move", {
      description: "Move to project: file a chat under another Project (a short name or a record address). Its record and Drive folders follow; its id, times and who is in it stay.",
      input: obj({ chat: { type: "string" }, project: { type: "string" } }, ["chat", "project"]),
      run: async (input, extra) => {
        const chain = await chainOf(extra);
        if (!inChat(chain, String(input.chat))) throw Object.assign(new Error("no such chat (work.chat.list shows the chats you may see)"), { code: "not_found" });
        const r = await hubOf().moveChat(String(input.chat), input.project, chain);
        return { chat: r.data.chat, project: r.data.project && r.data.project.urn, drive: r.data.drive, location: r.data.location };
      },
    });
    ctx.tool("work.tools", {
      description: "List the tools this caller may use in this Space: name, what it does and risk. Give tool or schemas for input shapes.",
      input: obj({ tool: { type: "string", description: "one tool's name, to get its input shape" }, schemas: { type: "boolean", description: "true returns every tool's input shape" } }),
      run: async (input, extra) => {
        const all = await surfaceOf().list(await chainOf(extra));
        const one = input && input.tool ? all.filter(t => t.name === String(input.tool)) : null;
        if (one) return { tools: one };
        // A catalog of every shape is most of 30,000 characters; the names and one line each are enough to choose, and the shape of the one chosen is a call away.
        return { tools: input && input.schemas === true ? all : all.map(t => ({ name: t.name, risk: t.risk, description: String(t.description || "").split(/(?<=\.) /)[0].slice(0, 70) })) };
      },
    });
    ctx.tool("work.call", {
      description: "Run one of the listed tools. Returns { result, component }. Outward acts (send, pay, publish, share) are held for a person's approval, never run.",
      input: obj({ tool: { type: "string", description: "a tool name from work.tools" }, input: { type: "object", description: "that tool's input" } }, ["tool"]),
      callers: WORK_CALLERS,
      run: async (input, extra) => {
        const chain = await chainOf(extra);
        const result = await surfaceOf().call(chain, String(input.tool), input.input || {});
        const types = {};
        for (const t of kernelOf().definitions ? await kernelOf().definitions(chain) : []) /** @type {any} */ (types)[t.name] = t;
        const normal = result && result.held ? { held: true, task: result.held.task, summary: result.held.summary, approver: result.held.approver } : result;
        return { result, component: toComponent(String(input.tool), normal, { types }) };
      },
    });
    /** The named assistant a chain acts as (its last hop), or null: project memory is read for an agent. @param {any} chain */
    const agentOf = chain => { const h = chain && chain.hops && chain.hops[chain.hops.length - 1]; return h && h.actor && h.actor.kind === "agent" ? String(h.actor.id) : null; };
    // The Space's own context budget (a Space setting kept with its Flows; an owner or admin sets it through flows.budget { context_tokens }); 1,200 when there is no Flows assembly.
    const spaceContextTokens = async (/** @type {any} */ k, /** @type {any} */ chain) => { try { const h = ctx.flowsHost && ctx.flowsHost.get(k.space); const b = h && await h.flows.tools["flows.budget"](chain, {}); return b && b.context_tokens || 1200; } catch { return 1200; } };
    ctx.tool("work.situation", {
      description: "Where the caller is, briefly: Space, role, project or record in scope, team, open tasks, what waits on them, and what is sealed and why.",
      input: obj({ project: { type: "string" }, record: { type: "string" }, context: { type: "boolean", description: "true adds the record's linked records, recent communications and recent history" }, task: { type: "string", description: "a task id; adds its record's world too" }, context_tokens: { type: "number" } }),
      run: async (input, extra) => {
        const k = kernelOf();
        const ref = (/** @type {any} */ u) => { if (!urnOk(u)) return undefined; const [, , , type, id] = u.split("/"); return { type, id }; };
        let project = ref(input.project), record = ref(input.record);
        const chain = await chainOf(extra);
        let asked = Number.isFinite(input.context_tokens) ? input.context_tokens : undefined;
        // A task names the record it is about: an agent doing it gets that record's world as well
        if (typeof input.task === "string" && input.task && !record) {
          const t = await k.ask.get(chain, input.task).catch(() => null);
          if (t && typeof t.record === "string") record = ref(t.record);
          // a task may ask for more of the record's world (form.context_tokens), within the ceiling
          if (asked === undefined && t && t.form && Number.isFinite(t.form.context_tokens)) asked = t.form.context_tokens;
        }
        const lines = Object.fromEntries([...doing.values()].flatMap(d => [...(d.lines || [])]));
        return buildSituation(k, chain, { space: k.space, ...(project ? { project } : {}), ...(record ? { record } : {}), doing: lines, room: await audienceOf(extra), memory: agentOf(chain) ? async (/** @type {string} */ slug) => { const r = await ctx.call("memory.brief", { project: slug, agent: agentOf(chain) }); const d = r && (r.data !== undefined ? r.data : r); return d && typeof d.text === "string" ? d.text : null; } : null, context: (input.context === true || typeof input.task === "string") ? { budget: Math.max(200, Math.min(8000, Math.trunc(asked ?? await spaceContextTokens(k, chain)))) } : false });
      },
    });

    // What an agent is told about the Space it starts in (core/sessions/environment.js): the Space's id and the record types with their field names, from the kernel's own definitions read as
    // this module's service. Definitions only, never a record or a value. Modules only.
    ctx.tool("work.space-brief", {
      description: "The Space this install is and its record types with their field names, for an agent's environment brief. Definitions only, never a record. Modules only.",
      input: obj(),
      callers: ["module"],
      run: async () => {
        const k = kernelOf();
        const defs = (k.definitions ? await k.definitions(typeof k.serviceChain === "function" ? k.serviceChain("work") : undefined) : []) || [];
        return { space: k.space, types: (Array.isArray(defs) ? defs : []).filter((/** @type {any} */ t) => t && t.name && !String(t.name).startsWith("_")).map((/** @type {any} */ t) => ({ name: String(t.name), ...(t.kind ? { kind: String(t.kind) } : {}), fields: (Array.isArray(t.fields) ? t.fields : []).map((/** @type {any} */ f) => String((f && f.name) || f)).slice(0, 40) })).slice(0, 60) };
      },
    });

    ctx.tool("work.team.context", {
      description: "What a teammate starts with on a project: its role instructions, the project and its linked records without sealed fields, and the Kit's templates.",
      input: obj({ project: { type: "string" }, role: { type: "object" }, templates: { type: "array" } }, ["project"]),
      run: async (input, extra) => {
        const k = kernelOf();
        const r = await teammateContext(k, await chainOf(extra), { project: input.project, space: k.space, ...(input.role ? { role: input.role } : {}), templates: Array.isArray(input.templates) ? input.templates : [] });
        return { text: r.text, records: r.urns, labels: r.labels, skipped: r.skipped };
      },
    });
    ctx.tool("work.team.add", {
      description: "Add an assistant teammate to a project from a Kit role. Its grants are narrowings of the adder's and never wider. Without { approved: true } this returns the card to show, and nothing is created.",
      input: obj({ project: { type: "string" }, role: { type: "object" }, approved: { type: "boolean" }, count: { type: "integer" } }, ["project", "role"]),
      run: async (input, extra) => {
        const k = kernelOf(), chain = await chainOf(extra);
        const adder = chain.hops[0].actor;
        if (!urnOk(input.project)) throw fail("bad_input", "the project is a vyre:// address");
        let spec = teammateFromRole(input.role, { project: input.project, space: k.space, ...(k.registry ? { registry: k.registry() } : {}) });
        if (!input.approved) return { card: addCardData(spec) };
        spec = markReviewed(spec, adder.id);
        const ok = checkAdd({ spec, adder, count: Number(input.count) || 0, humanApproved: adder.kind === "person" });
        if (!ok.ok) throw fail(ok.reason === "cap" ? "cap" : "needs_human", String(ok.detail));
        const teammate = { kind: /** @type {const} */ ("agent"), id: `${spec.name}.${input.project.split("/").pop()}`, space: k.space };
        const made = await delegateGrants(k, chain, { adder, teammate, wanted: spec.wanted, presence: typeof k.proofFrom === "function" ? (/** @type {any} */ _i) => k.proofFrom(extra).presence : null });
        return { teammate, grants: made.grants.map((/** @type {any} */ g) => g.id), obligations: made.obligations };
      },
    });
    ctx.tool("work.team.doing", {
      description: "What each teammate on a project is doing right now, one plain line each, from the project's own events. Updates at most once a minute.",
      input: obj({ project: { type: "string" } }, ["project"]),
      run: async (input, extra) => {
        const k = kernelOf();
        if (!urnOk(input.project)) throw fail("bad_input", "the project is a vyre:// address");
        let d = doing.get(input.project);
        if (!d) {
          const lines = new Map();
          const line = createDoingLine(k, { project: input.project, onLine: (t, l) => { if (l) lines.set(t, l); else lines.delete(t); } });
          d = { line, lines, off: line.attach(await chainOf(extra)) };
          doing.set(input.project, d);
        }
        d.line.tick();
        return { lines: Object.fromEntries(d.lines) };
      },
    });

    ctx.tool("work.know.search", {
      description: "Search the Space's records, events and session lines by meaning. Only sources the caller may read come back, each with its address.",
      input: obj({ query: { type: "string" }, k: { type: "integer" } }, ["query"]),
      run: async (input, extra) => { const hits = await engineOf().search(await chainOf(extra), String(input.query), Math.min(Number(input.k) || 6, 12), { room: await audienceOf(extra) }); return { hits, withheld: /** @type {any} */ (hits).withheld || 0 }; },
    });
    ctx.tool("work.know.answer", {
      description: "Answer a question from the Space's own records and history. Each claim cites a readable source; with none to cite, it says so.",
      input: obj({ question: { type: "string" } }, ["question"]),
      callers: WORK_CALLERS,
      run: async (input, extra) => {
        const chain = await chainOf(extra);
        const result = await engineOf().answer(chain, String(input.question), { room: await audienceOf(extra) });
        return { result, component: toComponent("work.know.answer", result) };
      },
    });
    ctx.tool("work.know.suggestions", {
      description: "Facts memory proposes for a record, each with the lines they came from. Nothing is written until a person accepts one.",
      input: obj({ record: { type: "string" } }, ["record"]),
      run: async (input, extra) => ({ suggestions: await engineOf().facts.suggestions(await chainOf(extra), String(input.record)) }),
    });
    ctx.tool("work.know.accept", {
      description: "Accept a proposed fact: it is written onto the record under the person's own chain, with its sources.",
      input: obj({ id: { type: "integer" } }, ["id"]),
      run: async (input, extra) => engineOf().facts.accept(await chainOf(extra), Number(input.id)),
    });

    // The capture port (CUTOVER section G): sessions captures a session's turns ONCE and hands the same lines to Recall and here, so Space memory knows what was said. A first-party
    // module calls it; a person or an agent cannot (it would let them write lines under another session's address). The lines are scrubbed on the way in by the engine.
    ctx.tool("work.know.capture", {
      description: "Keep a session's lines so the Space's memory can answer from what was said. Called by the session capture, once per indexed batch: { session, lines: [{ seq, role, text, at }] }. Lines are scrubbed on the way in and readable only by a chain that may read the session. Returns how many were kept and indexed.",
      input: obj({ session: { type: "string", maxLength: 128 }, lines: { type: "array", items: { type: "object" } }, record: { type: "string" }, project: { type: "string", maxLength: 80 } }, ["session", "lines"]),
      run: async (input, extra) => {
        // KW-4: only first-party code writes lines under a session's address (the registry's flag, never the input's).
        const e = engineOf();
        if (!extra || extra.firstParty !== true) throw fail("denied", "only first-party modules hand over a session's lines");
        if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(String(input.session))) throw fail("bad_input", "a session id is letters, digits and . _ : -");
        const lines = (Array.isArray(input.lines) ? input.lines : []).slice(0, 2000).filter((/** @type {any} */ l) => l && Number.isInteger(l.seq) && typeof l.text === "string" && ["user", "assistant", "tool"].includes(String(l.role))).map((/** @type {any} */ l) => ({ seq: l.seq, role: String(l.role), text: l.text.slice(0, 20_000), at: Number(l.at) || 0 }));
        // The record a reader must be allowed to read: the one named, else the project's own record when the caller names a project (a project-wide teammate grant then covers its sessions),
        // else the session's own address.
        const projectRecord = typeof input.project === "string" && /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(input.project) ? `vyre://${kernelOf().space}/project/${input.project}` : null;
        const record = input.record && urnOk(input.record) ? input.record : projectRecord;
        const kept = e.lines.ingest(String(input.session), lines, record ? { record } : {});
        const indexed = await e.index({ kind: "lines", session: String(input.session) });
        return { kept, indexed };
      },
    });
    ctx.tool("work.know.forget", {
      description: "Erase a session's lines and every index row made from them (the session was deleted or the person asked). Called by the session capture.",
      input: obj({ session: { type: "string", maxLength: 128 } }, ["session"]),
      run: async (input, extra) => {
        const e = engineOf();
        if (!extra || extra.firstParty !== true) throw fail("denied", "only first-party modules erase a session's lines");
        return { erased: e.forgetSession(String(input.session)) };
      },
    });

    return { async stop() { for (const d of doing.values()) { try { d.off && d.off(); } catch {} } doing.clear(); } };
  },
};
