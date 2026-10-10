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
import { span, byLink, resolve as resolveSession, rolloverOf } from "./turns.js";
import { evaluate } from "./eval.js";
import { spawnEmbedder, cached, installed, DOWNLOAD_MB } from "./embed.js";
import { pacer, gate } from "./pace.js";
import { Dense } from "./dense.js";
import { scanIndex, scrubIndex, scrubLog } from "./sealed.js";
import { Watches } from "./watch.js";
import { blocks, find, peek } from "../transcripts/index.js";
import { transcriptFolders } from "../config/index.js";
import { wantsMacs, askMacs, mergeRows, boxLabel, macLabel } from "../modules/federate.js";
import { ownerDevice } from "../modules/index.js";
import { within } from "../../lib/within.js";
import { isPerson, isDevice, modelKey } from "../../lib/caller.js";

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
    // <home>/mirror holds the conversation of every thread a provider other than Claude ran (core/switchboard mirror()), in Claude Code's own layout: Recall indexes it like any session.
    const mirrorRoot = ctx.paths?.root ? path.join(ctx.paths.root, "mirror") : null;
    const folders = () => [...configured.flatMap(f => {
      if (!syncedRoot || path.resolve(f) !== path.resolve(syncedRoot)) return [f];
      try { return fs.readdirSync(f, { withFileTypes: true }).filter(e => e.isDirectory() && /^[A-Za-z0-9._-]{1,80}$/.test(e.name)).map(e => path.join(f, e.name)).sort(); } catch { return []; }
    }), ...(mirrorRoot ? [mirrorRoot] : [])];
    // Every vector in memory for retrieval by meaning: built once, then appended to as turns are
    // embedded, and rebuilt only when a rewrite deletes turns or the chunk cap is reached.
    const dense = new Dense(db, { maxChunks: opts.maxChunks });
    const indexer = new Indexer(db, {
      emit: (type, payload, where) => ctx.events.emit(type, payload, where),
      log: ctx.log,
      // Who started a session under an account's folder comes from the Switchboard's record, never the transcript.
      origin: async session => { const r = await ctx.call("threads.origin", { session }); return r && r.data ? r.data : null; },
      // Each new vector goes straight into the dense index, so a pass never forces a rebuild.
      // A rewrite moves the generation, and the index rebuilds itself on the next search.
      onVector: item => dense.add(item),
      // The capture port: after a batch of a session's turns is indexed (already scrubbed), the work module's engine keeps the same lines for the Space's memory, once, in chunks of
      // at most 2000. A session whose turns were rewritten is forgotten there first. No work module, or a refusal, is not an error: the Space just has no memory of conversations.
      capture: async ({ session, rewritten, lines, cwd }) => {
        if (rewritten) await ctx.call("work.know.forget", { session });
        // The project the session's folder belongs to: the work module reads a session's lines under that project's record, so a teammate granted the project covers its sessions.
        const of = cwd ? await ctx.call("projects.of", { cwd }).catch(() => null) : null;
        const project = of && of.data && typeof of.data.slug === "string" ? of.data.slug : null;
        for (let i = 0; i < lines.length; i += 2000) {
          const r = await ctx.call("work.know.capture", { session, lines: lines.slice(i, i + 2000), ...(project ? { project } : {}) });
          if (r && r.error) { if (!captureWarned) { captureWarned = true; ctx.log(`recall: the Space's memory takes no conversations (${r.error.code || "refused"})`); } return; }
        }
      },
    });
    let captureWarned = false;

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
    const inFolders = (cwd, granted) => { const c = String(cwd || "").replace(/\/+$/, ""); return granted.some(f => { const base = String(f).replace(/\/+$/, ""); return !!base && (c === base || c.startsWith(base + "/")); }); };
    const denied = message => Object.assign(new Error(message), { code: "denied" });
    /** The user's own surfaces and modules see every session; only a named agent is scoped. */
    const owner = caller => (isPerson(caller) && !isDevice(caller)) || modelKey(caller) === "caller:module";
    /** A model's session that names no agent: a bare "mcp", or "mcp:thread:<id>". It is NOT the person (reviewer-2's recall verdict, MS-1/KW-1): reach() holds it to its own thread's project. */
    const unnamedModel = caller => modelKey(caller) === "caller:mcp";
    /** Every tool a caller kind may reach, checked before run() at all (core/modules/index.js's
     * callerAllowed): the person's surfaces, first-party modules, and "mcp" (a model's own
     * session, or a named agent — reach() below tells those apart and scopes the latter). Not
     * "tailnet": callerAllowed still lets the owner's OWN verified device through via "deck"
     * (ownerDevice), so this is "no guest, no unknown tailnet peer, no hook", not "no tailnet at
     * all". Declared here (reviewer's MEDIUM, alongside the reach() fix below) so a caller kind
     * neither of us has thought of yet is refused by default, not admitted by default.
     */
    const READERS = ["cli", "local", "deck", "capsule", "module", "mcp"];
    /** recall.related is never an agent's: the person's own surfaces and first-party modules
     * only (chat, native-core render it; no MCP server ever forwards it to a model). */
    const OWNERS_ONLY = ["cli", "local", "deck", "capsule", "module"];
    /** Projects, as the projects module knows them: slug and its folders. No module without projects: no scoping to do. */
    const projectList = async () => {
      const r = await ctx.call("projects.list", {});
      if (r.error && r.error.code !== "no_such_tool") throw new Error(r.error.message);
      const list = r.error ? [] : (Array.isArray(r.data) ? r.data : r.data?.projects || []);
      return list.filter(p => p && p.slug).map(p => ({ slug: String(p.slug), name: String(p.name || p.slug),
        folders: [...new Set([p.home, ...(p.workspaces || []), ...(p.folders || [])].filter(Boolean).map(String))] }));
    };
    /**
     * What a caller may read: { all: true } for the user's own surfaces, modules, a paired
     * device or the owner's own verified device over the tailnet (ownerDevice), and a model's
     * own session (never a named agent); else { all: false, agent, folders }. The assistant and
     * a wildcard (projects: "*") agent both walk the per-project path, starting from every
     * MAPPED project — raw session content, unlike a personal fact, is not the assistant's to
     * read past what is linked, so recall narrows it the same way memory's unfiled room does
     * (the lead's ruling, 2026-09-28, after federation's read of d897210d: personal facts stay
     * unrestricted for the assistant; raw content from an unmapped folder does not). The
     * assistant is unchecked against projects.access (being the assistant is what grants it,
     * same as core/memory/index.js's reach()); a wildcard or named agent is intersected with it
     * (deny by default; an install without that module keeps today's behavior unchanged).
     * Everyone else with no agent named — a guest, an unrecognised tailnet peer, a hook, any
     * caller kind neither this nor callerAllowed's READERS list has been taught about — is
     * refused outright, not defaulted to "all" (reviewer's MEDIUM on the first cut of this). Who
     * the agent is comes from the caller ("...agent:<name>") or input.agent; if both are given
     * they must agree. When agents cannot be checked, a named agent is refused.
     * @param {string|undefined} agent @param {string|undefined} caller
     */
    const reach = async (agent, caller, meta = {}) => {
      // A kernel session token (set by the daemon from a vouched socket only, never by the call) says which person this is and which agent it runs as: the route a person's own Claude takes.
      // [person] or [person, assistant] with the person the home's owner is the person: all of it. [person, <named agent>] is that agent, scoped below. Anything else: not the person.
      let tokenAgent = null;
      if (ctx.kernel && typeof ctx.kernel.chain === "function" && meta && typeof meta.token === "string" && meta.token) {
        const c = await ctx.kernel.chain(meta).catch(() => null);
        const hops = c && Array.isArray(c.hops) ? c.hops : [];
        const first = hops[0] && hops[0].actor;
        const canon = typeof ctx.kernel.canonicalPerson === "function" ? (/** @type {string} */ id) => ctx.kernel.canonicalPerson(id) : (/** @type {string} */ id) => id;
        if (first && first.kind === "person" && canon(first.id) === canon(String(ctx.kernel.owner)) && !hops.slice(1).some((/** @type {any} */ h) => h.actor.kind === "person") && !(c.room)) {
          const rest = hops.slice(1).filter((/** @type {any} */ h) => h.actor.kind === "agent");
          const named = rest.map((/** @type {any} */ h) => String(h.actor.id)).filter((/** @type {string} */ n) => n !== "assistant");
          if (!named.length && hops.slice(1).every((/** @type {any} */ h) => h.actor.kind === "agent")) return { all: true, agent: null, folders: [] };
          if (named.length === 1) tokenAgent = named[0];
        }
      }
      const said = tokenAgent || /(?:^|[\s:])agent:([A-Za-z0-9_-]+)/.exec(String(caller || ""))?.[1] || null;
      if (said && agent && said !== agent) throw denied(`the call came from agent ${said} but names agent ${agent}`);
      const who = said || agent || null;
      if (!who) {
        if (owner(caller) || ownerDevice(caller)) return { all: true, agent: null, folders: [] };
        // An unnamed model session (`mcp`, `mcp:thread:<id>`: every model's shell) is never the person (MS-1, KW-1): it reads its OWN thread's project and nothing else, held to that project's
        // folders like a named agent with one project. A bare `mcp` with no thread of its own has no project, so no folders, so no read.
        if (unnamedModel(caller)) {
          // The thread is what the DAEMON vouched (meta.thread, set from the session's own socket or key), never the `:thread:<id>` text of the label: a model sends any label it likes (RC-1).
          const thread = typeof meta.thread === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(meta.thread) ? meta.thread : null;
          /** @type {string[]} */ let folders = [];
          if (thread) {
            const t = await ctx.call("threads.get", { thread, limit: 1 });
            const rec = t && !t.error && t.data && t.data.thread ? t.data.thread : null;
            if (rec && rec.project) folders = (await projectList()).filter(p => p.slug === String(rec.project)).flatMap(p => p.folders);
            else if (rec && rec.cwd) folders = [String(rec.cwd)];
            else {
              // A terminal session bound to its claude process is no Vyre thread: its own transcript says where it runs, so it reads that project (or just that folder).
              const row = /** @type {any} */ (sessionRow(db, thread));
              if (row && row.cwd) { const inP = (await projectList()).filter(p => inFolders(String(row.cwd), p.folders)); folders = inP.length ? inP.flatMap(p => p.folders) : [String(row.cwd)]; }
            }
          }
          return { all: false, agent: "an unnamed model session", folders };
        }
        throw denied(`recall is for the user's own surfaces, modules and named agents, not ${String(caller || "an unnamed caller").slice(0, 60)}`);
      }
      const r = await ctx.call("agents.list", {});
      if (r.error) throw new Error(`agent ${who}: its projects cannot be checked (${r.error.code === "no_such_tool" ? "agents are not running on this machine" : r.error.message})`);
      const list = Array.isArray(r.data) ? r.data : r.data?.agents || [];
      const a = list.find(x => x && x.name === who);
      if (!a) throw denied(`no agent ${who}`);
      const assistant = a.kind === "assistant";
      // "Claude Code on <this computer>": an agent the person granted their memory and every project's sessions to READ, once (agents `personal`, projects "*"). Reads only; it is never the person.
      if (a.personal === true && a.projects === "*") return { all: true, agent: who, folders: [] };
      const wildcard = a.projects === "*";
      const mine = new Set(Array.isArray(a.projects) ? a.projects.map(String) : []);
      const granted = assistant || wildcard ? await projectList() : (await projectList()).filter(p => mine.has(p.slug) || mine.has(p.name));
      const checked = assistant ? granted : await Promise.all(granted.map(async p => {
        const c = await ctx.call("projects.access.check", { project: p.slug, agent: who });
        if (c.error && c.error.code === "no_such_tool") return p;
        return c.data && c.data.granted ? p : null;
      }));
      return { all: false, agent: who, folders: checked.filter(Boolean).flatMap(p => p.folders) };
    };
    /** Narrows q.project_cwds to what a scoped agent may read, or throws. Owners/modules pass through. */
    const scopeQuery = async (q, caller, meta = {}) => {
      const r = await reach(q.agent, caller, meta);
      delete q.agent;
      if (r.all) return r;
      const requested = (q.project_cwds || []).map(String);
      if (requested.length) {
        const outside = requested.filter(c => !inFolders(c, r.folders));
        if (outside.length) throw denied(`${r.agent} is not granted ${outside.join(", ")}`);
      } else {
        if (!r.folders.length) throw denied(`${r.agent} is not granted any project yet`);
        q.project_cwds = r.folders;
      }
      return r;
    };
    const agentField = { agent: { type: "string" } };

    ctx.tool("recall.search", {
      effect: "read",
      description: "Search every Claude Code session on this machine for turns about something. Returns the best turns with their session's name, title and folder.",
      input: { type: "object", required: ["q"], properties: {
        q: { type: "string" }, limit: { type: "integer" }, project_cwds: stringArray,
        sessions: { ...stringArray, description: "also these sessions wherever they ran (a project's attached sessions); from modules and the person's surfaces only" },
        role: { type: "string", enum: ["user", "assistant"] }, hybrid: { type: "boolean" },
        per_session: { type: "integer" }, prefix: { type: "boolean", description: "each word as a prefix, all of them, keyword only: for completion while typing" }, machines, ...agentField,
        links: { type: "array", items: { type: "object", required: ["ref"], properties: { kind: { type: "string", enum: ["file", "read", "commit", "url"] }, ref: { type: "string" } } },
          description: "keep only turns that touched these (a file path or name, a commit hash, a url), or sit next to one that did" },
      } },
      callers: READERS,
      run: async (input, meta = {}) => { const caller = meta.caller;
        const { machines: _, ...q } = input;
        // sessions widens a scope, so only a module or the person's own surface may name them: a
        // model's scope is its folders (the MCP server holds an agent to its projects' folders).
        if (q.sessions && !/^(?:module:|deck$|cli$|local$|capsule$)/.test(String(caller || ""))) delete q.sessions;
        // A named agent (a project-scoped one, or one asked for by a module on its behalf) reads
        // only its granted projects' folders: no project_cwds, no cross-project cwds, no whole corpus.
        const scopeR = await scopeQuery(q, caller, meta);
        // Defense in depth: q.project_cwds already carries the grant, so this is a no-op unless a
        // paired Mac is on an older build that does not scope its own side yet.
        const scoped = hits => scopeR.all ? hits : hits.filter(h => inFolders(h.cwd, scopeR.folders));
        const here = async () => {
          // No model load for a corpus with no vectors yet: that would cost seconds and change nothing.
          const any = db.prepare("SELECT 1 FROM recall_vectors LIMIT 1").get();
          const e = q.hybrid === false || !any ? null : await embedder();
          return scoped((await search(db, q, e, dense)).hits);
        };
        if (!(await wantsMacs(ctx, input, caller, meta))) return here();
        // On the box, for the person: the Macs' best turns too, by score, capped at the limit.
        const [own, answers] = await Promise.all([here(), askMacs(ctx, "recall.search", q)]);
        return mergeRows(ctx, own, answers, { rows: scoped, compare: (a, b) => b.score - a.score, limit: Math.max(1, Math.min(100, q.limit || 10)) });
      },
    });
    ctx.tool("recall.related", {
      effect: "read",
      description: "1 to 3 of a project's own past sessions relevant to what the person is about to say, for chat's \"From your past sessions\" hint while they type. Each hit is one turn (its own session, seq, role, ts, name, cwd and a short snippet), the person's own or the assistant's; chat/native-core render the reason sentence and the link. Owner surfaces only, and only inside a real, mapped project: project_cwds must name at least one folder that is actually a project's; an ad-hoc or unmapped folder gets no hint rather than the whole corpus.",
      input: { type: "object", required: ["project_cwds", "text"], properties: {
        project_cwds: stringArray, text: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 3 } } },
      callers: OWNERS_ONLY,
      run: async (input, meta = {}) => { const caller = meta.caller;
        // Never an agent (OWNERS_ONLY already refuses one at the gate); reach() with no agent
        // still runs, so a caller kind that slips past OWNERS_ONLY some day is refused here too,
        // the same way recall.search's does.
        if (!(await reach(undefined, caller, meta)).all) return { hits: [] };
        const text = String(input.text || "").trim();
        const cwds = [...new Set((input.project_cwds || []).map(String).filter(Boolean))];
        if (!text || !cwds.length) return { hits: [] };
        // Never an unmapped folder: at least one given folder must be a real project's own (or
        // inside one), never a raw path a caller made up.
        const projects = await projectList();
        const mapped = cwds.filter(c => projects.some(p => inFolders(c, p.folders)));
        if (!mapped.length) return { hits: [] };
        const limit = Math.max(1, Math.min(3, input.limit || 3));
        const any = db.prepare("SELECT 1 FROM recall_vectors LIMIT 1").get();
        const e = any ? await embedder() : null;
        const { hits } = await search(db, { q: text, project_cwds: mapped, per_session: 1, limit }, e, dense);
        return { hits: hits.map(h => ({ session: h.session, seq: h.seq, role: h.role, ts: h.ts, name: h.name, title: h.title, cwd: h.cwd, snippet: h.snippet, score: h.score })) };
      },
    });
    ctx.tool("recall.thread", {
      effect: "read",
      description: "One session and its turns, in order. Takes a session id or an unambiguous prefix of one.",
      input: { type: "object", required: ["session"], properties: {
        session: { type: "string" }, from: { type: "integer" }, limit: { type: "integer" }, machines,
        source: { type: "string", enum: ["box", "mac"] }, ...agentField } },
      callers: READERS,
      run: async (input, meta = {}) => { const caller = meta.caller;
        const { machines: _, source, agent, ...q } = input;
        const r = await reach(agent, caller, meta);
        // A scoped agent reads a session only inside its granted projects' folders: not by naming
        // any session id it likes. Thrown the same way as "not found", so a scoped agent learns
        // nothing about a session it may not read (not even that it exists).
        const gate = row => { if (!r.all && !inFolders(row?.session?.cwd, r.folders)) throw new Error(`no session ${q.session}`); return row; };
        // Resolved among only what this caller may read, so an id or prefix outside its grant
        // never surfaces even as "more than one session starts with X" (reviewer's LOW: that
        // told a scoped agent such a session exists before the gate above ever ran).
        const resolveScoped = session => {
          if (r.all) return session;
          const exact = /** @type {any} */ (db.prepare("SELECT cwd FROM recall_sessions WHERE id = ?").get(session));
          if (exact) { if (!inFolders(exact.cwd, r.folders)) throw new Error(`no session ${session}`); return session; }
          const like = /** @type {any[]} */ (db.prepare("SELECT id, cwd FROM recall_sessions WHERE substr(id, 1, ?) = ?").all(session.length, session))
            .filter(row => inFolders(row.cwd, r.folders));
          if (!like.length) throw new Error(`no session ${session}`);
          if (like.length > 1) throw new Error(`more than one session starts with ${session}`);
          return like[0].id;
        };
        if (!(await wantsMacs(ctx, input, caller, meta))) return gate(thread(db, { ...q, session: resolveScoped(q.session) }));
        // On the box, for the person: the box's own session first. A session the box does not
        // have, or one the caller says is on the Mac, is asked of the Macs, and the first that
        // has it answers. Its turns go back to the caller and are never stored here.
        if (source !== "mac") {
          try { return gate({ ...thread(db, { ...q, session: resolveScoped(q.session) }), ...boxLabel(ctx) }); }
          catch (e) { if (!/^no session /.test(/** @type {Error} */ (e).message)) throw e; }
        }
        const answers = await askMacs(ctx, "recall.thread", q);
        const found = answers.find(a => a.ok && a.data);
        if (found) return gate({ ...found.data, ...macLabel(found) });
        // Not a failure of the server: no Mac to ask, or none that has it, is "not found", as recall.transcript says (a 404, with words a person can read).
        const why = answers.length ? answers.map(a => `${a.name}: ${a.error ? a.error.code : "no answer"}`).join(", ") : "no Mac is paired";
        const asleep = answers.some(a => a.error && a.error.code !== "not_found" && !/^no session /.test(String(a.error.message || "")));
        throw Object.assign(new Error(answers.length && !asleep ? `no session ${q.session} (${why})` : `That session is on a Mac that isn't connected. (${why})`), { code: "not_found" });
      },
    });
    /**
     * A session id this caller may read, resolved among only what it may read: an id or prefix outside its grant never surfaces, not even as "more than one session starts with X".
     * Thrown as "not found", so a scoped agent learns nothing about a session it may not read (recall.thread's rule, shared by the tools below).
     * @param {{ all: boolean, folders: string[] }} r @param {string} session
     */
    const readableSession = (r, session) => {
      if (r.all) return resolveSession(db, session);
      const gone = () => Object.assign(new Error(`no session ${session} (recall.sessions lists them)`), { code: "not_found" });
      const exact = /** @type {any} */ (db.prepare("SELECT id, cwd FROM recall_sessions WHERE id = ?").get(session));
      if (exact) { if (!inFolders(exact.cwd, r.folders)) throw gone(); return resolveSession(db, exact.id); }
      const like = /** @type {any[]} */ (db.prepare("SELECT id, cwd FROM recall_sessions WHERE substr(id, 1, ?) = ?").all(session.length, session)).filter(x => inFolders(x.cwd, r.folders));
      if (!like.length) throw gone();
      if (like.length > 1) throw new Error(`more than one session starts with ${session}`);
      return resolveSession(db, like[0].id);
    };
    ctx.tool("recall.turn", {
      effect: "read",
      description: "A span of one past session, word for word: the turns themselves, no summary, each with its pointer (session:seq), its time, and what it touched (files, commits, urls). Name the turn with seq, and before and after for the turns around it, or give from with to or span. A turn the search index had to cut is read whole from the transcript. Redacted like everything Recall holds.",
      input: { type: "object", required: ["session"], properties: {
        session: { type: "string", description: "a session id, or an unambiguous prefix of one" },
        seq: { type: "integer", minimum: 0 }, before: { type: "integer", minimum: 0, maximum: 60 }, after: { type: "integer", minimum: 0, maximum: 60 },
        from: { type: "integer", minimum: 0 }, to: { type: "integer", minimum: 0 }, span: { type: "integer", minimum: 1, maximum: 60 },
        full: { type: "boolean", description: "false: give a long turn as the index holds it (cut) instead of reading the transcript" }, ...agentField } },
      callers: READERS,
      run: async (input, meta = {}) => { const caller = meta.caller;
        const { agent, session, ...q } = input;
        const r = await reach(agent, caller, meta);
        const row = readableSession(r, String(session || ""));
        return span(db, { ...q, session: row.id });
      },
    });
    ctx.tool("recall.links", {
      effect: "read",
      description: "The turns that touched a file, commit or url, newest first. Each is a pointer (session:seq) for recall.turn, with a snippet.",
      input: { type: "object", required: ["ref"], properties: { ref: { type: "string", description: "A file path or just its name, a short or full commit hash, or a url." }, kind: { type: "string", enum: ["file", "read", "commit", "url"], description: "file for changes, read for reads (both by default), commit or url." },
        session: { type: "string" }, since: { type: "integer", description: "ms since epoch" }, limit: { type: "integer", minimum: 1, maximum: 200 }, ...agentField } },
      callers: READERS,
      run: async (input, meta = {}) => { const caller = meta.caller;
        const { agent, session, ...q } = input;
        const r = await reach(agent, caller, meta);
        const id = session ? readableSession(r, String(session)).id : undefined;
        const rows = byLink(db, { ...q, ...(id ? { session: id } : {}), limit: (q.limit || 30) * (r.all ? 1 : 4) });
        const keep = r.all ? rows : rows.filter(x => inFolders(x.cwd, r.folders));
        return keep.slice(0, Math.max(1, Math.min(200, q.limit || 30)));
      },
    });
    ctx.tool("recall.pointers", {
      effect: "read",
      description: "For a rollover (Vyre's own, when a session's window fills): the windows of one thread (session ids, oldest first) indexed now, then the one split Vyre's seed makes of them: the last turns, newest window first, whose text adds up to tail_chars, word for word (a long turn cut, with the pointer that reads it whole), and, for every turn before them, an index of pointers: the person's own requests as lines (session:turn, who, when, the start of what was said), the files touched and the commits made. Pointers read back with recall.turn. A person's surface or a module asks, for the sessions of a thread it runs; never an agent.",
      input: { type: "object", required: ["sessions"], properties: { sessions: { ...stringArray, maxItems: 24 }, tail_chars: { type: "integer", minimum: 0, maximum: 400000 }, lines: { type: "integer", minimum: 1, maximum: 60 } } },
      callers: OWNERS_ONLY,
      run: async input => {
        const ids = [...new Set((input.sessions || []).map(String))].slice(0, 24);
        for (const id of ids) await indexNow(id);
        const have = ids.filter(id => db.prepare("SELECT 1 FROM recall_sessions WHERE id = ?").get(id));
        const out = rolloverOf(db, have, { tailChars: Math.max(0, Number(input.tail_chars) || 0), cap: Math.max(1, Math.min(60, Number(input.lines) || 30)) });
        return { ...out, indexed: have, missing: ids.filter(id => !have.includes(id)) };
      },
    });
    ctx.tool("recall.marks", {
      effect: "read",
      description: "For a rollover's reference sheet (Vyre's own): where in a thread's windows each moment falls. Give the windows (session ids) and times in ms; get, for each time, the pointer (session:seq) of the latest turn at or before it, or null. No model.",
      input: { type: "object", required: ["sessions", "at"], properties: { sessions: { ...stringArray, maxItems: 24 }, at: { type: "array", maxItems: 400, items: { type: "number" } } } },
      callers: OWNERS_ONLY,
      run: async input => {
        const ids = [...new Set((input.sessions || []).map(String))].slice(0, 24);
        for (const id of ids) await indexNow(id);
        return { marks: marksOf(db, ids.filter(id => db.prepare("SELECT 1 FROM recall_sessions WHERE id = ?").get(id)), (input.at || []).map(Number).slice(0, 400)) };
      },
    });
    ctx.tool("recall.transcript", {
      effect: "read",
      description: "A rich read of one session for a person's own screen: what was said, thinking, every tool call with its input and output, and each turn's time and tokens. Takes a session id or an unambiguous prefix of one. Without from, the last blocks; before pages back.",
      input: { type: "object", required: ["session"], properties: {
        session: { type: "string" }, from: { type: "integer" }, limit: { type: "integer" }, before: { type: "integer" }, machines,
        source: { type: "string", enum: ["box", "mac"] } } },
      // A person's surfaces only: tool output can hold anything the session read, so it is never
      // handed to Claude over MCP or to an agent. callers is an allowlist, so every "mcp" is out.
      callers: ["cli", "local", "deck", "capsule", "module"],
      run: async (input, meta = {}) => { const caller = meta.caller;
        const { machines: _, source, ...q } = input;
        if (!(await wantsMacs(ctx, input, caller, meta))) return transcript(q);
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
        if (!e) throw Object.assign(new Error(`no session ${input.session} (recall.sessions lists them)`), { code: "not_found" });
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
      effect: "write",
      description: "Follow one session live: each completed turn arrives as a session.turn event (thread = the session id) and session.state says whether a reply is under way. from is a turn id to replay after first; without it, only new turns. Call again with the same watch id to renew it: a watch nobody renews ends after 3 minutes, and one whose session is quiet for 30 minutes ends too.",
      input: { type: "object", required: ["session"], properties: {
        session: { type: "string" }, from: { type: "string" }, watch: { type: "string" } } },
      callers: own,
      run: async input => watches.watch(input),
    });
    ctx.tool("recall.unwatch", {
      effect: "write",
      description: "Stop following a session (a watch id from recall.watch).",
      input: { type: "object", required: ["watch"], properties: { watch: { type: "string" } } },
      callers: own,
      run: async input => watches.unwatch(input),
    });
    ctx.tool("recall.sessions", {
      effect: "read",
      description: "Indexed sessions, newest first, optionally only those in or under a folder, since a time, started by a person, or with the given ids.",
      input: { type: "object", properties: {
        cwd: { type: "string" }, since: { type: "number" }, human: { type: "boolean" }, limit: { type: "integer" }, ids: stringArray, machines, ...agentField } },
      callers: READERS,
      run: async (input, meta = {}) => { const caller = meta.caller;
        const { machines: _, agent, ...q } = input;
        const r = await reach(agent, caller, meta);
        if (!r.all && q.cwd && !inFolders(q.cwd, r.folders)) throw denied(`${r.agent} is not granted ${q.cwd}`);
        // ids can name any session (the box's cross-project resolve for a Mac's picked ones): a
        // scoped agent's own list still narrows to what it is granted, never all of them.
        const scoped = rows => r.all ? rows : rows.filter(row => inFolders(row.cwd, r.folders));
        if (!(await wantsMacs(ctx, input, caller, meta))) return scoped(sessions(db, q));
        // On the box, for the person: the Macs' sessions too, newest first, capped at the limit.
        const [own, answers] = await Promise.all([sessions(db, q), askMacs(ctx, "recall.sessions", q)]);
        return mergeRows(ctx, scoped(own), answers, { rows: scoped, compare: (a, b) => (b.ended || 0) - (a.ended || 0), limit: Math.max(1, Math.min(1000, q.limit || 50)) });
      },
    });
    ctx.tool("recall.forget", {
      effect: "write",
      internal: true,
      description: "Forget these sessions outright: turns, vectors and rows. For memory, when a device's synced sessions are revoked; the files are already gone.",
      callers: ["module"],
      input: { type: "object", required: ["sessions"], properties: { sessions: stringArray } },
      run: async ({ sessions: ids }) => {
        const n = indexer.forget(ids.map(String)); dense.invalidate();
        // The Space's memory forgets what it kept of them too (a refusal or no work module is fine: there is nothing to forget).
        for (const id of ids.map(String)) { try { await ctx.call("work.know.forget", { session: id }); } catch { /* nothing kept */ } }
        return { forgot: n };
      },
    });
    ctx.tool("recall.sealscan", {
      description: "One look at what Recall's index already holds that has the shape of a sealed value (an SSN, a card or bank number, an IBAN and the rest): which table and column, how many rows and which classes, and how many search vectors were made from them, never a value. It changes nothing. New turns are scrubbed on the way in.",
      callers: ["cli", "local", "deck", "capsule"],
      input: { type: "object", properties: {} },
      run: async () => ({ ...scanIndex(db), log: scrubLog(db), note: "Counts only. Nothing was changed. A value that is sealed in a record today can only be matched by the sealing process's ledger, which Recall does not hold." }),
    });
    ctx.tool("recall.sealscrub", {
      description: "Rewrite what Recall's index already holds that has the shape of a sealed value: each matched span becomes a placeholder, nothing else in a turn, title or name changes, and the search vectors made from a changed turn are dropped and made again. Only the person, with presence. One log row (counts and classes) is kept.",
      callers: ["cli", "local", "deck", "capsule"],
      presence: { summary: () => "Replace values shaped like an SSN, card or bank number in your searchable history with placeholders" },
      input: { type: "object", properties: {} },
      run: async () => {
        const r = scrubIndex(db);
        if (r.turns) dense.invalidate();
        ctx.log(`recall: sealed-class scrub rewrote ${r.turns} turns, ${r.titles} titles, ${r.names} names; dropped ${r.vectors} vectors`);
        ctx.events.emit("recall.scrubbed", { turns: r.turns, titles: r.titles, names: r.names, vectors: r.vectors, classes: r.classes });
        return r;
      },
    });
    ctx.tool("recall.index", {
      effect: "write",
      description: "Index new and changed transcripts now. Returns what the pass did.",
      callers: own,
      input: { type: "object", properties: {} },
      run: async () => pass(),
    });
    ctx.tool("recall.status", {
      effect: "read",
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
      effect: "write",
      description: "Install the search model now (the library and its weights, once) and load it, so search ranks by meaning. Resolves when it is ready or has failed, and says which.",
      callers: ["cli", "local", "deck", "capsule"],
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
      effect: "read",
      description: "Measure search against a labelled set: MRR and recall for keyword, dense and hybrid, and whether nonsense clears the dense floor.",
      callers: own,
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
        chain = chain.then(() => (stopped ? null : indexer.session(folders(), id))).catch(err => ctx.log(`could not index ${id}: ${err.message}`));
      }, SOON_MS));
    };
    /** Index one session now, on the pass chain, and wait for it. @param {string} id */
    const indexNow = id => {
      chain = chain.then(() => (stopped ? null : indexer.session(folders(), id))).catch(err => ctx.log(`could not index ${id}: ${err.message}`));
      return chain;
    };
    // A thread another provider runs has no Claude Code Stop hook: when one of its turns finishes, its mirror (core/switchboard mirror()) is indexed, from the mirror folder alone.
    const indexMirror = (/** @type {any} */ e) => {
      const thread = e && e.thread;
      if (stopped || !mirrorRoot || typeof thread !== "string" || !thread) return;
      const id = `m-${thread}`;
      clearTimeout(soon.get(id));
      soon.set(id, setTimeout(() => {
        soon.delete(id);
        chain = chain.then(() => (stopped ? null : indexer.session([mirrorRoot], id))).catch(err => ctx.log(`could not index ${id}: ${err.message}`));
      }, SOON_MS));
    };
    const offs = [ctx.events.on("thread.finished", indexMirror), ctx.events.on("turn.completed", indexSoon), ctx.events.on("thread.started", indexSoon),
      ctx.events.on("turn.completed", (/** @type {any} */ e) => { const id = e?.payload?.session; if (typeof id === "string" && id) watches.stopped(id); }),
      // A deleted session is erased from the Space's memory too (work.know.forget); Recall's own rows follow the transcript file, which a provider keeps.
      ctx.events.on("thread.deleted", (/** @type {any} */ e) => { const id = e?.payload?.thread; if (typeof id === "string" && id) Promise.resolve(ctx.call("work.know.forget", { session: id })).catch(() => {}); })];

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
        // (This used to call `within`, the folder helper above, with a promise: it threw a TypeError, stop() ended there, the embedder's process was never closed and the daemon, and any
        // test that started one, never exited.) The embedder is closed whatever the wait does.
        try { if (vec.loading) await within(vec.loading.catch(() => null), 5000); }
        finally { const e = /** @type {any} */ (vec.embedder); if (e && typeof e.close === "function") e.close(); }
      },
    };
  },
};
