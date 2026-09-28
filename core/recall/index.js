// @ts-check
// recall — search over every turn of every Claude Code session on this machine.
//
// Full-text search (FTS5) over every user and assistant turn, re-ranked by local embeddings
// once the search model is installed (on first use, or `vyre recall --setup`; see embed.js). The index is built from the transcript files by
// core/transcripts, the only code that reads them, and lives in Recall's tables
// (core/recall/schema.js), which Memory and Projects read directly.
//
// Indexing starts after vyred is up and then runs every `recall.every` minutes (default 5), in
// the background, one pass at a time. It yields between files, so vyred keeps answering while
// a first index of a large corpus is under way. Vectors are filled in after each pass, one turn
// at a time, most recent sessions first; until they exist, search is full-text and says so.
//
// Settings, all optional, under "recall" in config.json:
//   every      minutes between passes (default 5; 0 turns the timer off)
//   vectors    false to never load the model
//   download   false to never fetch the library or the weights (then they must already be in
//              `embedder` and `models`)
//   models     where the weights live (default <VYRE_HOME>/models)
//   embedder   where the library that runs them is installed (default <VYRE_HOME>/embedder)
//   npm        the npm that installs it (default the one next to node, else npm on PATH)
//   duty       the most of the wall clock background indexing may use, per piece of work
//              (default 0.5: as long again asleep as awake); see pace.js
//   lowBattery pause background indexing on battery under this percent (default 30; 0 never)
//   maxChunks  the dense index's hard cap in chunk vectors (default 50,000, ~78MB); past it the
//              oldest sessions drop out of ranking by meaning and fall back to full-text search

import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS } from "./schema.js";
import { Indexer } from "./indexer.js";
import { search, thread, sessions } from "./search.js";
import { evaluate } from "./eval.js";
import { spawnEmbedder, cached, installed, DOWNLOAD_MB } from "./embed.js";
import { pacer, gate } from "./pace.js";
import { Dense } from "./dense.js";
import { Watches } from "./watch.js";
import { blocks, find, peek } from "../transcripts/index.js";
import { transcriptFolders } from "../config/index.js";
import { wantsMacs, askMacs, mergeRows, boxLabel, macLabel } from "../modules/federate.js";

/** @type {import("./embed.js").Embedder | null} */
let injected = null;

/**
 * Use this embedder instead of loading the model. For tests: they must never download weights,
 * and must pass whether or not the optional package is installed.
 * @param {import("./embed.js").Embedder | null} e
 */
export function useEmbedder(e) { injected = e; }

/**
 * The transcript folders to read: the kernel's rule (core/config transcriptFolders). The person's
 * own ~/.claude only for their own ~/.vyre, never under `node --test`, symlinks followed.
 * @param {string[]} folders @param {string} [root] the Vyre home @param {NodeJS.ProcessEnv} [env]
 */
export const readable = (folders, root = "", env = process.env) => transcriptFolders(folders, root, env);

/**
 * A session's row by id or an unambiguous prefix of one, the way recall.thread finds it, or null.
 * @param {import("node:sqlite").DatabaseSync} db @param {string} session
 * @returns {any}
 */
function sessionRow(db, session) {
  let row = db.prepare("SELECT id, file, cwd, name, title FROM recall_sessions WHERE id = ?").get(session);
  if (!row) {
    const like = db.prepare("SELECT id, file, cwd, name, title FROM recall_sessions WHERE substr(id, 1, ?) = ? LIMIT 2").all(session.length, session);
    if (like.length > 1) throw Object.assign(new Error(`more than one session starts with ${session}`), { code: "ambiguous" });
    row = like[0];
  }
  return row || null;
}

