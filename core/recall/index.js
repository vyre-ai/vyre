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
//   maxChunks  the dense index's hard cap in chunk vectors (default 50,000, ~78MB); past it the
//              oldest sessions drop out of ranking by meaning and fall back to full-text search

import os from "node:os";
import path from "node:path";
import { MIGRATIONS } from "./schema.js";
import { Indexer } from "./indexer.js";
import { search, thread, sessions } from "./search.js";
import { evaluate } from "./eval.js";
import { load as loadModel, cached, installed, DOWNLOAD_MB } from "./embed.js";
import { Dense } from "./dense.js";

/** @type {import("./embed.js").Embedder | null} */
let injected = null;

/**
 * Use this embedder instead of loading the model. For tests: they must never download weights,
 * and must pass whether or not the optional package is installed.
 * @param {import("./embed.js").Embedder | null} e
 */
export function useEmbedder(e) { injected = e; }

/**
 * The transcript folders to read. Under `node --test` the real ~/.claude is never read, whatever
 * the config says: a test that starts vyred with default settings would otherwise index every
 * real conversation on the machine into its temp home. Tests point `transcripts` at fixtures.
 * @param {string[]} folders
 */
export function readable(folders) {
  if (!process.env.NODE_TEST_CONTEXT) return folders;
  const real = path.join(os.homedir(), ".claude") + path.sep;
  return folders.filter(f => !(path.resolve(f) + path.sep).startsWith(real));
}

export default {
  /** @param {any} ctx */
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const opts = ctx.config.recall || {};
    const every = opts.every ?? 5;
    const folders = readable(ctx.config.transcripts || []);
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
          const s = await indexer.run(folders, { stopped: isStopped });
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
        vec.loading = (injected ? Promise.resolve({ embedder: injected })
          : loadModel({ cacheDir: models, runtime, download: opts.download !== false, npm: opts.npm }))
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
            const e = await embedder();
            if (!e || stopped) break;
            const r = await indexer.vectorize(e, { stopped: isStopped });
            if (r.turns) ctx.log(`embedded ${r.turns} turns into ${r.chunks} vectors in ${r.ms}ms`);
          } while (vec.again && !stopped);
          // Build the dense index now, in the background, so the first search does not pay for it.
          if (!stopped && !dense.stats() && db.prepare("SELECT 1 FROM recall_vectors LIMIT 1").get()) await dense.build();
        } catch (e) { vec.why = `embedding failed: ${/** @type {Error} */ (e).message}`; ctx.log(vec.why); }
        finally { vec.busy = false; }
      })();
    };

    const stringArray = { type: "array", items: { type: "string" } };
    ctx.tool("recall.search", {
      description: "Search every Claude Code session on this machine for turns about something. Returns the best turns with their session's name, title and folder.",
      input: { type: "object", required: ["q"], properties: {
        q: { type: "string" }, limit: { type: "integer" }, project_cwds: stringArray,
        role: { type: "string", enum: ["user", "assistant"] }, hybrid: { type: "boolean" },
        per_session: { type: "integer" },
      } },
      run: async input => {
        // No model load for a corpus with no vectors yet: that would cost seconds and change nothing.
        const any = db.prepare("SELECT 1 FROM recall_vectors LIMIT 1").get();
        const e = input.hybrid === false || !any ? null : await embedder();
        return (await search(db, input, e, dense)).hits;
      },
    });
    ctx.tool("recall.thread", {
      description: "One session and its turns, in order. Takes a session id or an unambiguous prefix of one.",
      input: { type: "object", required: ["session"], properties: {
        session: { type: "string" }, from: { type: "integer" }, limit: { type: "integer" } } },
      run: async input => thread(db, input),
    });
    ctx.tool("recall.sessions", {
      description: "Indexed sessions, newest first, optionally only those in or under a folder, since a time, or started by a person.",
      input: { type: "object", properties: {
        cwd: { type: "string" }, since: { type: "number" }, human: { type: "boolean" }, limit: { type: "integer" } } },
      run: async input => sessions(db, input),
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
          folders, every, indexing: running, last: last ? JSON.parse(String(last.v)) : null, error: lastError,
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
        chain = chain.then(() => { if (!stopped) indexer.session(folders, id); }).catch(err => ctx.log(`could not index ${id}: ${err.message}`));
      }, SOON_MS));
    };
    const offs = [ctx.events.on("turn.completed", indexSoon), ctx.events.on("thread.started", indexSoon)];

    // After start returns, so vyred's startup never waits on a pass.
    const first = setTimeout(() => { pass().catch(() => {}); }, 0);
    const timer = every > 0 ? setInterval(() => { if (!running) pass().catch(() => {}); }, every * 60_000) : null;
    timer?.unref();

    return {
      async stop() {
        stopped = true;
        clearTimeout(first);
        for (const off of offs) if (typeof off === "function") off();
        for (const t of soon.values()) clearTimeout(t);
        if (timer) clearInterval(timer);
        await chain;
        await vec.done;
        // A model load in flight writes into the home; let it settle before the home can go.
        if (vec.loading) await Promise.race([vec.loading.catch(() => null), new Promise(r => setTimeout(r, 5000).unref())]);
      },
    };
  },
};
