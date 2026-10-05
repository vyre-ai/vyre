// @ts-check
// work: the 0.3 work layer as module tools (DESIGN-native-assistant, DESIGN-tasks). Three things, one module, all over the kernel contracts:
//  - native.*   the tool surface generated from the Space's definitions and the action registry (kernel/tools), the situation and the component for a result
//  - teammates.* what a teammate starts with, adding one under the adder's ceiling, the doing-now line
//  - recall.*   the three-layer memory: lines, meaning search, answers with citations, fact proposals
// The module holds no authority. `ctx.kernel` (platform's) hands over the assembled Kernel and `ctx.kernel.chainFor(extra)`, which builds the chain from
// the call's own facts; a tool never builds or accepts a chain from its input. Until platform wires ctx.kernel every tool answers `unavailable`.

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

const obj = (properties = {}, required = []) => ({ type: "object", properties, required });
const unavailable = () => Object.assign(new Error("the kernel is not wired on this box yet"), { code: "unavailable" });
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
    const engineOf = () => {
      if (engine) return engine;
      const k = kernelOf();
      if (!k.serviceChain || !k.chainForPerson || !ctx.store || !ctx.store.db) throw unavailable();
      return (engine = createMemoryEngine({ kernel: k, db: ctx.store.db, space: k.space, serviceChain: k.serviceChain("memory"), chainFor: k.chainForPerson, ...(k.embed ? { embed: k.embed } : {}), ...(k.fieldDef ? { fieldDef: k.fieldDef, ownerOf: k.ownerOf } : {}) }));
    };

    // The Project hub: a Project is one record; each session is a summary record linked to it (core/work/hub.js, team/0.3/DESIGN-project-hub.md).
    /** @type {any} */ let hub = null;
    const hubOf = () => hub || (hub = createHub({ kernel: kernelOf(), call: async (tool, input) => { try { return await ctx.call(tool, input); } catch { return null; } }, ...(ctx.config && ctx.config.machine_name ? { machine: String(ctx.config.machine_name) } : {}), log: ctx.log }));
    if (ctx.kernel && ctx.events && typeof ctx.events.on === "function") {
      const hear = (/** @type {string} */ type, /** @type {(p: any, e: any) => any} */ f) => ctx.events.on(type, (/** @type {any} */ e) => { void Promise.resolve(f(e && e.payload, e)).catch(() => {}); });
      hear("thread.started", p => hubOf().onStarted(p));
      hear("thread.stopped", p => hubOf().onStopped(p));
      // a name changed in the old project list or on a thread reaches Records; a name changed in Records reaches them (core/work/hub.js)
      hear("project.changed", p => hubOf().onProjectChanged(p));
      hear("thread.renamed", p => hubOf().onThreadRenamed(p));
      // a /rename inside Claude Code reaches the transcript, which Recall indexes: checked at each turn's end
      hear("turn.completed", p => hubOf().onTurn(p));
      const k0 = ctx.kernel;
      if (k0.events && typeof k0.events.subscribe === "function" && typeof k0.serviceChain === "function") {
        try { k0.events.subscribe(k0.serviceChain("work"), "work-hub", {}, async (/** @type {any} */ e) => { if (e && (e.type === "project.updated" || e.type === "session-summary.updated")) await hubOf().onRecordChanged(e); }); } catch { /* no event feed in this build: the other directions still work */ }
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
          const general = await hubOf().generalProject();
          await k.ask.request(k.serviceChain("work"), {
            title: "Restore who could see your projects", record: general.urn,
            doer: { kind: "person", id: String(k.owner), space: k.space }, output: { kind: "decision" }, source: "manual",
            note: `Before this update ${n} project access row${n === 1 ? "" : "s"} said which of your agents could reach which project${per ? `: ${per}` : ""}. They are kept, and nothing reaches a project until you restore them: run projects.access.restore, which turns each into the grant it was, in your own call. What you had revoked stays revoked.`,
          });
          dbh.prepare("INSERT INTO work_flags (key, at) VALUES ('access-restore', ?)").run(Date.now());
        } catch (e) { ctx.log(`work: the access-restore item was not raised: ${/** @type {Error} */ (e).message} ${String(/** @type {Error} */ (e).stack).split("\n").slice(1, 4).join(" | ")}`); /* a start never fails for this: the rows wait, and projects.access.pending says so */ }
      };
      const t = setTimeout(() => { void raiseRestore(); }, 1500); if (typeof t.unref === "function") t.unref();
      // every Space has a General project, made with it
      void hubOf().generalProject().catch(() => {});
    }
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
      const chain = await k.chainIn(space, extra);
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
      description: "What moving a Project to another Space would carry: counts of records, files and sealed fields, anything that blocks it, and the hash the person approves. Reads only; the mover must be an owner or admin in both Spaces.",
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
        if (!from.gw.moves || typeof from.gw.moves.out !== "function" || !to.gw.moves || typeof to.gw.moves.in !== "function") throw Object.assign(new Error("moving a project to another Space is not built into this kernel yet, so nothing was moved"), { code: "unavailable" });
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
        if (String((extra && extra.caller) || "") !== "module:projects") throw Object.assign(new Error("work.project.ensure is the projects module's"), { code: "denied" });
        const rec = await hubOf().ensureProject(String(input.slug), typeof input.name === "string" ? input.name : undefined);
        if (!rec) throw Object.assign(new Error("no such project"), { code: "not_found" });
        return { urn: rec.urn, slug: rec.data.slug, name: rec.data.name };
      },
    });
    ctx.tool("work.project.rename", {
      description: "Rename a Project, from Records' side: the record, its Drive folder (files and all) and the project list all take the new name; its ids stay.",
      input: obj({ project: { type: "string" }, name: { type: "string" } }, ["project", "name"]),
      run: async (input, extra) => {
        const rec = await hubOf().projectOf(input.project);
        if (!rec) throw Object.assign(new Error("no such project"), { code: "not_found" });
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
      description: "The chats you may see in this Space: title, project (and its name), who, when, status and where it lives. `open: true` on the ones you are in, which also carry the providers of their runs and the last line; the others show only that the chat exists. Filter by project (short name) or a word in the title; mine: true lists only your own.",
      input: obj({ project: { type: "string" }, q: { type: "string" }, mine: { type: "boolean" }, limit: { type: "integer" } }),
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
        const projects = new Map(((await k.records.query(chain, "project", { page: { limit: 500 } })).rows || []).map((/** @type {any} */ p) => [p.urn, p.data.name]));
        rows = await Promise.all(rows.map(async (/** @type {any} */ r) => {
          const base = { ...rowOf(r), project_name: (r.data.project && projects.get(r.data.project.urn)) || null };
          if (!mine.has(r.data.chat)) return base;
          const runs = ((await ctx.call("threads.of-chat", { chat: r.data.chat }).then((/** @type {any} */ x) => (x && x.data) || {}).catch(() => ({}))).runs) || [];
          const line = runs.filter((/** @type {any} */ x) => x.last_line).sort((/** @type {any} */ a, /** @type {any} */ b) => (b.last || 0) - (a.last || 0))[0];
          return { ...base, open: true, unread: unreadOf(personId, r.data.chat), providers: [...new Set(runs.map((/** @type {any} */ x) => x.provider).filter(Boolean))], ...(line ? { last_line: line.last_line } : {}) };
        }));
        if (input.mine) rows = rows.filter((/** @type {any} */ r) => r.open);
        rows.sort((/** @type {any} */ a, /** @type {any} */ b) => String(b.last_active || "").localeCompare(String(a.last_active || "")));
        return { chats: rows };
      },
    });
    ctx.tool("work.chat.get", {
      description: "One chat you are in: its record plus its slots (the assistants and models running in it, with thread, provider, model, account and status) and its transcript address. A chat you are not in does not exist for you.",
      input: obj({ chat: { type: "string" } }, ["chat"]),
      run: async (input, extra) => {
        const chain = await chainOf(extra);
        const chat = String(input.chat);
        const c = (() => { try { return kernelOf().chats.read(chain, chat); } catch { return null; } })();
        if (!c) throw Object.assign(new Error("no such chat"), { code: "not_found" });
        const rec = await hubOf().chatRecord(chat);
        const runs = ((await ctx.call("threads.of-chat", { chat }).then((/** @type {any} */ r) => (r && r.data) || {}).catch(() => ({}))).runs) || [];
        const slots = runs.map((/** @type {any} */ r) => ({ slot: r.slot || (r.agent ? `agent:${r.agent}` : null), thread: r.thread, provider: r.provider, model: r.model, account: r.account, status: r.status, live: r.live }));
        return { chat: rec ? rowOf(rec) : { chat }, open: true, people: [...c.people], agents: [...c.assistants], slots, transcript: `vyre://${kernelOf().space}/chat/${chat}` };
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
      description: "What moving your chats from this Space to your other Space (Personal to My Cloud) would carry: how many chats, files and bytes, and anything that blocks it (a chat that is working). Reads only; the counts are what you approve.",
      input: obj({ to: { type: "string" } }, ["to"]),
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
        if (!inChat(chain, chat)) throw Object.assign(new Error("no such chat"), { code: "not_found" });
        const rec = await hubOf().chatRecord(chat);
        if (!rec || !rec.data.drive) throw Object.assign(new Error("this chat has no folder here"), { code: "not_found" });
        const folder = `${rec.data.drive}/chat/${chat}`;
        const read = async (/** @type {string} */ path) => { const got = await kernelOf().drive.get(chain, path); return Buffer.from(/** @type {any} */ (got && (got.bytes || got.data || got))); };
        /** @type {any} */ let manifest;
        try { manifest = JSON.parse((await read(manifestPath(folder))).toString("utf8")); } catch { throw Object.assign(new Error("this chat carried no history"), { code: "not_found" }); }
        if (!manifest || manifest.v !== 1 || manifest.chat !== chat || !Array.isArray(manifest.chunks)) throw Object.assign(new Error("that history is not this chat's"), { code: "bad_input" });
        // which chunks are already back, so a stopped import carries on instead of putting anything twice
        const db = ctx.store && ctx.store.db;
        if (!db) throw Object.assign(new Error("this module has no store here"), { code: "unavailable" });
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
    ctx.tool("work.chat.create", {
      description: "Start a chat: who is in it (people and agents of this Space, by id; you are always in it) and the Project it belongs to (General when none). Returns the chat's id.",
      input: obj({ title: { type: "string" }, project: { type: "string" }, people: { type: "array", items: { type: "string" } }, agents: { type: "array", items: { type: "string" } }, models: { type: "array", items: { type: "object" } } }),
      run: async (input, extra) => {
        if (Array.isArray(input.models) && input.models.length) throw Object.assign(new Error("a model joins a chat when it is first asked in it; start the chat and ask it there"), { code: "bad_input" });
        const chain = await chainOf(extra);
        const made = await kernelOf().chats.create(chain, { people: input.people || [], assistants: input.agents || [] });
        const rec = await hubOf().ensureChatRecord(made.id, { title: input.title || null, project: input.project || null, people: made.people, agents: made.assistants });
        return { chat: made.id, title: rec && rec.data.title, project: rec && rec.data.project && rec.data.project.urn, people: [...made.people], agents: [...made.assistants] };
      },
    });
    ctx.tool("work.chat.change", {
      description: "Add or remove people and agents in a chat you are in. Only a person in the chat does it, acting directly; an owner or admin outside the chat cannot.",
      input: obj({ chat: { type: "string" }, add_people: { type: "array", items: { type: "string" } }, remove_people: { type: "array", items: { type: "string" } }, add_agents: { type: "array", items: { type: "string" } }, remove_agents: { type: "array", items: { type: "string" } } }, ["chat"]),
      run: async (input, extra) => {
        const chain = await chainOf(extra);
        const c = await kernelOf().chats.change(chain, String(input.chat), { add_people: input.add_people, remove_people: input.remove_people, add_assistants: input.add_agents, remove_assistants: input.remove_agents });
        return { chat: c.id, people: [...c.people], agents: [...c.assistants] };
      },
    });
    ctx.tool("work.chat.rename", {
      description: "Rename a chat: the record's title and every run's name agree; its id does not change.",
      input: obj({ chat: { type: "string" }, title: { type: "string" } }, ["chat", "title"]),
      run: async (input, extra) => {
        const chain = await chainOf(extra);
        if (!inChat(chain, String(input.chat))) throw Object.assign(new Error("no such chat"), { code: "not_found" });
        const rec = await hubOf().chatRecord(String(input.chat));
        if (!rec) throw Object.assign(new Error("no record of that chat"), { code: "not_found" });
        const r = await hubOf().renameChat(rec, input.title, "record", chain);
        return { chat: r.data.chat, title: r.data.title };
      },
    });
    ctx.tool("work.chat.move", {
      description: "Move to project: file a chat under another Project (a short name or a record address). Its record and Drive folders follow; its id, times and who is in it stay.",
      input: obj({ chat: { type: "string" }, project: { type: "string" } }, ["chat", "project"]),
      run: async (input, extra) => {
        const chain = await chainOf(extra);
        if (!inChat(chain, String(input.chat))) throw Object.assign(new Error("no such chat"), { code: "not_found" });
        const r = await hubOf().moveChat(String(input.chat), input.project, chain);
        return { chat: r.data.chat, project: r.data.project && r.data.project.urn, drive: r.data.drive, location: r.data.location };
      },
    });
    ctx.tool("work.tools", {
      description: "The tools this caller may use in this Space, generated from its record definitions and the action registry and cut by what the caller may do. A tool the caller cannot use is not listed.",
      input: obj(),
      run: async (_input, extra) => ({ tools: await surfaceOf().list(await chainOf(extra)) }),
    });
    ctx.tool("work.call", {
      description: "Run one of the listed tools. Returns { result, component }: the component is what to show, a record card, a task card, a draft or a held-for-approval card. An outward act (send, pay, publish, share) is never run: it returns held with a task, and a person approves it.",
      input: obj({ tool: { type: "string" }, input: { type: "object" } }, ["tool"]),
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
      description: "Where the caller is, in a few hundred tokens: the Space, their role, the project or record in scope, the team, open tasks, what waits on them, and what is sealed and why. With `context: true`, or a `task`, also the record's world: the records it links to and that link to it, recent communications with the people on it, and what happened to it lately.",
      input: obj({ project: { type: "string" }, record: { type: "string" }, context: { type: "boolean" }, task: { type: "string" }, context_tokens: { type: "number" } }),
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
      description: "Answer a question from the Space's own records and history. Every claim cites a source the caller may read; with none to cite it says so.",
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