export default {
  /** @param {any} ctx */
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const opts = ctx.config.recall || {};
    const every = opts.every ?? 5;
    const configured = readable(ctx.config.transcripts || [], ctx.paths?.root || "");
    // <home>/synced holds one folder per device that sent its sessions (ADR 0008, amendment), each
    // in Claude Code's own layout: read afresh each time, since a device can be added or revoked.
    const syncedRoot = ctx.paths?.root ? path.join(ctx.paths.root, "synced") : null;
    const folders = () => configured.flatMap(f => {
      if (!syncedRoot || path.resolve(f) !== path.resolve(syncedRoot)) return [f];
      try { return fs.readdirSync(f, { withFileTypes: true }).filter(e => e.isDirectory() && /^[A-Za-z0-9._-]{1,80}$/.test(e.name)).map(e => path.join(f, e.name)).sort(); } catch { return []; }
    });
    // Every vector in memory for retrieval by meaning: built once, then appended to as turns are
    // embedded, and rebuilt only when a rewrite deletes turns or the chunk cap is reached.
    const dense = new Dense(db, { maxChunks: opts.maxChunks });
    const indexer = new Indexer(db, {
      emit: (type, payload, where) => ctx.events.emit(type, payload, where),
      log: ctx.log,
      // Each new vector goes straight into the dense index, so a pass never forces a rebuild.
      // A rewrite moves the generation, and the index rebuilds itself on the next search.
      onVector: item => dense.add(item),
    });

    let stopped = false;
    const isStopped = () => stopped;

    // Background work is a trickle (pace.js): paced to `duty` of the clock, and paused on a low
    // battery or a busy machine. Under tests it runs flat out and never pauses unless a test
    // asks, so a loaded CI machine cannot make a test wait a minute.
    const testing = Boolean(process.env.NODE_TEST_CONTEXT);
    const pace = pacer({ duty: opts.duty ?? (testing ? 1 : 0.5) });
    const g = testing && !opts.gate ? null : gate({ lowBattery: opts.lowBattery ?? 30, ...(opts.gate || {}) });
    const paused = () => Boolean(g && g.why);
    const paced = async (/** @type {number} */ spent) => { await pace(spent); if (g) await g.check(); };
    /** Where the index stands, for `vyre status` and `vyre doctor`. */
    const progress = { done: 0, total: 0 };
    /** @type {any} */
    let retry = null;

    // One pass at a time. A caller that asks while one is running gets the next pass, which
    // starts when the current one ends and skips everything that one already did.
    /** @type {Promise<any>} */
    let chain = Promise.resolve();
    let running = false;
    /** @type {any} */
    let lastError = null;
    const pass = () => {
      const p = chain.then(async () => {
        if (stopped) return null;
        running = true;
        try {
          const s = await indexer.run(folders(), { stopped: isStopped, pace: paced, onProgress: (d, t) => { progress.done = d; progress.total = t; } });
          return s;
        }
        finally { running = false; vectorLoop(); }
      });
      chain = p.catch(e => { lastError = e.message; ctx.log(`index pass failed: ${e.message}`); });
      return p;
    };

    // Vectors: lazily loaded, and never fatal.
    const vec = {
      on: opts.vectors !== false,
      why: opts.vectors === false ? "turned off in config.json (recall.vectors)" : "not loaded yet",
      /** @type {import("./embed.js").Embedder | null} */
      embedder: null,
      /** @type {Promise<import("./embed.js").Embedder | null> | null} */
      loading: null,
      busy: false, again: false,
      /** @type {Promise<void>} */
      done: Promise.resolve(),
    };
    const embedder = () => {
      if (!vec.on) return Promise.resolve(null);
      if (vec.embedder) return Promise.resolve(vec.embedder);
      if (!vec.loading) {
        // Under `node --test`, never fetch or load the real model unless a test asks for it by
        // naming a models folder: otherwise every test that starts vyred downloads 23 MB into its
        // temp home, which the home's cleanup then races.
        if (process.env.NODE_TEST_CONTEXT && !injected && !opts.models) {
          vec.on = false; vec.why = "not loaded under tests";
          return Promise.resolve(null);
        }
        const models = opts.models || path.join(ctx.paths.root, "models");
        const runtime = opts.embedder || path.join(ctx.paths.root, "embedder");
        // The only network calls Recall ever makes, once. Said out loud, so a first `vyre status`
        // explains the wait instead of looking stuck.
        const mb = (installed(runtime) ? 0 : DOWNLOAD_MB.runtime) + (cached(models) ? 0 : DOWNLOAD_MB.model);
        vec.why = injected || !mb ? "loading the model" : `downloading the search model (about ${mb} MB, once); search is by keyword until then`;
        if (!injected && mb) ctx.log(vec.why);
        // The model runs in a process of its own at the lowest priority, on one thread.
        vec.loading = (injected ? Promise.resolve({ embedder: injected })
          : spawnEmbedder({ cacheDir: models, runtime, download: opts.download !== false, npm: opts.npm }))
          .then(r => {
            if (r.embedder) { vec.embedder = r.embedder; vec.why = `on (${r.embedder.model})`; return r.embedder; }
            vec.on = false; vec.why = r.why || "unavailable";
            ctx.log(`vectors off: ${vec.why}`);
            return null;
          });
      }
      return vec.loading;
    };
    const vectorLoop = () => {
      if (!vec.on || stopped) return;
      if (vec.busy) { vec.again = true; return; }
      vec.busy = true;
      vec.done = (async () => {
        try {
          do {
            vec.again = false;
            if (!indexer.pending().length) continue;
            if (g && await g.check()) break;
            const e = await embedder();
            if (!e || stopped) break;
            // How far embedding has got, for an import's progress: at most every 2 s, and at the end.
            let said = 0;
            const r = await indexer.vectorize(e, { stopped: () => stopped || paused(), pace: paced,
              onProgress: (done, total) => { const t = Date.now(); if (done < total && t - said < 2000) return; said = t; ctx.events.emit("recall.embedded", { done, total }); } });
            if (r.turns) ctx.log(`embedded ${r.turns} turns into ${r.chunks} vectors in ${r.ms}ms`);
          } while (vec.again && !stopped);
          // Build the dense index now, in the background, so the first search does not pay for it.
          if (!stopped && !dense.stats() && db.prepare("SELECT 1 FROM recall_vectors LIMIT 1").get()) await dense.build();
        } catch (e) { vec.why = `embedding failed: ${/** @type {Error} */ (e).message}`; ctx.log(vec.why); }
        finally {
          vec.busy = false;
          // Paused: look again in a minute, no sooner (SPEC principle 8).
          if (paused() && !stopped) { clearTimeout(retry); retry = setTimeout(vectorLoop, 60_000); retry.unref?.(); }
        }
      })();
    };

    const stringArray = { type: "array", items: { type: "string" } };
    // On the box, "all" takes in the paired Macs' rows too (the default for the person), "local" only the box's.
    const machines = { type: "string", enum: ["all", "local"] };

    // Project scoping (security: recall.search/thread/sessions had none — an agent limited to
    // project A could search or read any other project's sessions). Mirrors core/memory/index.js's
    // reach()/guard() 1:1 by design, so the two modules never drift into two different answers for
    // "what may this agent read." Coordinate any shape change with federation (owns projects.access
    // and agents.projects) rather than diverging here.
    /** A folder is inside one of these granted folders. Recall's own copy: no cross-feature import
     * (module boundary) — this is memory's teach.js `within`, restated. */
    const within = (cwd, granted) => { const c = String(cwd || "").replace(/\/+$/, ""); return granted.some(f => { const base = String(f).replace(/\/+$/, ""); return !!base && (c === base || c.startsWith(base + "/")); }); };
    const denied = message => Object.assign(new Error(message), { code: "denied" });
    /** The user's own surfaces and modules see every session; only a named agent is scoped. */
    const OWNER = new Set(["deck", "cli", "local", "capsule"]);
    const owner = caller => OWNER.has(String(caller)) || String(caller).startsWith("module:");
    /** Projects, as the projects module knows them: slug and its folders. No module without projects: no scoping to do. */
    const projectList = async () => {
      const r = await ctx.call("projects.list", {});
      if (r.error && r.error.code !== "no_such_tool") throw new Error(r.error.message);
      const list = r.error ? [] : (Array.isArray(r.data) ? r.data : r.data?.projects || []);
      return list.filter(p => p && p.slug).map(p => ({ slug: String(p.slug), name: String(p.name || p.slug),
        folders: [...new Set([p.home, ...(p.workspaces || []), ...(p.folders || [])].filter(Boolean).map(String))] }));
    };
    /**
     * What a caller may read: { all: true } for the user's own surfaces, modules, and the
     * assistant; else { all: false, agent, folders } — a named agent's granted projects'
     * folders, intersected with projects.access (deny by default; an install without that
     * module keeps today's behavior unchanged). A wildcard (projects: "*") agent walks the same
     * per-project path as a named-projects agent, starting from every project (2026-09-28
     * decision, as core/memory/index.js's reach() applies it): never the whole corpus by that
     * alone. Who the agent is comes from the caller ("...agent:<name>") or input.agent; if both
     * are given they must agree. When agents cannot be checked, a named agent is refused.
     * @param {string|undefined} agent @param {string|undefined} caller
     */
    const reach = async (agent, caller) => {
      const said = /(?:^|[\s:])agent:([A-Za-z0-9_-]+)/.exec(String(caller || ""))?.[1] || null;
      if (said && agent && said !== agent) throw denied(`the call came from agent ${said} but names agent ${agent}`);
      const who = said || agent || null;
      if (!who) return { all: true, agent: null, folders: [] };
      const r = await ctx.call("agents.list", {});
      if (r.error) throw new Error(`agent ${who}: its projects cannot be checked (${r.error.code === "no_such_tool" ? "agents are not running on this machine" : r.error.message})`);
      const list = Array.isArray(r.data) ? r.data : r.data?.agents || [];
      const a = list.find(x => x && x.name === who);
      if (!a) throw denied(`no agent ${who}`);
      if (a.kind === "assistant") return { all: true, agent: who, folders: [] };
      const wildcard = a.projects === "*";
      const mine = new Set(Array.isArray(a.projects) ? a.projects.map(String) : []);
      const granted = wildcard ? await projectList() : (await projectList()).filter(p => mine.has(p.slug) || mine.has(p.name));
      const checked = await Promise.all(granted.map(async p => {
        const c = await ctx.call("projects.access.check", { project: p.slug, agent: who });
        if (c.error && c.error.code === "no_such_tool") return p;
        return c.data && c.data.granted ? p : null;
      }));
      return { all: false, agent: who, folders: checked.filter(Boolean).flatMap(p => p.folders) };
    };
    /** Narrows q.project_cwds to what a scoped agent may read, or throws. Owners/modules pass through. */
    const scopeQuery = async (q, caller) => {
      const r = await reach(q.agent, caller);
      delete q.agent;
      if (r.all) return r;
      const requested = (q.project_cwds || []).map(String);
      if (requested.length) {
        const outside = requested.filter(c => !within(c, r.folders));
        if (outside.length) throw denied(`${r.agent} is not granted ${outside.join(", ")}`);
      } else {
        if (!r.folders.length) throw denied(`${r.agent} is not granted any project yet`);
        q.project_cwds = r.folders;
      }
      return r;
    };
    const agentField = { agent: { type: "string" } };

    ctx.tool("recall.search", {
      description: "Search every Claude Code session on this machine for turns about something. Returns the best turns with their session's name, title and folder.",
      input: { type: "object", required: ["q"], properties: {
        q: { type: "string" }, limit: { type: "integer" }, project_cwds: stringArray,
        sessions: { ...stringArray, description: "also these sessions wherever they ran (a project's attached sessions); from modules and the person's surfaces only" },
        role: { type: "string", enum: ["user", "assistant"] }, hybrid: { type: "boolean" },
        per_session: { type: "integer" }, prefix: { type: "boolean", description: "each word as a prefix, all of them, keyword only: for completion while typing" }, machines, ...agentField,
      } },
      run: async (input, { caller } = {}) => {
        const { machines: _, ...q } = input;
        // sessions widens a scope, so only a module or the person's own surface may name them: a
        // model's scope is its folders (the MCP server holds an agent to its projects' folders).
        if (q.sessions && !/^(?:module:|deck$|cli$|local$|capsule$)/.test(String(caller || ""))) delete q.sessions;
        // A named agent (a project-scoped one, or one asked for by a module on its behalf) reads
        // only its granted projects' folders: no project_cwds, no cross-project cwds, no whole corpus.
        const scopeR = await scopeQuery(q, caller);
        // Defense in depth: q.project_cwds already carries the grant, so this is a no-op unless a
        // paired Mac is on an older build that does not scope its own side yet.
        const scoped = hits => scopeR.all ? hits : hits.filter(h => within(h.cwd, scopeR.folders));
        const here = async () => {
          // No model load for a corpus with no vectors yet: that would cost seconds and change nothing.
          const any = db.prepare("SELECT 1 FROM recall_vectors LIMIT 1").get();
          const e = q.hybrid === false || !any ? null : await embedder();
          return scoped((await search(db, q, e, dense)).hits);
        };
        if (!wantsMacs(ctx, input, caller)) return here();
        // On the box, for the person: the Macs' best turns too, by score, capped at the limit.
        const [own, answers] = await Promise.all([here(), askMacs(ctx, "recall.search", q)]);
        return mergeRows(ctx, own, answers, { rows: scoped, compare: (a, b) => b.score - a.score, limit: Math.max(1, Math.min(100, q.limit || 10)) });
      },
    });
    ctx.tool("recall.thread", {
      description: "One session and its turns, in order. Takes a session id or an unambiguous prefix of one.",
      input: { type: "object", required: ["session"], properties: {
        session: { type: "string" }, from: { type: "integer" }, limit: { type: "integer" }, machines,
        source: { type: "string", enum: ["box", "mac"] }, ...agentField } },
      run: async (input, { caller } = {}) => {
        const { machines: _, source, agent, ...q } = input;
        const r = await reach(agent, caller);
        // A scoped agent reads a session only inside its granted projects' folders: not by naming
        // any session id it likes. Thrown the same way as "not found", so a scoped agent learns
        // nothing about a session it may not read (not even that it exists).
        const gate = row => { if (!r.all && !within(row?.session?.cwd, r.folders)) throw new Error(`no session ${q.session}`); return row; };
        if (!wantsMacs(ctx, input, caller)) return gate(thread(db, q));
        // On the box, for the person: the box's own session first. A session the box does not
        // have, or one the caller says is on the Mac, is asked of the Macs, and the first that
        // has it answers. Its turns go back to the caller and are never stored here.
        if (source !== "mac") {
          try { return gate({ ...thread(db, q), ...boxLabel(ctx) }); }
          catch (e) { if (!/^no session /.test(/** @type {Error} */ (e).message)) throw e; }
        }
        const answers = await askMacs(ctx, "recall.thread", q);
        const found = answers.find(a => a.ok && a.data);
        if (found) return gate({ ...found.data, ...macLabel(found) });
        const why = answers.length ? answers.map(a => `${a.name}: ${a.error ? a.error.code : "no answer"}`).join(", ") : "no Mac is paired";
        throw new Error(`no session ${q.session} (${why})`);
      },
    });
    ctx.tool("recall.transcript", {
      description: "A rich read of one session for a person's own screen: what was said, thinking, every tool call with its input and output, and each turn's time and tokens. Takes a session id or an unambiguous prefix of one. Without from, the last blocks; before pages back.",
      input: { type: "object", required: ["session"], properties: {
        session: { type: "string" }, from: { type: "integer" }, limit: { type: "integer" }, before: { type: "integer" }, machines,
        source: { type: "string", enum: ["box", "mac"] } } },
      // A person's surfaces only: tool output can hold anything the session read, so it is never
      // handed to Claude over MCP or to an agent. callers is an allowlist, so every "mcp" is out.
      callers: ["cli", "local", "deck", "capsule", "module"],
      run: async (input, { caller } = {}) => {
        const { machines: _, source, ...q } = input;
        if (!wantsMacs(ctx, input, caller)) return transcript(q);
        // On the box, for the person: a session the box does not have, or one the caller says is
        // on the Mac, is read from the Macs, as recall.thread does. The blocks go back to the
        // caller and are never stored here.
        if (source !== "mac") {
          try { return { ...transcript(q), ...boxLabel(ctx) }; }
          catch (e) { if (/** @type {any} */ (e).code !== "not_found") throw e; }
        }
        const answers = await askMacs(ctx, "recall.transcript", q);
        const found = answers.find(a => a.ok && a.data);
        if (found) return { ...found.data, ...macLabel(found) };
        // Still "not_found" when every Mac answered that it has no such session, so the Deck
        // takes it as quietly as the box's own miss; an away Mac says so.
        const why = answers.length ? answers.map(a => `${a.name}: ${a.error ? a.error.code : "no answer"}`).join(", ") : "no Mac is paired";
        const none = answers.every(a => a.error && (a.error.code === "not_found" || /^no session /.test(String(a.error.message || ""))));
        throw Object.assign(new Error(`no session ${q.session} (${why})`), none ? { code: "not_found" } : {});
      },
    });
    /** One session read as blocks, on this machine. @param {any} input */
    function transcript(input) {
      // A thread that started a moment ago has a transcript before any pass has indexed it, so
      // an id Recall does not know yet is looked for on disk (exact ids only). No file at all
      // is "not_found", which the Deck takes quietly.
      let row = sessionRow(db, input.session);
      if (!row) {
        const e = find(folders(), input.session);
        if (!e) throw Object.assign(new Error(`no session ${input.session}`), { code: "not_found" });
        row = { id: e.id, file: e.file, ...peek(e.file), title: null };
      }
      const { id, cwd, name, title } = row;
      return { session: { id, cwd, name, title }, ...blocks(String(row.file), { from: input.from, limit: input.limit, before: input.before }) };
    }
    // Live tails (watch.js). Times are settings so tests need not wait minutes.
    const watches = new Watches({
      emit: (type, payload, where) => ctx.events.emit(type, payload, where),
      log: ctx.log,
      ttlMs: opts.watchTtlMs, idleMs: opts.watchIdleMs, sweepMs: opts.watchSweepMs,
      resolve: session => {
        const row = sessionRow(db, session);
        if (row) return { id: String(row.id), file: String(row.file) };
        const e = find(folders(), session);
        return e ? { id: e.id, file: e.file } : null;
      },
    });
    // The same people as recall.transcript: the text of every turn goes by, redacted.
    const own = ["cli", "local", "deck", "capsule", "module"];
    ctx.tool("recall.watch", {
      description: "Follow one session live: each completed turn arrives as a session.turn event (thread = the session id) and session.state says whether a reply is under way. from is a turn id to replay after first; without it, only new turns. Call again with the same watch id to renew it: a watch nobody renews ends after 3 minutes, and one whose session is quiet for 30 minutes ends too.",
      input: { type: "object", required: ["session"], properties: {
        session: { type: "string" }, from: { type: "string" }, watch: { type: "string" } } },
      callers: own,
      run: async input => watches.watch(input),
    });
    ctx.tool("recall.unwatch", {
      description: "Stop following a session (a watch id from recall.watch).",
      input: { type: "object", required: ["watch"], properties: { watch: { type: "string" } } },
      callers: own,
      run: async input => watches.unwatch(input),
    });
    ctx.tool("recall.sessions", {
      description: "Indexed sessions, newest first, optionally only those in or under a folder, since a time, started by a person, or with the given ids.",
      input: { type: "object", properties: {
        cwd: { type: "string" }, since: { type: "number" }, human: { type: "boolean" }, limit: { type: "integer" }, ids: stringArray, machines, ...agentField } },
      run: async (input, { caller } = {}) => {
        const { machines: _, agent, ...q } = input;
        const r = await reach(agent, caller);
        if (!r.all && q.cwd && !within(q.cwd, r.folders)) throw denied(`${r.agent} is not granted ${q.cwd}`);
        // ids can name any session (the box's cross-project resolve for a Mac's picked ones): a
        // scoped agent's own list still narrows to what it is granted, never all of them.
        const scoped = rows => r.all ? rows : rows.filter(row => within(row.cwd, r.folders));
        if (!wantsMacs(ctx, input, caller)) return scoped(sessions(db, q));
        // On the box, for the person: the Macs' sessions too, newest first, capped at the limit.
        const [own, answers] = await Promise.all([sessions(db, q), askMacs(ctx, "recall.sessions", q)]);
        return mergeRows(ctx, scoped(own), answers, { rows: scoped, compare: (a, b) => (b.ended || 0) - (a.ended || 0), limit: Math.max(1, Math.min(1000, q.limit || 50)) });
      },
    });
    ctx.tool("recall.forget", {
      internal: true,
      description: "Forget these sessions outright: turns, vectors and rows. For memory, when a device's synced sessions are revoked; the files are already gone.",
      input: { type: "object", required: ["sessions"], properties: { sessions: stringArray } },
      run: async ({ sessions: ids }) => { const n = indexer.forget(ids.map(String)); dense.invalidate(); return { forgot: n }; },
    });
    ctx.tool("recall.index", {
      description: "Index new and changed transcripts now. Returns what the pass did.",
      input: { type: "object", properties: {} },
      run: async () => pass(),
    });
    ctx.tool("recall.status", {
      description: "How much is indexed, when the last pass ran, and whether search can rank by meaning.",
      input: { type: "object", properties: {} },
      run: async () => {
        const n = sql => Number(/** @type {any} */ (db.prepare(sql).get()).n);
        const turns = n("SELECT COUNT(*) n FROM recall_turns");
        const embedded = n("SELECT COUNT(*) n FROM recall_vectors WHERE chunk = 0");
        const last = /** @type {any} */ (db.prepare("SELECT v FROM recall_meta WHERE k = 'last_index'").get());
        return {
          sessions: n("SELECT COUNT(*) n FROM recall_sessions"), turns,
          folders: folders(), every, indexing: running, last: last ? JSON.parse(String(last.v)) : null, error: lastError,
          progress: { sessions: progress.total ? { done: progress.done, total: progress.total } : null, paused: g ? g.why : null, priority: "low" },
          watches: watches.stats(),
          vectors: { on: vec.on, ready: Boolean(vec.embedder), why: vec.why, embedded, pending: Math.max(0, turns - embedded), embedding: vec.busy, dense: dense.stats() },
        };
      },
    });

    ctx.tool("recall.setup", {
      description: "Install the search model now (the library and its weights, once) and load it, so search ranks by meaning. Resolves when it is ready or has failed, and says which.",
      input: { type: "object", properties: {} },
      run: async () => {
        if (opts.vectors === false) return { ready: false, why: vec.why };
        // A failed install or load is not final: setup is the way to try again.
        if (!vec.embedder && !vec.on) { vec.on = true; vec.loading = null; }
        const e = await embedder();
        if (e) vectorLoop();
        return { ready: Boolean(e), why: vec.why, model: e ? e.model : null };
      },
    });

    ctx.tool("recall.eval", {
      description: "Measure search against a labelled set: MRR and recall for keyword, dense and hybrid, and whether nonsense clears the dense floor.",
      input: { type: "object", required: ["queries"], properties: {
        queries: { type: "array", items: { type: "object", required: ["q", "answers"], properties: { q: { type: "string" }, answers: { type: "array" } } } },
        nonsense: stringArray, k: { type: "integer" } } },
      run: async input => {
        const any = db.prepare("SELECT 1 FROM recall_vectors LIMIT 1").get();
        const e = any ? await embedder() : null;
        return evaluate(db, input, { embedder: e, dense, k: input.k || 10 });
      },
    });

    // A Claude Code turn just ended (the harness's Stop hook) or a session began: index that one
    // session now, so the Deck's Chat mirrors a terminal session a moment after each turn instead
    // of at the next pass. Debounced per session, and run on the pass chain so it never overlaps
    // a pass. The whole-folder pass below still catches anything without the hooks.
    const SOON_MS = opts.soonMs ?? 1500;
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    const soon = new Map();
    const indexSoon = (/** @type {any} */ e) => {
      const id = e?.payload?.session;
      if (stopped || typeof id !== "string" || !id) return;
      clearTimeout(soon.get(id));
      soon.set(id, setTimeout(() => {
        soon.delete(id);
        chain = chain.then(() => { if (!stopped) indexer.session(folders(), id); }).catch(err => ctx.log(`could not index ${id}: ${err.message}`));
      }, SOON_MS));
    };
    const offs = [ctx.events.on("turn.completed", indexSoon), ctx.events.on("thread.started", indexSoon),
      ctx.events.on("turn.completed", (/** @type {any} */ e) => { const id = e?.payload?.session; if (typeof id === "string" && id) watches.stopped(id); })];

    // After start returns, so vyred's startup never waits on a pass.
    const first = setTimeout(() => { pass().catch(() => {}); }, 0);
    const timer = every > 0 ? setInterval(() => { if (!running) pass().catch(() => {}); }, every * 60_000) : null;
    timer?.unref();

    return {
      async stop() {
        stopped = true;
        watches.close();
        clearTimeout(first);
        clearTimeout(retry);
        for (const off of offs) if (typeof off === "function") off();
        for (const t of soon.values()) clearTimeout(t);
        if (timer) clearInterval(timer);
        await chain;
        await vec.done;
        // A model load in flight writes into the home; let it settle before the home can go.
        if (vec.loading) await Promise.race([vec.loading.catch(() => null), new Promise(r => setTimeout(r, 5000).unref())]);
        const e = /** @type {any} */ (vec.embedder);
        if (e && typeof e.close === "function") e.close();
      },
    };
  },
};
